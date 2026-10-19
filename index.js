// owner-watch：监听宿主自身文件的变更，并在变更后通知所有者。
// owner-watch: watches files belonging to the host itself and notifies the
// owner when they change.
//
// 监听范围（有意收窄）
// Watched paths (intentionally narrow)
//   resources/app/skills/    技能 / skills
//   resources/app/plugins/   插件 / plugins
//   resources/app/src/       核心代码 / core code
//   data/config.json         配置 / configuration
//   其余路径不监听：会话存档、日志、下载目录、无关的用户目录。
//   Nothing else: session archives, logs, download folders and unrelated
//   user directories are out of scope.
//
// 采用轮询而非 fs.watch 的原因
// Why polling instead of fs.watch
//   fs.watch 在 Windows 上对递归目录的行为不一致：子目录新增时事件可能丢失，
//   插件热重载与目录重建同样会丢事件。本插件只需要 mtime 与 size，
//   单次扫描数百个文件约 15 毫秒，因此改用固定间隔轮询以换取确定性。
//   代价是最长 15 秒延迟；漏报不可接受。
//   fs.watch does not behave consistently for recursive directories on
//   Windows: events may be lost when a subdirectory is added, and plugin hot
//   reload or a directory rebuild drops events as well. This plugin only needs
//   mtime and size, and one scan over a few hundred files takes on the order
//   of 15 ms, so a fixed interval is used in exchange for determinism.
//   The cost is up to 15s of latency; missed detections are not acceptable.
//
// 抑制重复通知的三层机制
// Three layers of notification damping
//   1. 去抖：最后一次变更后静默 debounceSec 秒再汇总为一条
//      debounce - wait debounceSec after the last change, then aggregate
//   2. 冷却：两次通知间隔不小于 cooldownMin 分钟，期间的变更进入待发队列
//      cooldown - at least cooldownMin between notifications; changes during
//      the cooldown are queued, not dropped
//   3. 忽略规则：编辑器临时文件不计入变更
//      ignore rules - editor temporary files do not count as changes
//   首次运行只建立基线，不发送任何通知。
//   The first run only builds a baseline and sends nothing.
//
// 开销
// Cost
//   扫描本身是纯本地文件属性比较，不消耗 token。通知文本由模型生成
//   （见 composeNotice），可通过 useModel 关闭，且始终保留模板兜底。
//   Scanning itself is pure local file attribute comparison and consumes no
//   tokens. The notification text is composed by the model (see
//   composeNotice), can be disabled via useModel, and always keeps a
//   template fallback.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'owner-watch';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');          // resources/app
const INSTALL_ROOT = path.resolve(APP_ROOT, '..', '..');  // QQ Agent 根目录 / root

const SCAN_INTERVAL_MS = 15000;   // 扫描间隔 / scan interval
const MAX_LIST = 8;               // 单条通知最多列出的条目数 / max entries listed
const MAX_TEXT = 900;             // 通知硬上限（协议长度限制）/ hard cap for a notification
const IDLE_WRITE_MS = 60000;      // 无变更时状态文件的最大写入间隔 / max write gap when idle
const MAX_MODEL_CHARS = 160;      // 生成文本超过此长度即丢弃 / composed text longer than this is discarded
const MAX_MODEL_CHARS_HARD = 320; // 发送前的绝对上限 / absolute cap before sending
// 基线结构版本。监听范围变更时递增，用于触发基线静默重建。
// 若不递增，从"仅监听 skills/plugins"升级到"同时监听 src/"时，
// 首次比对会把 src/ 下全部文件判为新增并批量上报。
// Baseline schema version. Increment whenever the watched set changes so that
// stale baselines are rebuilt silently. Without it, upgrading from
// "skills/plugins only" to "also src/" reports every file under src/ as added.
const STATE_SCHEMA = 2;

let api = null;
let timer = null;
let running = false;
let pendingSince = 0;             // 首次观察到变更的时间 / timestamp of the first observed change

/* ─────────────────────────── 路径 / paths ─────────────────────────── */

function dataDir() {
  const explicit = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (explicit) return explicit;
  return path.join(INSTALL_ROOT, 'data');
}

