// 改动看守 · 只盯「和她自己相关」的文件，主人动过之后私下问一句
//
// ── 为什么是轮询而不是 fs.watch ─────────────────────────────────────
//   fs.watch 在 Windows 上递归监听目录的语义不统一（子目录新增时事件可能丢），
//   而且插件热重载、删除重建目录这些场景本来就会丢事件。这里要的东西很轻
//   （只看 mtime/size），15 秒扫一次代价可以忽略，换来的是"不会漏、不用猜"。
//   宁可晚 15 秒知道，也不要出现"明明改了却没动静"。
//
// ── 只监听什么（这是本插件的边界，别扩大）───────────────────────────
//   resources/app/skills/   她自己会的能力
//   resources/app/plugins/   她的确定性行为
//   data/config.json        她的设置（人设、模型、开关）
//   —— 只这三处。聊天记录、日志、下载的图、电脑上别的目录，一律不看。
//   所以主人改自己的项目、下东西、看视频都不会触发；只有"动了她"才会。
//
// ── 防刷屏的三道闸 ────────────────────────────────────────────────
//   1. 去抖：改动停手 debounceSec 秒后才汇总成一条（连续保存 20 次只问一次）
//   2. 冷却：两次提醒至少间隔 cooldownMin 分钟
//   3. 忽略编辑器临时文件（.swp / ~$ / .tmp / .bak），否则保存一次能触发三条
//   另外：首次启动只建立基线，不吭声 —— 否则一装上来就说"你动了一堆东西"。
//
// ── 成本 ──────────────────────────────────────────────────────────
//   纯本地比对，0 token。文案是本地模板，不叫模型（叫模型反而会编内容）。
//   她只被告知"哪个文件变了"，不知道改了哪一行 —— 提示词里也写明了不许瞎编。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'owner-watch';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');          // resources/app
const INSTALL_ROOT = path.resolve(APP_ROOT, '..', '..');  // QQ Agent 根目录

const SCAN_INTERVAL_MS = 15000;   // 15 秒扫一次
const MAX_LIST = 8;               // 一条消息最多列 8 项
const MAX_TEXT = 900;             // 单条消息上限（QQ 端有长度限制，超了会被截断）
const IDLE_WRITE_MS = 60000;      // 没变化时最多每分钟落一次盘（别每 15 秒写一次）
// 基线结构版本：改了"盯哪些目录"就要 +1，让旧基线静默重建。
// 不加这个的话，从「只盯 skills/plugins」升级到「也盯 src/」时，
// 首次对比会把 src/ 下所有文件当成"新增"，一次报几十个核心文件 —— 纯属吓人。
const STATE_SCHEMA = 2;

let api = null;
let timer = null;
let running = false;
let pendingSince = 0;             // 第一次观察到改动的时间（去抖起点）

/* ═══════════════════════════ 路径 ═══════════════════════════ */

function dataDir() {
  const explicit = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (explicit) return explicit;
  return path.join(INSTALL_ROOT, 'data');
}

const STATE_DIR = () => path.join(dataDir(), 'owner-watch');
const STATE_FILE = () => path.join(STATE_DIR(), 'state.json');
const LOG_FILE = () => path.join(STATE_DIR(), 'log.txt');

/**
 * 只在"有变化/有决定"时写一行到本地日志。
 * 为什么不只靠 api.log：插件 console 输出不进 app 的日志文件，出问题时
 * 完全看不到它内部怎么判的（这次排查就被卡在这里）。本地留痕才查得动。
 */
