// owner-watch：监听宿主自身相关文件的变更，并在变更后向所有者发送通知。
//
// 监听范围（有意收窄）
//   resources/app/skills/    技能
//   resources/app/plugins/   插件
//   resources/app/src/       核心代码
//   data/config.json         配置
//   其余路径（会话存档、日志、下载目录、其他用户目录）均不监听。
//
// 采用轮询而非 fs.watch 的原因
//   fs.watch 在 Windows 上对递归监听的语义不一致，子目录新增时事件可能丢失；
//   插件热重载与目录重建同样会丢失事件。本插件只需 mtime 与 size 两项信息，
//   单次扫描 200 余个文件的耗时在毫秒级，因此以固定间隔轮询换取确定性：
//   允许最长 15 秒延迟，但不接受漏报。
//
// 抑制重复通知的三层机制
//   1. 去抖：停止变更 debounceSec 秒后汇总为一条
//   2. 冷却：两次通知间隔不小于 cooldownMin 分钟，期间的变更进入待发队列
//   3. 忽略规则：编辑器临时文件不计入变更
//   首次启动仅建立基线，不发送通知。
//
// 开销
//   全部为本地文件属性比较，不产生 token 消耗。通知文案由本地模板生成，
//   不经过模型——模型只能看到文件路径，无法得知具体改动内容。


import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'owner-watch';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');          // resources/app
const INSTALL_ROOT = path.resolve(APP_ROOT, '..', '..');  // QQ Agent 根目录

const SCAN_INTERVAL_MS = 15000;   // 15 秒扫一次
const MAX_LIST = 8;               // 单条通知最多列出的条目数
const MAX_TEXT = 900;             // 单条通知字符上限（QQ 端存在长度限制）
const IDLE_WRITE_MS = 60000;      // 无变更时状态文件的最大写入间隔
// 基线结构版本。监听范围变更时递增，用于触发基线静默重建。
// 若不递增，从"仅监听 skills/plugins"升级到"同时监听 src/"时，
// 首次比对会把 src/ 下全部文件判为新增并批量上报。
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
 * 记录一条运行流水，仅在发生变更或产生决策时调用。
 *
 * 不依赖 api.log 的原因：扩展的 console 输出不会写入宿主日志文件，
 * 出现"检测到变更但未发送"一类问题时无法定位判定过程，因此单独留痕。
 */
function dbg(msg) {
  try {
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    const file = LOG_FILE();
    // 日志轮转：连续高频变更时文件会快速增长，超过 200KB 转存为 .1
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

/* 通知对象解析：插件设置优先，其次取 owner-identity 插件，均为空时返回空串。 */
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

/** 异步解析通知对象 QQ 号；同时完成宿主 config 模块的懒加载。 */
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
      // pending 字段必须一并读取：它保存"已检测到但尚未发送"的变更。
      // 遗漏该字段会导致变更被记录后无法在下一轮取回，通知永不触发。
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
  } catch { /* 首次运行或文件损坏，均按空状态处理 */ }
  return { version: 1, schema: 0, at: 0, files: null, lastNotifyAt: 0, pending: { added: [], removed: [], changed: [] }, failCount: 0 };
}

let lastWriteAt = 0;

function saveState(st) {
  try {
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    // 原子写入：先写 .tmp 再 rename。直接覆盖时若进程在写入过程中终止，
    // 会残留不完整 JSON，导致下次解析失败、files 为 null、基线被整体重建，
    // 期间的变更全部丢失。
    const tmp = `${STATE_FILE()}.tmp`;
    // 统一写入当前基线版本号，避免个别分支遗漏 schema 导致反复判定为结构升级
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
  // 默认开启。仅当显式设为 false 时关闭：若写成 !settings().skipIgnored，
  // 在取不到配置的环境（自测、setup 之前）会得到相反结果。
  if (settings().skipIgnored === false) return false;
  return IGNORE_RE.test(rel);
}

/** 递归扫描目录，返回 { 相对路径: "mtime:size" }。 */
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

/** config.json 使用内容哈希：宿主补写默认值时 size 可能不变而 mtime 变化，按 mtime 判定会误报。 */
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
  // src/ 为核心代码，变更后热重载不生效，必须重启进程。
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
 * 判断基线的覆盖范围是否与当前监听配置一致。
 *
 * 该判定比 schema 版本号更直接：基线中缺少任一应监听的根目录（例如旧版本
 * 未包含 src/），即视为过期并静默重建；否则这些目录下的文件会被判定为新增。
 *
 * @param {object} files  旧基线
 * @param {object} cfg    插件设置
 * @param {object|null} fresh 本轮扫描结果。传入时仅当新扫描中确实存在该目录才判为缺失，
 *                            避免目录本身为空时每轮都触发重建
 * @returns {string[]} 缺失的前缀列表；空数组表示覆盖完整
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
    // 传入 fresh 时：新扫描中同样不存在该目录，说明目录本身为空，不计为缺失
    return freshKeys ? freshKeys.some((k) => k.startsWith(p)) : true;
  });
  if (cfg.watchConfig !== false && !('config.json' in (files || {}))) {
    if (!freshKeys || ('config.json' in (fresh || {}))) missing.push('config.json');
  }
  return missing;
}

