// owner-watch: watches files belonging to the host itself and notifies the owner
// when they change.
//
// Watched paths (intentionally narrow)
//   resources/app/skills/    skills
//   resources/app/plugins/   plugins
//   resources/app/src/       core code
//   data/config.json         configuration
//   Nothing else: session archives, logs, download folders and unrelated user
//   directories are out of scope.
//
// Why polling instead of fs.watch
//   fs.watch does not behave consistently for recursive directories on Windows:
//   events may be lost when a subdirectory is added, and plugin hot reload or a
//   directory rebuild drops events as well. This plugin only needs mtime and
//   size, and one scan over ~200 files takes single-digit milliseconds, so a
//   fixed interval is used in exchange for determinism. The cost is up to 15s of
//   latency; missed detections are not acceptable.
//
// Three layers of notification damping
//   1. debounce - wait debounceSec after the last change, then aggregate
//   2. cooldown - at least cooldownMin between two notifications; changes during
//      the cooldown are queued, not dropped
//   3. ignore rules - editor temporary files do not count as changes
//   The first run only builds a baseline and sends nothing.
//
// Cost
//   Scanning itself is pure local file attribute comparison and consumes no
//   tokens. The notification text is composed by the model (see composeNotice)
//   unless disabled; a template fallback is always available.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PLUGIN_ID = 'owner-watch';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');          // resources/app
const INSTALL_ROOT = path.resolve(APP_ROOT, '..', '..');  // QQ Agent root

const SCAN_INTERVAL_MS = 15000;   // scan interval
const MAX_LIST = 8;               // max entries listed in one notification
const MAX_TEXT = 900;             // hard cap for a notification (protocol limit)
const IDLE_WRITE_MS = 60000;      // max time between state writes when idle
const MAX_MODEL_CHARS = 160;      // composed text longer than this is discarded
const MAX_MODEL_CHARS_HARD = 320; // absolute cap before sending
// Baseline schema version. Increment whenever the watched set changes so that
// stale baselines are rebuilt silently. Without it, upgrading from
// "skills/plugins only" to "also src/" reports every file under src/ as added.
const STATE_SCHEMA = 2;

let api = null;
let timer = null;
let running = false;
let pendingSince = 0;             // timestamp of the first observed change

/* ─────────────────────────── paths ─────────────────────────── */

function dataDir() {
  const explicit = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (explicit) return explicit;
  return path.join(INSTALL_ROOT, 'data');
}

const STATE_DIR = () => path.join(dataDir(), 'owner-watch');
const STATE_FILE = () => path.join(STATE_DIR(), 'state.json');
const LOG_FILE = () => path.join(STATE_DIR(), 'log.txt');

/**
 * Append one line to the local run log. Only called when a change is detected
 * or a decision is made.
 *
 * api.log is not sufficient on its own: extension console output is not written
 * to the host log file, so when a notification is not delivered there is no way
 * to inspect the decision path afterwards.
 */
function dbg(msg) {
  try {
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    const file = LOG_FILE();
    // Rotate: continuous changes can grow this file quickly; cap at 200 KB.
    try {
      const st = fs.statSync(file);
      if (st.size > 200 * 1024) fs.renameSync(file, `${file}.1`);
    } catch { /* file does not exist yet */ }
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
  } catch { /* logging failures must not affect the main flow */ }
}

/* ────────────────────────── settings ────────────────────────── */

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

/* Notification target resolution: plugin setting first, then the
 * owner-identity extension, empty string when neither is available. */
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

/** Resolve the owner QQ id asynchronously; also warms up the host config module. */
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

/* ─────────────────────────── state ─────────────────────────── */

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE(), 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && j.files && typeof j.files === 'object') {
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
  } catch { /* first run or unreadable file: treat as empty state */ }
  return { version: 1, schema: 0, at: 0, files: null, lastNotifyAt: 0, pending: { added: [], removed: [], changed: [] }, failCount: 0 };
}