function dbg(msg) {
  try {
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    const file = LOG_FILE();
    // 轮转：一天最多几百行，但"有人在持续改文件"时能涨得很快，别让它无限长
    try {
      const st = fs.statSync(file);
      if (st.size > 200 * 1024) fs.renameSync(file, `${file}.1`);
    } catch { /* 文件还不存在 */ }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch { /* 留痕失败不影响主流程 */ }
}

/* ═══════════════════════════ 配置 ═══════════════════════════ */

function settings() {
  try {
    return api?.config?.() || {};
  } catch {
    return {};
  }
}

function num(v, dflt, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/* 通知谁：设置项 > 主人识别 > 空（只写日志）。 */
let _configMod = null;

async function loadConfigMod() {
  if (_configMod) return _configMod;
  try {
    _configMod = await import('../../src/config.js');
  } catch {
    _configMod = null;
  }
  return _configMod;
}

/** 异步版本的主号解析（首次 tick 会先把 config 模块加载好）。 */
async function resolveOwnerIdAsync() {
  const fromSetting = String(settings().ownerId || '').trim();
  if (/^\d{5,12}$/.test(fromSetting)) return fromSetting;
  const mod = await loadConfigMod();
  try {
    const ids = String(mod?.getConfig?.()?.skills?.['owner-identity']?.ids || '');
    const first = ids.split(/[,，\s]+/).map((x) => x.trim()).find((x) => /^\d{5,12}$/.test(x));
    if (first) return first;
  } catch { /* ignore */ }
  return '';
}

/* ═══════════════════════════ 状态 ═══════════════════════════ */

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE(), 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && j.files && typeof j.files === 'object') {
      // ⚠️ pending 必须一起读回来：它是"已经看到、还没说出口"的改动。
      //    漏掉这个字段的表现是——检测到了、也存盘了，但下一轮读出来是空的，
      //    于是永远等不到发送时机（这次就是被这个坑掉的）。
      const p = j.pending && typeof j.pending === 'object' ? j.pending : {};
      return {
        version: 1,
        schema: Number(j.schema) || 1,
        at: Number(j.at) || 0,
        files: j.files,
        lastNotifyAt: Number(j.lastNotifyAt) || 0,
        pending: {
          added: Array.isArray(p.added) ? p.added : [],
          removed: Array.isArray(p.removed) ? p.removed : [],
          changed: Array.isArray(p.changed) ? p.changed : []
        },
        failCount: Number(j.failCount) || 0
      };
    }
  } catch { /* 首次运行 / 文件坏了都当空状态 */ }
  return { version: 1, schema: 0, at: 0, files: null, lastNotifyAt: 0, pending: { added: [], removed: [], changed: [] }, failCount: 0 };
}

let lastWriteAt = 0;

function saveState(st) {
  try {
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    // 原子写：先落 .tmp 再 rename。直接覆盖时如果进程正好在这几百字节里被杀，
    // 留下半截 JSON → 下次 loadState 解析失败 → files=null → 整份基线重建，
    // 期间的变化全部静默丢失（看起来就是"她忽然不吭声了"）。
    const tmp = `${STATE_FILE()}.tmp`;
    // 一律盖成当前基线版本，避免某个分支漏写导致每轮都判"结构升级"、反复重建基线
    fs.writeFileSync(tmp, JSON.stringify({ ...st, schema: STATE_SCHEMA }), 'utf8');
    fs.renameSync(tmp, STATE_FILE());
    lastWriteAt = Date.now();
  } catch (error) {
    api?.warn?.(`[${PLUGIN_ID}] 状态写不进去：${error?.message ?? error}`);
  }
}

/* ═══════════════════════════ 扫描 ═══════════════════════════ */

const IGNORE_RE = /(^|[\\/])(node_modules|\.git)([\\/]|$)|\.(swp|swx|tmp|temp|bak|log|orig|rej|DS_Store)([-.]|$)|(^|[\\/])~\$|(^|[\\/])\.#/i;

function ignored(rel) {
  // 默认开启：只有显式设成 false 才不忽略（写成 !settings().skipIgnored 会让
  // 拿不到配置的环境（自测 / setup 前）反而全部不忽略，属于反向默认）
  if (settings().skipIgnored === false) return false;
  return IGNORE_RE.test(rel);
}

/** 递归扫一棵目录，返回 { 相对路径: "mtime:size" }。 */
function scanTree(root, prefix, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(root, e.name);
    const rel = `${prefix}/${e.name}`;
    if (ignored(rel)) continue;
    if (e.isDirectory()) {
      scanTree(abs, rel, out);
    } else if (e.isFile()) {
      try {
        const st = fs.statSync(abs);
        out[rel] = `${Math.round(st.mtimeMs)}:${st.size}`;
      } catch { /* 扫描瞬间被删掉的文件，跳过即可 */ }
    }
  }
  return out;
}

/** config.json 用内容哈希：应用自己补默认值时 size 可能不变，mtime 却变了。 */
function configSignature() {
  const file = path.join(dataDir(), 'config.json');
  try {
    const buf = fs.readFileSync(file);
    return `sha1:${crypto.createHash('sha1').update(buf).digest('hex')}`;
  } catch {
    return null;
  }
}

