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
//
// 内容详情（v1.3）与意图解释（v1.4）
// Detail (v1.3) & intent (v1.4)
//   除了文件名，本插件还会为被监听的文本文件留一份副本（data/owner-watch/contents/），
//   变更时做行级 diff，把"具体加了/改了什么"一起交给模型，让它用自己的话带出来。
//   只读文本、且不超过 MAX_SNAPSHOT_BYTES 的文件；二进制与超大文件只报类型和大小。
//   留档仅存本机、仅覆盖被监听目录，可用 detailEnabled 关闭。详情随通知一并发送，
//   冷却期间进入待发队列不丢失，发送成功或彻底失败后清空。
//   v1.4 起，摘要进一步补上"作用"（清单的 description、代码文件的开头注释）与
//   "结果"（清单的 tools 即新能力），提示词也要求模型讲清"干了什么 / 有什么用 /
//   结果如何"三层，而不只是报文件名。
//   Besides filenames, this plugin keeps a copy of every watched text file
//   (data/owner-watch/contents/) and diffs it line by line on change, so the
//   "what exactly changed" is handed to the model to phrase in its own voice.
//   Only text files under MAX_SNAPSHOT_BYTES are read; binary/oversized files
//   report type and size only. Snapshots stay on this machine, cover only the
//   watched paths, and can be disabled via detailEnabled. Detail rides along
//   with the notice, survives cooldown in the queue, and is cleared after a
//   successful (or definitively failed) send.
//   From v1.4 the summary also carries "effect" (a manifest's description, a
//   code file's header comment) and "result" (a manifest's tools = new
//   capabilities), and the prompt asks the model to convey all three layers —
//   what changed, what it is for, and what it leads to — instead of just names.

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
// 内容留档与详情摘要（v1.3）：把"只报文件名"升级为"能说明具体改了什么"。
// 为控制开销与体积，只对文本文件、且不超过下列大小时读取并留档内容，
// 二进制与超大文件仅报告"文件类型 + 大小变化"。
// Content snapshot & detail knobs (v1.3): upgrade from filename-only to a
// summary of the actual change. Only text files under the size cap are read
// and snapshotted; binary and oversized files only report type and size change.
const MAX_SNAPSHOT_BYTES = 256 * 1024;  // 留档单文件大小上限 / max bytes to snapshot
const MAX_DETAIL_CHARS = 1500;          // 单次通知的详情文本总长上限 / total detail cap
const MAX_SAMPLE_LINES = 3;             // 单文件摘录的示例行数 / sample lines per file
const MAX_SAMPLE_CHARS = 120;           // 单行摘录长度 / max chars per sampled line
const TEXT_EXT_RE = /\.(js|mjs|cjs|json|md|markdown|txt|text|ts|tsx|jsx|css|html|htm|yml|yaml|py|sh|bat|xml|svg|vue|toml|ini|conf|env|gitignore|npmrc)$/i;
// 基线结构版本。监听范围或状态结构变更时递增，用于触发基线静默重建。
// 若不递增，从"仅监听 skills/plugins"升级到"同时监听 src/"时，
// 首次比对会把 src/ 下全部文件判为新增并批量上报。
// Baseline schema version. Increment whenever the watched set or the state
// structure changes so that stale baselines are rebuilt silently. Without it,
// upgrading from "skills/plugins only" to "also src/" reports every file under
// src/ as added.
// v1.3: 2 -> 3，新增 details 字段与 contents 快照目录，重建基线并同步快照。
// v1.3: 2 -> 3, added the details field and the contents snapshot directory;
// the baseline is rebuilt so snapshots are (re)synchronized.
const STATE_SCHEMA = 3;

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
// 内容留档目录：为每个被监听的文本文件保存一份副本，供变更时做行级 diff。
// 文件名用 encodeURIComponent 编码相对路径，避免 / 与特殊字符带来的目录歧义。
// Snapshot directory: keeps a copy of every watched text file so a change can be
// diffed line by line. Relative paths are percent-encoded into flat filenames.
const CONTENTS_DIR = () => path.join(STATE_DIR(), 'contents');

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
        // details 保存"已检测到但尚未随通知发送"的内容摘要（key 为相对路径）。
        // 它与 pending 同生命周期：发送成功后一并清空，避免冷却期内丢失具体改动。
        // details holds per-file change summaries not yet delivered (key = relative
        // path). It shares pending's lifecycle and is cleared after a successful send.
        details: j.details && typeof j.details === 'object' ? j.details : {},
        failCount: Number(j.failCount) || 0
      };
    }
  } catch { /* 首次运行或文件损坏，均按空状态处理 / first run or unreadable file: treat as empty state */ }
  return { version: 1, schema: 0, at: 0, files: null, lastNotifyAt: 0, pending: { added: [], removed: [], changed: [] }, details: {}, failCount: 0 };
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