const STATE_DIR = () => path.join(dataDir(), 'owner-watch');
const STATE_FILE = () => path.join(STATE_DIR(), 'state.json');
const LOG_FILE = () => path.join(STATE_DIR(), 'log.txt');

/**
 * 追加一行运行流水，仅在检测到变更或产生决策时调用。
 * Append one line to the local run log. Only called when a change is detected
 * or a decision is made.
 *
 * 不单独依赖 api.log：扩展的 console 输出不会写入宿主日志文件，
 * 出现"检测到变更但未发送"一类问题时无法回溯判定过程。
 * api.log is not sufficient on its own: extension console output is not
 * written to the host log file, so when a notification is not delivered there
 * is no way to inspect the decision path afterwards.
 */
function dbg(msg) {
  try {
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    const file = LOG_FILE();
    // 日志轮转：连续变更时文件会快速增长，超过 200KB 转存为 .1
    // Rotate: continuous changes can grow this file quickly; cap at 200 KB.
    try {
      const st = fs.statSync(file);
      if (st.size > 200 * 1024) fs.renameSync(file, `${file}.1`);
    } catch { /* 文件尚不存在 / file does not exist yet */ }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch { /* 记录失败不影响主流程 / logging failures must not affect the main flow */ }
}

/* ────────────────────────── 设置 / settings ────────────────────────── */

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

/* 通知对象解析：插件设置优先，其次取 owner-identity 插件，均为空时返回空串。
 * Notification target resolution: plugin setting first, then the owner-identity
 * extension, empty string when neither is available. */
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

/** 异步解析通知对象 QQ 号；同时完成宿主 config 模块的懒加载。
 *  Resolve the owner QQ id asynchronously; also warms up the host config module. */
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

/* ─────────────────────────── 状态 / state ─────────────────────────── */

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE(), 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && j.files && typeof j.files === 'object') {
      // pending 字段必须一并读取：它保存"已检测到但尚未发送"的变更。
      // 遗漏该字段会导致变更被记录后无法在下一轮取回，通知永不触发。
      // `pending` must be restored as well: it holds changes that were detected
      // but not yet reported. Omitting it means those changes can never be
      // retrieved again and no notification is ever sent.
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
  } catch { /* 首次运行或文件损坏，均按空状态处理 / first run or unreadable file: treat as empty state */ }
  return { version: 1, schema: 0, at: 0, files: null, lastNotifyAt: 0, pending: { added: [], removed: [], changed: [] }, failCount: 0 };
}

let lastWriteAt = 0;

function saveState(st) {
  try {
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    // 原子写入：先写 .tmp 再 rename。直接覆盖时若进程在写入过程中终止，
    // 会残留不完整 JSON，导致下次解析失败、files 为 null、基线被整体重建，
    // 期间的变更全部丢失。
    // Atomic write: write to .tmp then rename. A plain overwrite that is
    // interrupted leaves truncated JSON, which fails to parse on the next run,
    // sets files to null and rebuilds the baseline, losing all changes that
    // happened in between.
    const tmp = `${STATE_FILE()}.tmp`;
    // 统一写入当前基线版本号，避免个别分支遗漏 schema 导致反复判定为结构升级
    // Always stamp the current schema so no branch can omit it and cause the
    // baseline to be treated as outdated on every pass.
    fs.writeFileSync(tmp, JSON.stringify({ ...st, schema: STATE_SCHEMA }), 'utf8');
    fs.renameSync(tmp, STATE_FILE());
    lastWriteAt = Date.now();
  } catch (error) {
    api?.warn?.(`[${PLUGIN_ID}] state write failed: ${error?.message ?? error}`);
  }
}

/* ────────────────────────── 扫描 / scanning ────────────────────────── */

const IGNORE_RE = /(^|[\\/])(node_modules|\.git)([\\/]|$)|\.(swp|swx|tmp|temp|bak|log|orig|rej|DS_Store)([-.]|$)|(^|[\\/])~\$|(^|[\\/])\.#/i;