/**
 * 合并两轮差异（待发队列 + 本轮扫描结果）。
 * 同一文件先新增后删除视为删除；先删除后新增视为新增；
 * 已计入新增或删除的文件不再重复计入改动。
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

/** 将文件列表按区域聚合，避免逐个列出大量文件。 */
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
 * 生成通知文本。纯函数，便于测试。
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
    // 目录内全部文件均为新增时，判定为新安装的扩展
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
    // 核心文件按文件名列出，超过 4 个时省略其余
    const head = srcFiles.slice(0, 4).join('、');
    const more = srcFiles.length > 4 ? ` 等 ${srcFiles.length} 个` : '';
    lines.push(`· 动了我身体里的东西（src/${head}${more}）`);
  }
  if (loose.includes('config.json')) {
    kinds.push('设置');
    lines.push('· 改了我的设置（config.json）');
  }
  for (const p of loose.filter((x) => x !== 'config.json')) lines.push(`· ${p}`);

  // 列表过长时截断
  const shown = lines.slice(0, MAX_LIST);
  if (lines.length > MAX_LIST) shown.push(`· …还有 ${lines.length - MAX_LIST} 项`);

  const uniqKinds = [...new Set(kinds)];

  // 询问语按变更范围区分：技能与插件由宿主自动热重载，核心代码需要重启进程。
  // 统一使用"是否重新加载"的表述并不准确——扩展重载是自动发生的，
  // 而插件本身无法重启宿主进程。
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

  // QQ 单条消息存在长度上限，超出后会被协议端截断或拒绝，此处主动截断
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

    // 首次安装或基线结构过期：仅建立基线，不发送通知。
    // 两个判据同时使用：schema 覆盖"新增了监听目录"，missingPrefixes 覆盖
    // "旧基线缺少新区域但 schema 已是新值"（该情况曾导致 50 条误报进入待发队列）。
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
    // 合并待发队列与本轮差异，避免快照推进后待发变更失去发送时机
    const merged = mergeDiff(st.pending, diff);
    const n = totalChanges(merged);
    if (!n) {
      pendingSince = 0;
      // 无变更时不必每轮写盘，限制为每分钟一次
      if (now - lastWriteAt < IDLE_WRITE_MS) return;
      saveState({ ...st, at: now, files: snap, pending: {} });
      return;
    }
    if (totalChanges(diff)) {
      dbg(`检测到 ${totalChanges(diff)} 处新改动（累计待报 ${n}）：+${diff.added.length} -${diff.removed.length} ~${diff.changed.length}；`
        + `样例 ${[...diff.added, ...diff.removed, ...diff.changed].slice(0, 3).join(', ')}`);
    }

    // 去抖：记录首次观察到变更的时间，等待 debounceSec 秒
    if (!pendingSince) pendingSince = now;
    const waitMs = num(cfg.debounceSec, 10, 0, 600) * 1000;
    if (now - pendingSince < waitMs) {
      // 尚未静默：推进快照，变更暂存至待发队列
      saveState({ ...st, at: now, files: snap, pending: merged });
      return;
    }

    // 冷却期内：变更继续暂存，不丢弃
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
        // 记录协议端返回码：调用未抛错不代表消息已送达，retcode 更具参考价值
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
      // 已送达，或未配置通知对象：清空待发队列并推进冷却时间
      saveState({ version: 1, at: now, files: snap, lastNotifyAt: now, pending: {}, failCount: 0 });
    } else {
      // 发送失败：保留待发队列，下一轮重试，避免网络波动导致通知丢失。
      // 同时设置重试上限（3 次）：协议端持续不可用时每 15 秒重试一次没有意义。
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
  // 启动后延迟 8 秒执行首次扫描：避开宿主启动阶段与其他扩展的初始化。
  // 热重载会重建定时器，延迟过长会导致变更后响应明显变慢。
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