/* ───────────────────── 内容留档与详情 / content snapshot & detail ───────────────────── */

/** 相对路径 → 绝对路径。config.json 位于数据目录，其余在 resources/app 下。
 *  Resolve a relative watch path to an absolute path. config.json lives in the
 *  data directory; everything else lives under resources/app. */
function absFor(rel) {
  if (rel === 'config.json') return path.join(dataDir(), 'config.json');
  return path.join(APP_ROOT, rel);
}

/** 内容留档文件路径：用 percent-encoding 平铺相对路径，避免目录歧义。
 *  Snapshot file path: flatten the relative path with percent-encoding. */
function snapshotPathFor(rel) {
  return path.join(CONTENTS_DIR(), encodeURIComponent(rel));
}

/** 读取留档内容；不存在或损坏返回 null。
 *  Read a snapshot; null when missing or unreadable. */
function readSnapshot(rel) {
  try { return fs.readFileSync(snapshotPathFor(rel), 'utf8'); } catch { return null; }
}

/** 写入留档。目录按需创建；失败只降低后续 diff 精度，不影响主流程。
 *  Write a snapshot. Create the directory as needed; failure only degrades later
 *  diff precision, never the main flow. */
function writeSnapshot(rel, text) {
  try {
    fs.mkdirSync(CONTENTS_DIR(), { recursive: true });
    fs.writeFileSync(snapshotPathFor(rel), String(text ?? ''), 'utf8');
  } catch { /* 留档失败可容忍 / snapshot write failure is tolerable */ }
}

/** 删除留档（被监听文件消失后清理）。
 *  Remove a snapshot once the watched file is gone. */
function removeSnapshot(rel) {
  try { fs.unlinkSync(snapshotPathFor(rel)); } catch { /* 不存在则忽略 / ignore if absent */ }
}

/** 全量重建留档：清空目录后为基线内每个文本文件写一份副本。
 *  仅在建立/重建基线时调用，保证快照目录与当前监听范围严格一致。
 *  Rebuild all snapshots: clear the directory, then snapshot every text file in
 *  the baseline. Called only when the baseline is (re)built. */
function syncSnapshots(files) {
  try { fs.rmSync(CONTENTS_DIR(), { recursive: true, force: true }); } catch { /* 忽略 / ignore */ }
  for (const rel of Object.keys(files || {})) {
    let buf;
    try { buf = fs.readFileSync(absFor(rel)); } catch { continue; }
    if (buf.length > MAX_SNAPSHOT_BYTES || !isLikelyText(buf)) continue;
    writeSnapshot(rel, buf.toString('utf8'));
  }
}

/** 读取某文件当前内容与元信息。文件缺失或不可读时 meta 为 null。
 *  Read the current bytes of a watched file plus metadata. meta is null when the
 *  file is gone or unreadable.
 *  @returns {{text: string|null, meta: {bytes:number,binary:boolean,big:boolean,ext:string}|null}} */
function readCurrent(rel) {
  let buf;
  try { buf = fs.readFileSync(absFor(rel)); } catch { return { text: null, meta: null }; }
  const meta = {
    bytes: buf.length,
    ext: path.extname(rel).slice(1).toLowerCase(),
    binary: !isLikelyText(buf),
    big: buf.length > MAX_SNAPSHOT_BYTES
  };
  if (meta.binary || meta.big) return { text: null, meta };
  return { text: buf.toString('utf8'), meta };
}

/** 粗判是否文本：采样前 8KB，含 NUL 字节即视为二进制。
 *  Heuristic text check: a NUL byte within the first 8 KB marks a binary file. */