function ignored(rel) {
  // 默认开启。仅当显式设为 false 时关闭：若写成 !settings().skipIgnored，
  // 在取不到配置的环境（自测、setup 之前）会得到相反结果。
  // Enabled by default. It must be disabled only when explicitly set to false:
  // writing `!settings().skipIgnored` yields the opposite result in
  // environments without configuration (self-test, before setup).
  if (settings().skipIgnored === false) return false;
  return IGNORE_RE.test(rel);
}

/** 递归扫描目录，返回 { 相对路径: "mtime:size" }。
 *  Recursively scan a directory into { relativePath: "mtime:size" }. */
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
      } catch { /* 扫描瞬间被删除，跳过 / file removed between readdir and stat: skip */ }
    }
  }
  return out;
}

/** config.json 使用内容哈希：宿主补写默认值时 size 可能不变而 mtime 变化，
 *  按 mtime 判定会误报。
 *  config.json is compared by content hash: the host rewrites defaults, which
 *  can keep the size unchanged while mtime changes and cause false positives. */
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
  // src/ is core code: changes there are not applied by hot reload and require
  // a process restart.
  if (cfg.watchSrc !== false) scanTree(path.join(APP_ROOT, 'src'), 'src', out);
  if (cfg.watchConfig !== false) {
    const sig = configSignature();
    if (sig) out['config.json'] = sig;
  }
  return out;
}

/* ─────────────────────────── 差异 / diffs ─────────────────────────── */