let lastWriteAt = 0;

function saveState(st) {
  try {
    fs.mkdirSync(STATE_DIR(), { recursive: true });
    // Atomic write: write to .tmp then rename. A plain overwrite that is
    // interrupted leaves truncated JSON, which fails to parse on the next run,
    // sets files to null and rebuilds the baseline, losing all changes that
    // happened in between.
    const tmp = `${STATE_FILE()}.tmp`;
    // Always stamp the current schema so no branch can omit it and cause the
    // baseline to be treated as outdated on every pass.
    fs.writeFileSync(tmp, JSON.stringify({ ...st, schema: STATE_SCHEMA }), 'utf8');
    fs.renameSync(tmp, STATE_FILE());
    lastWriteAt = Date.now();
  } catch (error) {
    api?.warn?.(`[${PLUGIN_ID}] state write failed: ${error?.message ?? error}`);
  }
}

/* ────────────────────────── scanning ────────────────────────── */

const IGNORE_RE = /(^|[\\/])(node_modules|\.git)([\\/]|$)|\.(swp|swx|tmp|temp|bak|log|orig|rej|DS_Store)([-.]|$)|(^|[\\/])~\$|(^|[\\/])\.#/i;

function ignored(rel) {
  // Enabled by default. It must be disabled only when explicitly set to false:
  // writing `!settings().skipIgnored` yields the opposite result in
  // environments without configuration (self-test, before setup).
  if (settings().skipIgnored === false) return false;
  return IGNORE_RE.test(rel);
}

/** Recursively scan a directory into { relativePath: "mtime:size" }. */
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
      } catch { /* file removed between readdir and stat: skip */ }
    }
  }
  return out;
}

/** config.json is compared by content hash: the host rewrites defaults, which
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
  // src/ is core code: changes there are not applied by hot reload and require
  // a process restart.
  if (cfg.watchSrc !== false) scanTree(path.join(APP_ROOT, 'src'), 'src', out);
  if (cfg.watchConfig !== false) {
    const sig = configSignature();
    if (sig) out['config.json'] = sig;
  }
  return out;
}

/* ─────────────────────────── diffs ─────────────────────────── */

/**
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
 * Check whether a baseline covers every root directory the current
 * configuration watches.
 *
 * This is a more direct test than the schema number: a baseline that lacks any
 * watched root (for example an older version without src/) is stale and must be
 * rebuilt silently, otherwise every file under that root is reported as added.
 *
 * @param {object} files  existing baseline
 * @param {object} cfg    plugin settings
 * @param {object|null} fresh current scan result; when provided, a root counts
 *                            as missing only if the fresh scan contains it too,
 *                            which prevents an empty directory from triggering a
 *                            rebuild on every pass
 * @returns {string[]} missing prefixes; empty array means fully covered
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
 * Merge the queued diff with the current one.
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

/** Group files by area so a large change set is not listed file by file. */
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
 * Build the template notification. Pure function.
 * Used as the fallback when the model is unavailable or returns unusable text.
 * @param {object} diff   result of diffSnapshots
 * @param {object} cfg    plugin settings
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

  // Truncate long lists
  const shown = lines.slice(0, MAX_LIST);
  if (lines.length > MAX_LIST) shown.push(`· …还有 ${lines.length - MAX_LIST} 项`);

  const uniqKinds = [...new Set(kinds)];

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

  // The protocol has a per-message length limit; truncate before sending.
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT - 12)}…（太长，收着说了）`;

  return { text, kinds: uniqKinds, count };
}

/* ──────────────────── model-composed notice ──────────────────── */

/** Read model endpoint settings from the host configuration. Null when unusable. */
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

/** Minimal chat completion call. Returns null on any failure. */
async function callModel(messages, timeoutMs) {
  const mc = await readModelConfig();
  if (!mc) return null;
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), Math.max(3000, Number(timeoutMs) || 12000));
  try {
    const res = await fetch(`${mc.baseUrl}/chat/completions`, {
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

/** Strip wrappers and formatting the model tends to add. Empty string = unusable. */
export function sanitizeNotice(raw, maxChars = MAX_MODEL_CHARS) {
  let t = String(raw || '').trim();
  if (!t) return '';
  // Drop code-fence markers but keep their content: the model sometimes wraps
  // the sentence it wants to say inside a fence.
  t = t.replace(/```[a-zA-Z0-9_+-]*\s*/g, '').trim();
  // Acknowledgement prefix first: it may wrap the quotes that are stripped next.
  t = t.replace(/^(好的|好|嗯|收到|明白)[，,。！!\s]*/u, '').trim();
  // Two passes handle cases such as 「"..."」 that appear after an acknowledgement.
  for (let i = 0; i < 2; i++) {
    const before = t;
    t = t.replace(/^["'“”「『]+|["'“”」』]+$/g, '').trim();
    if (t === before) break;
  }
  t = t.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 4).join('\n');
  if (!t) return '';
  if (t.length > maxChars) return '';   // too long: treat as off-target
  return t;
}