function isLikelyText(buf) {
  if (!buf || !buf.length) return true;
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return false;
  return true;
}

/**
 * 行级近似 diff：去掉公共前缀与公共后缀，中间即被替换的块。
 * 相比完整 LCS 这是 O(n) 的近似：对"改几行/加几行"的常见编辑足够精确，
 * 整段重写则退化为 +A/-B 加若干示例行。这里只要"摘要给模型看"，不需要可打补丁。
 * Approximate line diff: strip the common prefix and suffix, the middle is the
 * replaced block. Unlike a full LCS this is O(n); it is exact for the common
 * "edit/add a few lines" case and degrades to +A/-B plus samples for a full
 * rewrite. A summary is all that is needed, not a patch.
 * @returns {{added: number, removed: number, samples: string[]}}
 */
export function diffLines(oldText, newText) {
  // 空串 split 会得到 [''] 而非空数组，导致凭空多出"删了一行"；
  // 这里把空文本显式映射为空行数组。
  // An empty string splits to [''] instead of [], which would fabricate one
  // removed line; map empty text to an empty line array explicitly.
  const a = oldText ? String(oldText).split(/\r?\n/) : [];
  const b = newText ? String(newText).split(/\r?\n/) : [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const samples = [];
  for (let i = start; i < endB && samples.length < MAX_SAMPLE_LINES; i++) {
    const line = b[i].trim();
    if (!line) continue;
    samples.push(line.length > MAX_SAMPLE_CHARS ? `${line.slice(0, MAX_SAMPLE_CHARS)}…` : line);
  }
  return { added: endB - start, removed: endA - start, samples };
}

/** 提取 skill.json / plugin.json / package.json 的元信息，供"新增了谁"的摘要。
 *  Extract name/description/version/tools from a skill/plugin/package manifest.
 *  tools 是"结果"的关键：它告诉模型这次改动让机器人多出了哪些能力。
 *  tools carries the "result": it tells the model which new capabilities the
 *  change grants the bot. */
function jsonMeta(text) {
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object') return null;
    const tools = Array.isArray(j.tools)
      ? j.tools.map((t) => String(t?.name || t?.id || '').trim()).filter(Boolean)
      : [];
    return {
      name: String(j.name || j.id || '').trim(),
      desc: String(j.description || j.summary || '').trim(),
      ver: String(j.version || '').trim(),
      tools
    };
  } catch { return null; }
}

/** 提取文本文件开头连续的注释块，作为"这个文件是干嘛的"的上下文。
 *  仅取前 160 字，避免把整段版权头都塞给模型。
 *  Extract the leading contiguous comment block as a hint of what the file is
 *  for. Capped at 160 chars so a long license header is not fed verbatim. */