/**
 * 比较两次快照。纯函数。
 * Compare two snapshots. Pure function.
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
 * Check whether a baseline covers every root directory the current
 * configuration watches.
 *
 * 该判定比 schema 版本号更直接：基线中缺少任一应监听的根目录（例如旧版本
 * 未包含 src/），即视为过期并静默重建；否则这些目录下的文件会被判定为新增。
 * This is a more direct test than the schema number: a baseline that lacks any
 * watched root (for example an older version without src/) is stale and must be
 * rebuilt silently, otherwise every file under that root is reported as added.
 *
 * @param {object} files  旧基线 / existing baseline
 * @param {object} cfg    插件设置 / plugin settings
 * @param {object|null} fresh 本轮扫描结果。传入时仅当新扫描中确实存在该目录才判为缺失，
 *                            避免目录本身为空时每轮都触发重建
 *                            current scan result; when provided, a root counts
 *                            as missing only if the fresh scan contains it too,
 *                            which prevents an empty directory from triggering a
 *                            rebuild on every pass
 * @returns {string[]} 缺失的前缀列表；空数组表示覆盖完整
 *                     missing prefixes; empty array means fully covered
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
    // With a fresh scan available: if it does not contain the root either, the
    // directory is simply empty and must not be treated as missing.
    return freshKeys ? freshKeys.some((k) => k.startsWith(p)) : true;
  });
  if (cfg.watchConfig !== false && !('config.json' in (files || {}))) {
    if (!freshKeys || ('config.json' in (fresh || {}))) missing.push('config.json');
  }
  return missing;
}

/**
 * 合并待发队列与本轮差异。
 * Merge the queued diff with the current one.
 *
 * 同一文件先新增后删除视为删除；先删除后新增视为新增；
 * 已计入新增或删除的文件不再重复计入改动。
 * A file added then removed counts as removed; removed then added counts as
 * added; files already classified as added or removed are not counted again as
 * modified.
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

/** 将文件列表按区域聚合，避免逐个列出大量文件。
 *  Group files by area so a large change set is not listed file by file. */
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
 * 生成模板通知。纯函数。
 * Build the template notification. Pure function.
 *
 * 在模型不可用或输出不可用时作为兜底，使用固定句式，不追求措辞变化。
 * Used as the fallback when the model is unavailable or returns unusable text.
 * @param {object} diff   diffSnapshots 的结果 / result of diffSnapshots
 * @param {object} cfg    插件设置 / plugin settings
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
    // All files in the directory are new: treat it as a newly installed extension.
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
    // List core files by name; omit the rest when there are more than four.
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
  // Truncate long lists
  const shown = lines.slice(0, MAX_LIST);
  if (lines.length > MAX_LIST) shown.push(`· …还有 ${lines.length - MAX_LIST} 项`);

  const uniqKinds = [...new Set(kinds)];

  // 询问语按变更范围区分：技能与插件由宿主自动热重载，核心代码需要重启进程。
  // 统一使用"是否重新加载"的表述并不准确——扩展重载是自动发生的，
  // 而插件本身无法重启宿主进程。
  // The closing sentence depends on the scope: skills and plugins are hot
  // reloaded by the host automatically, core code requires a process restart.
  // A generic "reload?" question is inaccurate - reload is automatic and this
  // plugin cannot restart the host process itself.
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
  // The protocol has a per-message length limit; truncate before sending.
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT - 12)}…（太长，收着说了）`;

  return { text, kinds: uniqKinds, count };
}

/* ──────────────────── 模型生成通知 / model-composed notice ──────────────────── */

/** 从宿主配置读取模型接口参数；不可用时返回 null。
 *  Read model endpoint settings from the host configuration. Null when unusable. */
async function readModelConfig() {
  const mod = await loadConfigMod();
  const cfg = mod?.getConfig?.() || {};
  const apiCfg = cfg.api || {};
  const providerId = String(apiCfg.provider || '').trim();
  const key = String(
    (providerId && cfg.dshProviderKeys ? cfg.dshProviderKeys[providerId] : '') ||
    apiCfg.apiKey || ''
  ).trim();
  const baseUrl = String(apiCfg.baseUrl || '').trim().replace(/\/+$/, '');
  const model = String(apiCfg.model || '').trim();
  if (!key || !baseUrl || !model) return null;
  return { key, baseUrl, model };
}

/** 最小化的对话补全调用；任何失败都返回 null。
 *  Minimal chat completion call. Returns null on any failure.
 *
 *  通过宿主的 api.fetch 发起请求：manifest 中已声明 web_fetch 权限，
 *  走宿主入口才能让权限声明真正生效（也便于宿主统一审计出站请求）。
 *  Uses the host-provided api.fetch: web_fetch is declared in the manifest, and
 *  going through the host entry point makes that declaration meaningful (and
 *  lets the host audit outbound requests). */
async function callModel(messages, timeoutMs) {
  const mc = await readModelConfig();
  if (!mc) return null;
  const fetchFn = typeof api?.fetch === 'function' ? api.fetch : null;
  if (!fetchFn) {
    dbg('model call skipped: host did not provide fetch (web_fetch not granted)');
    return null;
  }
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), Math.max(3000, Number(timeoutMs) || 12000));
  try {
    const res = await fetchFn(`${mc.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${mc.key}`
      },
      body: JSON.stringify({
        model: mc.model,
        messages,
        temperature: 0.95,
        max_tokens: 200
      }),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return String(data?.choices?.[0]?.message?.content || '').trim();
  } catch (error) {
    dbg(`model call failed: ${error?.message ?? error}`);
    return null;
  } finally {
    clearTimeout(killer);
  }
}

/** 清除模型常见的包装与格式。返回空串表示不可用。
 *  Strip wrappers and formatting the model tends to add. Empty string = unusable. */
export function sanitizeNotice(raw, maxChars = MAX_MODEL_CHARS) {
  let t = String(raw || '').trim();
  if (!t) return '';
  // 去掉代码块标记但保留内容：模型有时会把要说的话包在围栏里。
  // Drop code-fence markers but keep their content: the model sometimes wraps
  // the sentence it wants to say inside a fence.
  t = t.replace(/```[a-zA-Z0-9_+-]*\s*/g, '').trim();
  // 先处理应答词前缀：它可能包住后面要被去掉的引号。
  // Acknowledgement prefix first: it may wrap the quotes that are stripped next.
  t = t.replace(/^(好的|好|嗯|收到|明白)[，,。！!\s]*/u, '').trim();
  // 执行两轮以处理「"..."」这类嵌套，如「好的，"…"」。
  // Two passes handle cases such as 「"..."」 that appear after an acknowledgement.
  for (let i = 0; i < 2; i++) {
    const before = t;
    t = t.replace(/^["'“”「『]+|["'“”」』]+$/g, '').trim();
    if (t === before) break;
  }
  t = t.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 4).join('\n');
  if (!t) return '';
  if (t.length > maxChars) return '';   // 过长视为跑偏 / too long: treat as off-target
  return t;
}