/** Human-readable change summary handed to the model. */
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
 * Compose the notification text.
 *
 * Strategy: let the model speak in its own voice using the configured persona,
 * because a fixed opening line makes every notification read like a system
 * alert. The template is kept as a fallback so a model failure never suppresses
 * the notification itself.
 *
 * Returns { text, kinds, count, source } where source is 'model' or 'template'.
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

/* ─────────────────────────── sending ─────────────────────────── */

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

/* ──────────────────────────── main loop ──────────────────────────── */

async function tick() {
  if (running) return;
  running = true;
  try {
    const cfg = settings();
    if (cfg.enabled === false) return;

    const st = loadState();
    const now = Date.now();
    const snap = snapshot();

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
    // Merge the queue with the current diff; otherwise advancing the snapshot
    // would leave queued changes without a chance to be sent.
    const merged = mergeDiff(st.pending, diff);
    const n = totalChanges(merged);
    if (!n) {
      pendingSince = 0;
      // Nothing changed: no need to rewrite state every pass.
      if (now - lastWriteAt < IDLE_WRITE_MS) return;
      saveState({ ...st, at: now, files: snap, pending: {} });
      return;
    }
    if (totalChanges(diff)) {
      dbg(`detected ${totalChanges(diff)} new change(s), ${n} queued: +${diff.added.length} -${diff.removed.length} ~${diff.changed.length}; `
        + `sample ${[...diff.added, ...diff.removed, ...diff.changed].slice(0, 3).join(', ')}`);
    }

    // Debounce: remember when the first change was observed.
    if (!pendingSince) pendingSince = now;
    const waitMs = num(cfg.debounceSec, 10, 0, 600) * 1000;
    if (now - pendingSince < waitMs) {
      // Not settled yet: advance the snapshot, keep changes queued.
      saveState({ ...st, at: now, files: snap, pending: merged });
      return;
    }

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
      // Delivered, or nowhere to send: clear the queue and start cooldown.
      saveState({ version: 1, at: now, files: snap, lastNotifyAt: now, pending: {}, failCount: 0 });
    } else {
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

/* ────────────────────────── lifecycle ────────────────────────── */

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
  // Delay the first pass by 8s to avoid the host startup window and other
  // extensions' initialization. Hot reload rebuilds the timer, so a longer
  // delay would noticeably slow down the response to changes.
  timer = setTimeout(function loop() {
    tick().catch(() => { /* tick handles its own errors */ });
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

/** Test hook: run one pass without starting the timer. */
export const internals = { tick, snapshot, loadState, saveState, STATE_FILE, LOG_FILE, diffSnapshots, mergeDiff, buildMessage, composeNotice, sanitizeNotice };