function headComment(text) {
  const t = String(text ?? '');
  if (!t) return '';
  const lines = t.replace(/^#![^\n]*\n/, '').split(/\r?\n/);
  const out = [];
  let inBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (inBlock) {
      out.push(line.replace(/^\*\s?/, '').trim());
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (/^\/\*/.test(line)) {
      inBlock = !line.includes('*/');
      out.push(line.replace(/^\/\*+\s?/, '').replace(/\s?\*\/\s*$/, '').trim());
      continue;
    }
    if (/^\/\/+/.test(line)) {
      out.push(line.replace(/^\/\/+\s?/, '').trim());
      continue;
    }
    if (line === '') continue;   // 注释块内的空行忽略，继续往后看 / skip blanks inside the block
    break;                        // 第一行真正的代码结束注释块 / first real code line ends the block
  }
  const joined = out.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  if (!joined) return '';
  return joined.length > 160 ? `${joined.slice(0, 160)}…` : joined;
}

/** 生成单文件摘要：文本文件给出行级改动 + 示例 + 开头注释（作用）；
 *  清单文件给出名称与描述（作用）与 tools（结果）；
 *  二进制/超大文件只报大小。纯函数（meta 由调用方提供）。
 *  Build a per-file summary: line-level change + samples + header comment
 *  (effect) for text; name/desc (effect) and tools (result) for manifests;
 *  size only for binary or oversized files. Pure function.
 *  @param {string} rel      相对路径 / relative path
 *  @param {string|null} oldText 变更前文本 / previous text
 *  @param {string|null} newText 变更后文本 / current text
 *  @param {'added'|'changed'|'removed'} kind
 *  @param {{bytes:number,binary:boolean,big:boolean,ext:string}|null} meta
 */
export function summarizeFile(rel, oldText, newText, kind, meta) {
  const base = path.basename(rel);
  if (meta?.binary) return `二进制文件（${fmtBytes(meta.bytes)}），未读内容`;
  if (meta?.big) return `大文件（${fmtBytes(meta.bytes)}），未逐行比对`;

  // 清单文件优先给"名称 + 描述 + 能力"：描述是"作用"，tools 是"结果"，
  // 合起来让模型能说清"加了谁、干嘛用、带来什么"。
  // Manifests first: name + description + tools. The description carries the
  // "effect", tools carry the "result", so together the model can say what was
  // added, what it is for and what it grants.
  if (/^(skill|plugin|package)\.json$/i.test(base)) {
    const m = jsonMeta(kind === 'removed' ? oldText : newText);
    if (m && (m.name || m.desc)) {
      const parts = [];
      if (m.name) parts.push(`「${m.name}」`);
      if (m.ver) parts.push(`v${m.ver}`);
      if (m.desc) parts.push(m.desc);
      if (m.tools.length) parts.push(`带来 ${m.tools.length} 个能力：${m.tools.slice(0, 6).join('、')}`);
      return parts.filter(Boolean).join('，');
    }
  }

  const d = diffLines(oldText, newText);
  let stat;
  if (kind === 'removed') stat = `删了 ${d.removed} 行`;
  else if (kind === 'added') stat = `新增 ${d.added} 行`;
  else stat = `+${d.added} -${d.removed} 行`;
  const parts = [stat];
  // 示例行只在"修改"时有意义：新增/删除时整份文件都是新的/整份消失，
  // 抽到的"示例"不过是文件开头几行，与下面"作用"里的开头注释重复。
  // Samples are meaningful only for a modification: for add/remove the whole
  // file is new/gone, so the "samples" would just be the file's first lines and
  // duplicate the header comment used as "effect" below.
  if (kind === 'changed' && d.samples.length) parts.push(`如：${d.samples.join('；')}`);
  // 文件头部注释通常说明这个文件的用途，是"作用"的来源。
  // The header comment usually states what the file is for — the "effect" source.
  const hc = headComment(kind === 'removed' ? oldText : newText);
  if (hc) parts.push(`作用：${hc}`);
  return parts.join('；');
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 汇总整批变更的详情文本，供模型在通知里自然引用。
 * 分「新增 / 修改 / 删除」三节，每条一行；超过 MAX_DETAIL_CHARS 截断。
 * Assemble the detail text for a whole batch, grouped by added/modified/removed,
 * one line per file, truncated to MAX_DETAIL_CHARS.
 * @param {object} diff    mergeDiff 的结果 / result of mergeDiff
 * @param {object} details 相对路径 → 摘要 / relative path → summary
 * @param {object} cfg     插件设置 / plugin settings
 * @returns {string}
 */
export function buildDetailText(diff, details = {}, cfg = {}) {
  if (cfg.detailEnabled === false) return '';
  const d = details || {};
  const sections = [];
  const push = (head, files, mark) => {
    const rows = files.map((f) => `${mark}${f}${d[f] ? ` → ${d[f]}` : ''}`);
    if (rows.length) sections.push(`${head}\n${rows.join('\n')}`);
  };
  push('【新增】', diff.added || [], '+ ');
  push('【修改】', diff.changed || [], '~ ');
  push('【删除】', diff.removed || [], '- ');
  if (!sections.length) return '';
  let text = sections.join('\n');
  // 长度上限取配置项 maxDetailChars（默认 MAX_DETAIL_CHARS），避免写死。
  // The cap follows the maxDetailChars setting (default MAX_DETAIL_CHARS).
  const cap = num(cfg.maxDetailChars, MAX_DETAIL_CHARS, 100, 8000);
  if (text.length > cap) text = `${text.slice(0, cap - 20)}…（详情太长，截断）`;
  return text;
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
 * 策略：让模型按"发给谁那个会话实际生效的人设"现场说一句，并把本轮具体改动
 * （内容摘要，含作用与结果线索）一并交给模型，让它能在话里自然带出"干了什么、
 * 有什么用、结果如何"。
 * 固定开场白会让每条通知都像系统告警；模板保留为兜底，并在模型不可用时
 * 附加结构化详情，确保具体改动内容不因模型异常而丢失。
 * Strategy: let the model speak in the persona effective for the recipient's
 * chat, and hand it the concrete change detail so it can naturally mention what
 * was added or edited. A fixed opening line makes every notice read like a
 * system alert. The template stays as a fallback and carries the structured
 * detail when the model is unavailable, so the specifics are never lost.
 *
 * @param {object} diff   mergeDiff 的结果 / result of mergeDiff
 * @param {object} cfg    插件设置 / plugin settings
 * @param {string} ownerId 通知对象 QQ 号（用于取该会话人设）/ recipient QQ id
 * @param {object} details 相对路径 → 内容摘要 / relative path → summary
 * @returns {{text, kinds, count, source, detail}} source 为 'model' | 'template' | 'none'
 */
export async function composeNotice(diff, cfg = {}, ownerId = '', details = {}) {
  const tpl = buildMessage(diff, cfg);
  if (!tpl.count) return { ...tpl, source: 'none', detail: '' };
  const detail = buildDetailText(diff, details, cfg);
  if (cfg.useModel === false) {
    const text = withDetail(tpl.text, detail);
    return { text, kinds: tpl.kinds, count: tpl.count, source: 'template', detail };
  }

  const mod = await loadConfigMod();
  const hostCfg = mod?.getConfig?.() || {};

  // 人设取"发给谁"那个会话实际生效的版本：开源后每个 bot 的人设不同，
  // 必须跟随宿主当前人设来维持语气，而不是写死某一种。
  // Use the persona effective for the recipient's chat: since personas differ
  // per bot once open-sourced, the voice must follow the host's current persona.
  let persona = hostCfg?.persona || {};
  if (ownerId && typeof mod?.personaForChat === 'function') {
    try { persona = mod.personaForChat(`private:${ownerId}`) || persona; } catch { /* fallback below */ }
  }
  const personaText = String(persona?.roleText || '').trim();
  const botName = String(persona?.botName || '').trim();

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

  const detailBlock = detail
    ? `你确实看到了具体改动（已精简，可能含它是什么、能干什么、带来了哪些能力）：\n${detail}\n`
    : '你这次只能看到哪些文件被动过，看不到具体内容，别编造细节。';

  const user = [
    `你注意到的改动是：`,
    summary,
    '',
    detailBlock,
    '',
    hint,
    '',
    '请给主人发一句话。要求：',
    '· 一到三句，像平时说话，短。',
    '· 尽量让主人知道三件事：具体改了什么（干什么）、这个改动是干嘛用的（作用）、改完以后会怎样（结果，比如你多了个能力、以后能帮他做什么）。用自己的话自然带出一两点即可，不必三点都齐全，也不要列清单、不要逐条复述。',
    '· 不要用"检测到""变更""通知""系统"这类词，不要每句都用同样的称呼起头。',
    '· 可以带一点情绪，但不要长篇、不要说教。',
    '· 如果你觉得没什么好说的，就随便说一句你现在的想法。',
    '只输出要发的那句话本身，不要加引号、不要加说明。'
  ].join('\n');

  const raw = await callModel(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    num(cfg.modelTimeoutMs, 12000, 3000, 60000)
  );
  const text = sanitizeNotice(raw, num(cfg.modelMaxChars, MAX_MODEL_CHARS, 40, MAX_MODEL_CHARS_HARD));
  if (!text) return { text: withDetail(tpl.text, detail), kinds: tpl.kinds, count: tpl.count, source: 'template', detail };

  dbg(`model composed ${text.length} chars (template fallback ready)`);
  return { text, kinds: tpl.kinds, count: tpl.count, source: 'model', detail };
}

/** 把结构化详情附加到通知文本末尾（模板兜底用），并按协议长度截断。
 *  Append the structured detail to a notice (template path), capped to the
 *  protocol length limit. */
function withDetail(base, detail) {
  if (!detail) return base;
  const joined = `${base}\n\n${detail}`;
  return joined.length > MAX_TEXT ? `${joined.slice(0, MAX_TEXT - 12)}…（太长，收着说了）` : joined;
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
    // 两个判据同时使用：schema 覆盖"新增监听目录 / 状态结构变化"，missingPrefixes
    // 覆盖"旧基线缺少新区域但 schema 已是新值"（该情况曾导致 50 条误报进入待发队列）。
    // First run, or an outdated baseline: build the baseline and stay silent.
    // Both tests are required: schema covers "a watched root was added or the
    // state structure changed", while missingPrefixes covers "old baseline lacks
    // a newly watched root although schema already reads as current" (that case
    // once queued 50 false entries).
    const missing = st.files ? missingPrefixes(st.files, cfg, snap) : ['(no baseline)'];
    if (!st.files || st.schema !== STATE_SCHEMA || missing.length) {
      // 建立/重建基线时同步内容快照：后续变更才能做行级 diff。
      // Sync content snapshots when the baseline is (re)built; only then can a
      // later change be diffed line by line.
      syncSnapshots(snap);
      saveState({
        version: 1, schema: STATE_SCHEMA, at: now, files: snap,
        lastNotifyAt: st.lastNotifyAt || 0, pending: {}, details: {}, failCount: 0
      });
      dbg(st.files
        ? `baseline rebuilt (schema ${st.schema} -> ${STATE_SCHEMA}, missing ${missing.join(',')}): ${Object.keys(snap).length} files`
        : `baseline created: ${Object.keys(snap).length} files`);
      api?.log?.(`[${PLUGIN_ID}] baseline ready: watching ${Object.keys(snap).length} files`);
      return;
    }

    const diff = diffSnapshots(st.files, snap);

    // 内容精筛 + 详情生成：对每个变更文件读旧留档与新内容，产出摘要并同步快照。
    // 仅 mtime/size 变化而内容未变的文件在此被剔除（如编辑器 touch、宿主重写默认值）。
    // Refine the diff and build details: for each changed file, read the old
    // snapshot and the new content, produce a summary and refresh the snapshot.
    // Files whose mtime/size moved but whose content is identical (editor touch,
    // host rewriting defaults) are dropped here.
    const details = { ...(st.details || {}) };
    const pruned = { added: [], removed: [], changed: [] };
    for (const f of diff.changed) {
      const oldText = readSnapshot(f);
      const cur = readCurrent(f);
      if (!cur.meta) continue;                                                       // 文件瞬间消失，交给下一轮 / vanished: next pass
      if (oldText !== null && cur.text !== null && oldText === cur.text) continue;   // 内容未变 / unchanged
      if (cur.meta.binary || cur.meta.big) {
        details[f] = summarizeFile(f, null, null, 'changed', cur.meta);
      } else {
        details[f] = summarizeFile(f, oldText, cur.text, 'changed', cur.meta);
        writeSnapshot(f, cur.text);
      }
      pruned.changed.push(f);
    }
    for (const f of diff.added) {
      const cur = readCurrent(f);
      if (!cur.meta) continue;
      if (cur.meta.binary || cur.meta.big) {
        details[f] = summarizeFile(f, null, null, 'added', cur.meta);
      } else {
        details[f] = summarizeFile(f, null, cur.text, 'added', cur.meta);
        writeSnapshot(f, cur.text);
      }
      pruned.added.push(f);
    }
    for (const f of diff.removed) {
      const oldText = readSnapshot(f);
      if (oldText !== null) {
        const meta = { bytes: Buffer.byteLength(oldText), binary: false, big: false, ext: path.extname(f).slice(1) };
        details[f] = summarizeFile(f, oldText, null, 'removed', meta);
      } else {
        details[f] = '已删除（未留档，看不到内容）';
      }
      removeSnapshot(f);
      pruned.removed.push(f);
    }

    // 合并待发队列与精筛后的本轮差异，避免快照推进后待发变更失去发送时机
    // Merge the queue with the refined diff; otherwise advancing the snapshot
    // would leave queued changes without a chance to be sent.
    const merged = mergeDiff(st.pending, pruned);
    const n = totalChanges(merged);
    if (!n) {
      pendingSince = 0;
      // 无变更时不必每轮写盘，限制为每分钟一次；此时也无详情可保留。
      // Nothing changed: no need to rewrite state every pass; no detail to keep.
      if (now - lastWriteAt < IDLE_WRITE_MS) return;
      saveState({ ...st, at: now, files: snap, pending: {}, details: {} });
      return;
    }
    if (totalChanges(pruned)) {
      dbg(`detected ${totalChanges(pruned)} new change(s), ${n} queued: +${pruned.added.length} -${pruned.removed.length} ~${pruned.changed.length}; `
        + `sample ${[...pruned.added, ...pruned.removed, ...pruned.changed].slice(0, 3).join(', ')}`);
    }

    // 去抖：每当观察到新变更就重新计时，只有停止变更 debounceSec 秒后才发送。
    // 若只记录"首次"变更时间，连续修改超过 debounceSec 秒时会在尚未停手时
    // 提前发出第一条。这里用"最近一次观察到变更"作为基准，实现真正的停手去抖。
    // Debounce: reset the timer on every newly observed change, so a notice is
    // sent only after changes stop for debounceSec seconds. Tracking only the
    // first change would fire early while edits are still ongoing.
    if (totalChanges(pruned)) pendingSince = now;
    const waitMs = num(cfg.debounceSec, 10, 0, 600) * 1000;
    if (now - pendingSince < waitMs) {
      // 尚未静默：推进快照，变更与详情暂存至待发队列
      // Not settled yet: advance the snapshot, keep changes and details queued.
      saveState({ ...st, at: now, files: snap, pending: merged, details });
      return;
    }

    // 冷却期内：变更继续暂存，不丢弃
    // Cooldown: keep queueing, do not drop.
    const cooldownMs = num(cfg.cooldownMin, 15, 0, 1440) * 60000;
    if (st.lastNotifyAt && now - st.lastNotifyAt < cooldownMs) {
      saveState({ ...st, at: now, files: snap, pending: merged, details });
      pendingSince = 0;
      dbg(`cooldown active (${Math.round((now - st.lastNotifyAt) / 60000)} min since last), queueing ${n}`);
      return;
    }

    const owner = await resolveOwnerIdAsync().catch(() => '');
    const { text, kinds, count, source } = await composeNotice(merged, cfg, owner, details);
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
      // 已送达，或未配置通知对象：清空待发队列与详情并推进冷却时间
      // Delivered, or nowhere to send: clear the queue and details, start cooldown.
      saveState({ version: 1, at: now, files: snap, lastNotifyAt: now, pending: {}, details: {}, failCount: 0 });
    } else {
      // 发送失败：保留待发队列与详情，下一轮重试，避免网络波动导致通知丢失。
      // 同时设置重试上限（3 次）：协议端持续不可用时每 15 秒重试一次没有意义。
      // Send failed: keep the queue and details and retry on the next pass so a
      // transient network error does not swallow the notification. Capped at 3
      // attempts, because retrying every 15s against a dead endpoint is pointless.
      const fails = (st.failCount || 0) + 1;
      if (fails >= 3) {
        dbg(`send failed ${fails} times, dropping ${count} queued change(s)`);
        saveState({ version: 1, at: now, files: snap, lastNotifyAt: st.lastNotifyAt || 0, pending: {}, details: {}, failCount: 0 });
      } else {
        saveState({ version: 1, at: now, files: snap, lastNotifyAt: st.lastNotifyAt || 0, pending: merged, details, failCount: fails });
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
      detailEnabled: cfg.detailEnabled !== false,
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
export const internals = {
  tick, snapshot, loadState, saveState, STATE_FILE, LOG_FILE, CONTENTS_DIR,
  diffSnapshots, mergeDiff, missingPrefixes, buildMessage, composeNotice, sanitizeNotice,
  diffLines, summarizeFile, buildDetailText, readSnapshot, writeSnapshot, readCurrent, syncSnapshots,
  headComment, jsonMeta
};