/** 生成给模型看的变更摘要（只含名称，不含内容）。
 *  Human-readable change summary handed to the model. */
function buildChangeSummary(diff) {
  const { skillDirs, pluginDirs, srcFiles, loose } = summarizePaths(diff);
  const parts = [];
  if (skillDirs.length) parts.push(`技能：${skillDirs.join('、')}`);
  if (pluginDirs.length) parts.push(`插件：${pluginDirs.join('、')}`);
  if (srcFiles.length) {
    const head = srcFiles.slice(0, 6).join('、');
    const more = srcFiles.length > 6 ? ` 等 ${srcFiles.length} 个` : '';
    parts.push(`核心代码：${head}${more}`);
  }
  if (loose.includes('config.json')) parts.push('配置文件 config.json');
  const others = loose.filter((x) => x !== 'config.json');
  if (others.length) parts.push(`其他：${others.slice(0, 4).join('、')}`);
  return parts.join('\n');
}

/**
 * 生成通知文本。
 * Compose the notification text.
 *
 * 策略：让模型按角色设定现场说一句，因为固定开场白会让每条通知都像系统告警。
 * 模板保留为兜底，确保模型异常时通知本身不会丢失。
 * Strategy: let the model speak in its own voice using the configured persona,
 * because a fixed opening line makes every notification read like a system
 * alert. The template is kept as a fallback so a model failure never suppresses
 * the notification itself.
 *
 * @returns {{text, kinds, count, source}} source 为 'model' | 'template' | 'none'
 */
export async function composeNotice(diff, cfg = {}) {
  const tpl = buildMessage(diff, cfg);
  if (!tpl.count) return { ...tpl, source: 'none' };
  if (cfg.useModel === false) return { ...tpl, source: 'template' };

  const mod = await loadConfigMod();
  const hostCfg = mod?.getConfig?.() || {};
  const personaText = String(hostCfg?.persona?.roleText || '').trim();
  const botName = String(hostCfg?.persona?.botName || '').trim();

  const summary = buildChangeSummary(diff);
  const needsRestart = tpl.kinds.includes('核心');
  const hint = needsRestart
    ? '其中核心代码的改动必须重启程序才会生效，这一点要让他知道。'
    : '技能和插件会自动重新加载，不用他动手。';

  const system = [
    personaText ? `以下是你的角色设定：\n${personaText}` : '',
    botName ? `你的名字是${botName}。` : '',
    '现在是一个额外场景：你刚发现自己的文件被人改动了，要给主人发一条 QQ 私信。'
    + '直接用你自己的身份和语气说话，不要扮演助手，不要解释来龙去脉。'
  ].filter(Boolean).join('\n\n');

  const user = [
    `你注意到的改动是：`,
    summary,
    '',
    hint,
    '',
    '请给主人发一句话。要求：',
    '· 一到两句，像平时说话，短。',
    '· 不要列清单，不要用"检测到""变更""通知""系统"这类词。',
    '· 不要每句都用同样的称呼起头，也不用每次开口都叫人。',
    '· 可以带一点情绪，但不要长篇、不要说教。',
    '· 你只知道文件名，不知道具体改了什么，不要编造改动内容。',
    '· 如果你觉得没什么好说的，就随便说一句你现在的想法。',
    '只输出要发的那句话本身，不要加引号、不要加说明。'
  ].join('\n');

  const raw = await callModel(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    num(cfg.modelTimeoutMs, 12000, 3000, 60000)
  );
  const text = sanitizeNotice(raw, num(cfg.modelMaxChars, MAX_MODEL_CHARS, 40, MAX_MODEL_CHARS_HARD));
  if (!text) return { ...tpl, source: 'template' };

  dbg(`model composed ${text.length} chars (template fallback ready)`);
  return { text, kinds: tpl.kinds, count: tpl.count, source: 'model' };
}