function snapshot() {
  const cfg = settings();
  const out = {};
  if (cfg.watchSkills !== false) scanTree(path.join(APP_ROOT, 'skills'), 'skills', out);
  if (cfg.watchPlugins !== false) scanTree(path.join(APP_ROOT, 'plugins'), 'plugins', out);
  // src/ 是她的"身体"：改这里热重载不生效，必须重启 —— 但至少得让她知道被动过了
  if (cfg.watchSrc !== false) scanTree(path.join(APP_ROOT, 'src'), 'src', out);
  if (cfg.watchConfig !== false) {
    const sig = configSignature();
    if (sig) out['config.json'] = sig;
  }
  return out;
}

/* ═══════════════════════════ 差异 ═══════════════════════════ */

/**
 * 比较两次快照。纯函数，便于自测。
 * @returns {{added: string[], removed: string[], changed: string[]}}
 */
export function diffSnapshots(prev, next) {
  const added = [];
  const removed = [];
  const changed = [];
  const a = prev || {};
  const b = next || {};
  for (const k of Object.keys(b)) {
    if (!(k in a)) added.push(k);
    else if (a[k] !== b[k]) changed.push(k);
  }
  for (const k of Object.keys(a)) {
    if (!(k in b)) removed.push(k);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

export function totalChanges(d) {
  return d.added.length + d.removed.length + d.changed.length;
}

/**
 * 基线是否覆盖了"当前配置下应该盯的所有区域"。
 * 比 schema 数字更本质：只要基线里缺某个应盯的根目录（比如老版本没有 src/），
 * 就说明它是旧的，必须静默重建 —— 否则那些文件会被当成"新增"一次性报出来。
 *
 * @param {object} files  旧基线
 * @param {object} cfg    插件设置
 * @param {object|null} fresh 本轮新扫描结果；传了就要求"新扫描里确实有这块"才算缺失，
 *                            否则目录本来就空时会每轮都判缺失、无限重建基线
 * @returns {string[]} 缺失的前缀（空数组 = 覆盖齐全）
 */
export function missingPrefixes(files, cfg = {}, fresh = null) {
  const keys = Object.keys(files || {});
  const freshKeys = fresh ? Object.keys(fresh) : null;
  const want = [];
  if (cfg.watchSkills !== false) want.push('skills/');
  if (cfg.watchPlugins !== false) want.push('plugins/');
  if (cfg.watchSrc !== false) want.push('src/');
  const missing = want.filter((p) => {
    if (keys.some((k) => k.startsWith(p))) return false;
    // 有 fresh 时：新扫描里也没有 → 这块本来就是空的，不算缺失
    return freshKeys ? freshKeys.some((k) => k.startsWith(p)) : true;
  });
  if (cfg.watchConfig !== false && !('config.json' in (files || {}))) {
    if (!freshKeys || ('config.json' in (fresh || {}))) missing.push('config.json');
  }
  return missing;
}

/**
 * 合并两次差异（上一轮攒的 + 这一轮新看到的）。
 * 同一个文件"先新增后删除"→ 净效果是删除；"先删除后新增"→ 净效果是新增；
 * 已经在新增/删除里的不再算"改动"，免得文案里同一个文件出现两次。
 */
export function mergeDiff(prev, next) {
  const p = prev || {};
  const n = next || {};
  const added = new Set(p.added || []);
  const removed = new Set(p.removed || []);
  const changed = new Set(p.changed || []);
  for (const f of n.added || []) { added.add(f); removed.delete(f); changed.delete(f); }
  for (const f of n.removed || []) { removed.add(f); added.delete(f); changed.delete(f); }
  for (const f of n.changed || []) {
    if (added.has(f) || removed.has(f)) continue;
    changed.add(f);
  }
  return { added: [...added].sort(), removed: [...removed].sort(), changed: [...changed].sort() };
}

/** 把一堆文件聚合成"这一片区域变了"，避免列出 40 个文件。 */
function summarizePaths(diff) {
  const skillDirs = new Set();
  const pluginDirs = new Set();
  const srcFiles = new Set();
  const loose = [];
  for (const p of diff.added) collect(p, skillDirs, pluginDirs, srcFiles, loose);
  for (const p of diff.removed) collect(p, skillDirs, pluginDirs, srcFiles, loose);
  for (const p of diff.changed) collect(p, skillDirs, pluginDirs, srcFiles, loose);
  return {
    skillDirs: [...skillDirs].sort(),
    pluginDirs: [...pluginDirs].sort(),
    srcFiles: [...srcFiles].sort(),
    loose
  };
}

function collect(p, skills, plugins, srcs, loose) {
  const m = /^skills\/([^/]+)\//.exec(p);
  if (m) { skills.add(m[1]); return; }
  const n = /^plugins\/([^/]+)\//.exec(p);
  if (n) { plugins.add(n[1]); return; }
  const s = /^src\/(.+)$/.exec(p);
  if (s) { srcs.add(s[1]); return; }
  loose.push(p);
}

/**
 * 生成要发出去的话。纯函数，便于自测。
 * @param {object} diff   diffSnapshots 的结果
 * @param {object} cfg    插件设置
 * @returns {{text: string, kinds: string[], count: number}}
 */
export function buildMessage(diff, cfg = {}) {
  const count = totalChanges(diff);
  if (!count) return { text: '', kinds: [], count: 0 };
  const { skillDirs, pluginDirs, srcFiles, loose } = summarizePaths(diff);

  const lines = [];
  const kinds = [];
  const addedSet = new Set(diff.added);
  const removedSet = new Set(diff.removed);

  const isNewDir = (dir, prefix, all) => {
    // 目录里所有文件都是新增的 → 当成"新装了一个扩展"
    const files = all.filter((p) => p.startsWith(`${prefix}/${dir}/`));
    return files.length > 0 && files.every((p) => addedSet.has(p));
  };
  const isGoneDir = (dir, prefix, all) => {
    const files = all.filter((p) => p.startsWith(`${prefix}/${dir}/`));
    return files.length > 0 && files.every((p) => removedSet.has(p));
  };
  const allPaths = [...diff.added, ...diff.removed, ...diff.changed];

  for (const d of skillDirs) {
    kinds.push('技能');
    if (isNewDir(d, 'skills', allPaths)) lines.push(`· 多了个技能：${d}`);
    else if (isGoneDir(d, 'skills', allPaths)) lines.push(`· 删了个技能：${d}`);
    else lines.push(`· 改动了技能：${d}`);
  }
  for (const d of pluginDirs) {
    kinds.push('插件');
    if (isNewDir(d, 'plugins', allPaths)) lines.push(`· 多了个插件：${d}`);
    else if (isGoneDir(d, 'plugins', allPaths)) lines.push(`· 删了个插件：${d}`);
    else lines.push(`· 改动了插件：${d}`);
  }
  if (srcFiles.length) {
    kinds.push('核心');
    // 核心文件按名字列，全列太长就收成前 4 个 + 余量
    const head = srcFiles.slice(0, 4).join('、');
    const more = srcFiles.length > 4 ? ` 等 ${srcFiles.length} 个` : '';
    lines.push(`· 动了我身体里的东西（src/${head}${more}）`);
  }
  if (loose.includes('config.json')) {
    kinds.push('设置');
    lines.push('· 改了我的设置（config.json）');
  }
  for (const p of loose.filter((x) => x !== 'config.json')) lines.push(`· ${p}`);

  // 太多就收着点，别一条消息糊满屏
  const shown = lines.slice(0, MAX_LIST);
  if (lines.length > MAX_LIST) shown.push(`· …还有 ${lines.length - MAX_LIST} 项`);

  const uniqKinds = [...new Set(kinds)];

  // 询问要分情况说真话：她能自己热重载技能/插件，但改不了自己的核心代码。
  // 原来统一写"要我重新加载一下吗"是空话 —— 她并不能自己重启，
  // 而技能热重载本来就会自动发生，问了等于没问。
  let ask;
  if (uniqKinds.includes('核心')) {
    ask = '这部分热重载管不到，得你重启我一次才算数。别的（技能/插件）我自己已经重新加载了。';
  } else if (uniqKinds.includes('技能') || uniqKinds.includes('插件')) {
    ask = '技能和插件我这边会自动重新加载，不用你动手；想让我用新的，喊我一声就行。';
  } else {
    ask = '设置我记住了。要是改的是模型或超时这类，得重启我才吃进去。';
  }

  const tpl = String(cfg.notifyText || '').trim()
    || '你刚才是不是动了我这边的东西？\n{changes}\n{ask}';
  let text = tpl
    .replace(/\{changes\}/g, shown.join('\n'))
    .replace(/\{count\}/g, String(count))
    .replace(/\{kinds\}/g, uniqKinds.join('、'))
    .replace(/\{ask\}/g, ask)
    .replace(/\\n/g, '\n');

  // QQ 单条消息有长度上限，超出会被协议端截断甚至拒绝；这里主动收口
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT - 12)}…（太长，收着说了）`;

  return { text, kinds: uniqKinds, count };
}

/* ═══════════════════════════ 发消息 ═══════════════════════════ */

async function sendPrivate(userId, text) {
  const mod = await loadConfigMod();
  if (!mod) throw new Error('拿不到核心配置模块');
  const { OneBotClient } = await import('../../src/onebot.js');
  const s = mod.getConfig()?.snowluma || {};
  const client = new OneBotClient({
    httpUrl: s.httpUrl,
    accessToken: s.accessToken,
    httpToken: s.httpAccessToken
  });
  return client.call('send_private_msg', { user_id: Number(userId), message: String(text) }, 20000);
}

/* ═══════════════════════════ 主循环 ═══════════════════════════ */

async function tick() {
  if (running) return;
  running = true;
  try {
    const cfg = settings();
    if (cfg.enabled === false) return;

    const st = loadState();
    const now = Date.now();
    const snap = snapshot();

    // 首次安装 / 基线结构过时：只建基线，不吭声
    // 两种判据都要：schema 防"以后又加监听目录"，missingPrefixes 防"老基线缺新区域却已写上新 schema"
    // （后者真实发生过：src/ 刚加进来时 files 已被推进，schema 却已经是新值，于是 50 个假新增留在待报队列里）
    const missing = st.files ? missingPrefixes(st.files, cfg, snap) : ['(无基线)'];
    if (!st.files || st.schema !== STATE_SCHEMA || missing.length) {
      saveState({
        version: 1, schema: STATE_SCHEMA, at: now, files: snap,
        lastNotifyAt: st.lastNotifyAt || 0, pending: {}, failCount: 0
      });
      dbg(st.files
        ? `基线结构升级（schema ${st.schema} → ${STATE_SCHEMA}，缺 ${missing.join(',')}），静默重建：${Object.keys(snap).length} 个文件`
        : `基线建立：${Object.keys(snap).length} 个文件`);
      api?.log?.(`[${PLUGIN_ID}] 基线已建立：${Object.keys(snap).length} 个文件在看着`);
      return;
    }

    const diff = diffSnapshots(st.files, snap);
    // 把上一轮"还没说出口"的改动一起算 —— 否则快照一推进，pending 就永远等不到发送时机
    const merged = mergeDiff(st.pending, diff);
    const n = totalChanges(merged);
    if (!n) {
      pendingSince = 0;
      // 没变化时不必每 15 秒写一次盘（一天 5000+ 次无意义写入），一分钟落一次就够
      if (now - lastWriteAt < IDLE_WRITE_MS) return;
      saveState({ ...st, at: now, files: snap, pending: {} });
      return;
    }
    if (totalChanges(diff)) {
      dbg(`检测到 ${totalChanges(diff)} 处新改动（累计待报 ${n}）：+${diff.added.length} -${diff.removed.length} ~${diff.changed.length}；`
        + `样例 ${[...diff.added, ...diff.removed, ...diff.changed].slice(0, 3).join(', ')}`);
    }

    // 去抖：先记住"什么时候开始动的"，等它停手 debounceSec 秒再说话
    if (!pendingSince) pendingSince = now;
    const waitMs = num(cfg.debounceSec, 10, 0, 600) * 1000;
    if (now - pendingSince < waitMs) {
      // 还没停手：快照照常推进，改动先攒着，最后一次性说
      saveState({ ...st, at: now, files: snap, pending: merged });
      return;
    }

    // 冷却：太频繁就继续攒着，下一轮再说（不丢）
    const cooldownMs = num(cfg.cooldownMin, 15, 0, 1440) * 60000;
    if (st.lastNotifyAt && now - st.lastNotifyAt < cooldownMs) {
      saveState({ ...st, at: now, files: snap, pending: merged });
      pendingSince = 0;
      dbg(`冷却中（距上次 ${Math.round((now - st.lastNotifyAt) / 60000)} 分钟），先攒着 ${n} 项`);
      return;
    }

    const { text, kinds, count } = buildMessage(merged, cfg);
    const owner = await resolveOwnerIdAsync().catch(() => '');
    let delivered = false;

    if (!owner) {
      dbg(`没配主人 QQ 号，只记日志：${text.replace(/\n/g, ' | ')}`);
      api?.warn?.(`[${PLUGIN_ID}] 检测到 ${count} 处改动，但没配主人 QQ 号，只记日志：${text.replace(/\n/g, ' | ')}`);
    } else {
      try {
        const resp = await sendPrivate(owner, text);
        // 把协议端返回码也留痕：call 不抛错不等于送达，retcode 才说明问题
        const code = resp?.retcode ?? resp?.status ?? resp?.data?.message_id ?? 'ok';
        dbg(`已私聊 ${owner}：${kinds.join('、')} 共 ${count} 个文件（retcode=${code}）`);
        api?.log?.(`[${PLUGIN_ID}] 已私聊提醒主人：${kinds.join('、')} 共 ${count} 个文件`);
        delivered = true;
      } catch (error) {
        dbg(`私聊失败（第 ${(st.failCount || 0) + 1} 次）：${error?.message ?? error}`);
        api?.warn?.(`[${PLUGIN_ID}] 私聊提醒失败：${error?.message ?? error}`);
      }
    }

    pendingSince = 0;
    if (delivered || !owner) {
      // 送达了（或者本来就没地方送、只记日志）→ 清空待报、推进冷却
      saveState({ version: 1, at: now, files: snap, lastNotifyAt: now, pending: {}, failCount: 0 });
    } else {
      // 没送出去：改动**留着**，下轮重试；别让一次网络抖动把提醒吞掉。
      // 但也不能无限重试（协议端挂了会每 15 秒撞一次），超过 3 次就放弃并留痕。
      const fails = (st.failCount || 0) + 1;
      if (fails >= 3) {
        dbg(`私聊连续失败 ${fails} 次，先放弃这批改动（${count} 项），不再重试`);
        saveState({ version: 1, at: now, files: snap, lastNotifyAt: st.lastNotifyAt || 0, pending: {}, failCount: 0 });
      } else {
        saveState({ version: 1, at: now, files: snap, lastNotifyAt: st.lastNotifyAt || 0, pending: merged, failCount: fails });
      }
    }
  } catch (error) {
    api?.warn?.(`[${PLUGIN_ID}] 本轮扫描出错（已跳过，不影响下次）：${error?.message ?? error}`);
  } finally {
    running = false;
  }
}

/* ═══════════════════════════ 生命周期 ═══════════════════════════ */

export async function setup(skillApi) {
  api = skillApi;
  await loadConfigMod();
  const cfg = settings();
  const areas = [
    cfg.watchSkills !== false ? 'skills/' : '',
    cfg.watchPlugins !== false ? 'plugins/' : '',
    cfg.watchSrc !== false ? 'src/' : '',
    cfg.watchConfig !== false ? 'config.json' : ''
  ].filter(Boolean).join(' + ');
  api?.log?.(`[${PLUGIN_ID}] 已挂载：盯着 ${areas}；去抖 ${num(cfg.debounceSec, 10, 0, 600)} 秒、`
    + `冷却 ${num(cfg.cooldownMin, 15, 0, 1440)} 分钟；状态 ${STATE_FILE()}`);
}

export function available() { return { ok: true }; }

export function activate() {
  if (timer) return;
  if (settings().enabled === false) return;
  // 启动后先等 8 秒：别和别的插件抢开机那几秒，也避开配置刚被写入的抖动。
  // 不用等太久 —— 热重载会重建定时器，等 20 秒的话改完要快一分钟才有反应。
  timer = setTimeout(function loop() {
    tick().catch(() => { /* tick 内部已兜住 */ });
    timer = setTimeout(loop, SCAN_INTERVAL_MS);
    timer.unref?.();
  }, 8000);
  timer.unref?.();
}

export function deactivate() {
  if (timer) { clearTimeout(timer); timer = null; }
  pendingSince = 0;
}

export function dispose() { deactivate(); }

export const providers = {
  'owner-watch.status': () => {
    const cfg = settings();
    const st = loadState();
    return {
      enabled: cfg.enabled !== false,
      watching: {
        skills: cfg.watchSkills !== false,
        plugins: cfg.watchPlugins !== false,
        src: cfg.watchSrc !== false,
        config: cfg.watchConfig !== false
      },
      files: st.files ? Object.keys(st.files).length : 0,
      baselineAt: st.at || 0,
      lastNotifyAt: st.lastNotifyAt || 0,
      pending: totalChanges(st.pending || { added: [], removed: [], changed: [] }),
      failCount: st.failCount || 0,
      debounceSec: num(cfg.debounceSec, 10, 0, 600),
      cooldownMin: num(cfg.cooldownMin, 15, 0, 1440)
    };
  }
};

/** 自测用：不启动定时器，手动跑一轮。 */
export const internals = { tick, snapshot, loadState, saveState, STATE_FILE, LOG_FILE, diffSnapshots, mergeDiff, buildMessage };