/* ─────────────────────────── 发送 / sending ─────────────────────────── */

async function sendPrivate(userId, text) {
  const mod = await loadConfigMod();
  if (!mod) throw new Error('host config module unavailable');
  const { OneBotClient } = await import('../../src/onebot.js');
  const s = mod.getConfig()?.snowluma || {};
  const client = new OneBotClient({
    httpUrl: s.httpUrl,
    accessToken: s.accessToken,
    httpToken: s.httpAccessToken
  });
  return client.call('send_private_msg', { user_id: Number(userId), message: String(text) }, 20000);
}

/* ──────────────────────────── 主循环 / main loop ──────────────────────────── */

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
    // First run, or an outdated baseline: build the baseline and stay silent.
    // Both tests are required: schema covers "a watched root was added", while
    // missingPrefixes covers "old baseline lacks a newly watched root although
    // schema already reads as current" (that case once queued 50 false entries).
    const missing = st.files ? missingPrefixes(st.files, cfg, snap) : ['(no baseline)'];
    if (!st.files || st.schema !== STATE_SCHEMA || missing.length) {
      saveState({
        version: 1, schema: STATE_SCHEMA, at: now, files: snap,
        lastNotifyAt: st.lastNotifyAt || 0, pending: {}, failCount: 0
      });
      dbg(st.files
        ? `baseline rebuilt (schema ${st.schema} -> ${STATE_SCHEMA}, missing ${missing.join(',')}): ${Object.keys(snap).length} files`
        : `baseline created: ${Object.keys(snap).length} files`);
      api?.log?.(`[${PLUGIN_ID}] baseline ready: watching ${Object.keys(snap).length} files`);
      return;
    }

    const diff = diffSnapshots(st.files, snap);
    // 合并待发队列与本轮差异，避免快照推进后待发变更失去发送时机
    // Merge the queue with the current diff; otherwise advancing the snapshot
    // would leave queued changes without a chance to be sent.
    const merged = mergeDiff(st.pending, diff);
    const n = totalChanges(merged);
    if (!n) {
      pendingSince = 0;
      // 无变更时不必每轮写盘，限制为每分钟一次
      // Nothing changed: no need to rewrite state every pass.
      if (now - lastWriteAt < IDLE_WRITE_MS) return;
      saveState({ ...st, at: now, files: snap, pending: {} });
      return;
    }
    if (totalChanges(diff)) {
      dbg(`detected ${totalChanges(diff)} new change(s), ${n} queued: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length}; `
        + `sample ${[...diff.added, ...diff.removed, ...diff.changed].slice(0, 3).join(', ')}`);
    }

    // 去抖：每当观察到新变更就重新计时，只有停止变更 debounceSec 秒后才发送。
    // 若只记录"首次"变更时间，连续修改超过 debounceSec 秒时会在尚未停手时
    // 提前发出第一条。这里用"最近一次观察到变更"作为基准，实现真正的停手去抖。
    // Debounce: reset the timer on every newly observed change, so a notice is
    // sent only after changes stop for debounceSec seconds. Tracking only the
    // first change would fire early while edits are still ongoing.
    if (totalChanges(diff)) pendingSince = now;
    const waitMs = num(cfg.debounceSec, 10, 0, 600) * 1000;
    if (now - pendingSince < waitMs) {
      // 尚未静默：推进快照，变更暂存至待发队列
      // Not settled yet: advance the snapshot, keep changes queued.
      saveState({ ...st, at: now, files: snap, pending: merged });
      return;
    }

    // 冷却期内：变更继续暂存，不丢弃
    // Cooldown: keep queueing, do not drop.
    const cooldownMs = num(cfg.cooldownMin, 15, 0, 1440) * 60000;
    if (st.lastNotifyAt && now - st.lastNotifyAt < cooldownMs) {
      saveState({ ...st, at: now, files: snap, pending: merged });
      pendingSince = 0;
      dbg(`cooldown active (${Math.round((now - st.lastNotifyAt) / 60000)} min since last), queueing ${n}`);
      return;
    }

    const { text, kinds, count, source } = await composeNotice(merged, cfg);
    const owner = await resolveOwnerIdAsync().catch(() => '');
    let delivered = false;

    if (!owner) {
      dbg(`no owner configured, log only: ${text.replace(/\n/g, ' | ')}`);
      api?.warn?.(`[${PLUGIN_ID}] ${count} change(s) detected but no owner QQ configured; logged only: ${text.replace(/\n/g, ' | ')}`);
    } else {
      try {
        const resp = await sendPrivate(owner, text);
        // 记录协议端返回码：调用未抛错不代表消息已送达，retcode 更具参考价值
        // Record the protocol return code: a call that did not throw does not
        // prove delivery, retcode is the meaningful signal.
        const code = resp?.retcode ?? resp?.status ?? resp?.data?.message_id ?? 'ok';
        dbg(`sent to ${owner} (${source}): ${kinds.join(',')} ${count} file(s), retcode=${code}`);
        api?.log?.(`[${PLUGIN_ID}] notified owner (${source}): ${kinds.join(',')} ${count} file(s)`);
        delivered = true;
      } catch (error) {
        dbg(`send failed (attempt ${(st.failCount || 0) + 1}): ${error?.message ?? error}`);
        api?.warn?.(`[${PLUGIN_ID}] notification failed: ${error?.message ?? error}`);
      }
    }

    pendingSince = 0;
    if (delivered || !owner) {
      // 已送达，或未配置通知对象：清空待发队列并推进冷却时间
      // Delivered, or nowhere to send: clear the queue and start cooldown.
      saveState({ version: 1, at: now, files: snap, lastNotifyAt: now, pending: {}, failCount: 0 });
    } else {
      // 发送失败：保留待发队列，下一轮重试，避免网络波动导致通知丢失。
      // 同时设置重试上限（3 次）：协议端持续不可用时每 15 秒重试一次没有意义。
      // Send failed: keep the queue and retry on the next pass so a transient
      // network error does not swallow the notification. Capped at 3 attempts,
      // because retrying every 15s against a dead endpoint is pointless.
      const fails = (st.failCount || 0) + 1;
      if (fails >= 3) {
        dbg(`send failed ${fails} times, dropping ${count} queued change(s)`);
        saveState({ version: 1, at: now, files: snap, lastNotifyAt: st.lastNotifyAt || 0, pending: {}, failCount: 0 });
      } else {
        saveState({ version: 1, at: now, files: snap, lastNotifyAt: st.lastNotifyAt || 0, pending: merged, failCount: fails });
      }
    }
  } catch (error) {
    api?.warn?.(`[${PLUGIN_ID}] scan pass failed (skipped, next pass continues): ${error?.message ?? error}`);
  } finally {
    running = false;
  }
}

/* ────────────────────────── 生命周期 / lifecycle ────────────────────────── */

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
  api?.log?.(`[${PLUGIN_ID}] mounted: watching ${areas}; debounce ${num(cfg.debounceSec, 10, 0, 600)}s, `
    + `cooldown ${num(cfg.cooldownMin, 15, 0, 1440)}min, model composition ${cfg.useModel === false ? 'off' : 'on'}; state ${STATE_FILE()}`);
}

export function available() { return { ok: true }; }

export function activate() {
  if (timer) return;
  if (settings().enabled === false) return;
  // 启动后延迟 8 秒执行首次扫描：避开宿主启动阶段与其他扩展的初始化。
  // 热重载会重建定时器，延迟过长会导致变更后响应明显变慢。
  // Delay the first pass by 8s to avoid the host startup window and other
  // extensions' initialization. Hot reload rebuilds the timer, so a longer
  // delay would noticeably slow down the response to changes.
  timer = setTimeout(function loop() {
    tick().catch(() => { /* tick 内部已处理自身错误 / tick handles its own errors */ });
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
      modelComposition: cfg.useModel !== false,
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

/** 测试钩子：不启动定时器，手动执行一轮。
 *  Test hook: run one pass without starting the timer. */
export const internals = { tick, snapshot, loadState, saveState, STATE_FILE, LOG_FILE, diffSnapshots, mergeDiff, buildMessage, composeNotice, sanitizeNotice };
