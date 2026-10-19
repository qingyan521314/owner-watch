// owner-watch 自测。仅验证纯逻辑：不调用模型，不发起网络请求。
// Self-test for owner-watch. Pure logic only: no model calls, no network.
// 运行方式：node selftest.mjs
// Run: node selftest.mjs
//
// 说明：涉及实际扫描范围的断言需要一个可用的 QQ Agent 宿主目录
// （即本插件被放置在 <安装目录>/resources/app/plugins/owner-watch/ 时）。
// 在独立克隆的仓库中运行时，这些断言会被跳过，其余断言正常执行。
// Note: assertions covering the real scan scope require a live QQ Agent host
// layout (this plugin placed at <install>/resources/app/plugins/owner-watch/).
// When run from a standalone clone they are skipped and the rest still run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  diffSnapshots, buildMessage, totalChanges, mergeDiff, missingPrefixes,
  sanitizeNotice, internals
} from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');
const IN_HOST = ['skills', 'plugins', 'src'].some((d) => fs.existsSync(path.join(APP_ROOT, d)));

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' - ' + extra : ''}`); }
}

console.log('[1] snapshot diff');
{
  const a = { 'skills/x/index.js': '1:10', 'skills/y/index.js': '1:10', 'config.json': 'sha1:old' };
  const b = { 'skills/x/index.js': '2:20', 'config.json': 'sha1:old', 'plugins/new/index.js': '1:5' };
  const d = diffSnapshots(a, b);
  ok('added detected', d.added.length === 1 && d.added[0] === 'plugins/new/index.js');
  ok('removed detected', d.removed.length === 1 && d.removed[0] === 'skills/y/index.js');
  ok('changed detected', d.changed.length === 1 && d.changed[0] === 'skills/x/index.js');
  ok('total is 3', totalChanges(d) === 3);
  ok('identical snapshots yield nothing', totalChanges(diffSnapshots(a, { ...a })) === 0);
  ok('null snapshot returns full diff', totalChanges(diffSnapshots(null, a)) === 3);
}

console.log('[2] diff merge');
{
  const a = { added: ['skills/x/index.js'], removed: [], changed: [] };
  const b = { added: [], removed: [], changed: ['plugins/p/index.js'] };
  const m = mergeDiff(a, b);
  ok('queued and new both kept', m.added.length === 1 && m.changed.length === 1, JSON.stringify(m));
  ok('total is 2', totalChanges(m) === 2);

  const c = mergeDiff({ added: ['skills/t/index.js'], removed: [], changed: [] },
    { added: [], removed: ['skills/t/index.js'], changed: [] });
  ok('add then remove resolves to remove', c.added.length === 0 && c.removed.length === 1, JSON.stringify(c));

  const d = mergeDiff({ added: [], removed: ['skills/r/index.js'], changed: [] },
    { added: ['skills/r/index.js'], removed: [], changed: [] });
  ok('remove then add resolves to add', d.added.length === 1 && d.removed.length === 0, JSON.stringify(d));

  const e = mergeDiff({ added: ['skills/n/index.js'], removed: [], changed: [] },
    { added: [], removed: [], changed: ['skills/n/index.js'] });
  ok('added file is not double counted as changed', e.added.length === 1 && e.changed.length === 0, JSON.stringify(e));

  ok('null input returns empty diff', totalChanges(mergeDiff(null, null)) === 0);
}

console.log('[3] baseline coverage');
{
  const fresh = { 'skills/a/index.js': '1:1', 'plugins/b/index.js': '1:1', 'src/app.js': '1:1', 'config.json': 'sha1:x' };

  const oldBase = { 'skills/a/index.js': '1:1', 'plugins/b/index.js': '1:1', 'config.json': 'sha1:x' };
  const miss1 = missingPrefixes(oldBase, {}, fresh);
  ok('baseline without src/ is incomplete', miss1.includes('src/'), JSON.stringify(miss1));

  const miss2 = missingPrefixes(fresh, {}, fresh);
  ok('fully covered baseline needs no rebuild', miss2.length === 0, JSON.stringify(miss2));

  const miss3 = missingPrefixes({ 'skills/a/index.js': '1:1' }, {}, { 'skills/a/index.js': '1:1' });
  ok('empty directory is not counted as missing', miss3.length === 0, JSON.stringify(miss3));

  const miss4 = missingPrefixes(oldBase, { watchSrc: false }, fresh);
  ok('disabled root is not required', !miss4.includes('src/'), JSON.stringify(miss4));
}

console.log('[4] template notification');
{
  const d1 = { added: ['skills/video-frames/index.js', 'skills/video-frames/plugin.json'], removed: [], changed: [] };
  const m1 = buildMessage(d1, {});
  ok('new skill entry present', m1.text.includes('多了个技能：video-frames'), m1.text);
  ok('hot reload wording used', m1.text.includes('自动重新加载'), m1.text);
  ok('kinds includes skill', m1.kinds.includes('技能'));

  const d2 = { added: [], removed: ['plugins/old/index.js'], changed: [] };
  const m2 = buildMessage(d2, {});
  ok('removed plugin entry present', m2.text.includes('删了个插件：old'), m2.text);

  const d3 = { added: [], removed: [], changed: ['config.json'] };
  const m3 = buildMessage(d3, {});
  ok('config change entry present', m3.text.includes('改了我的设置'), m3.text);
  ok('config wording mentions restart', m3.text.includes('重启'), m3.text);

  const d4 = { added: [], removed: [], changed: ['plugins/share-card/index.js'] };
  const m4 = buildMessage(d4, {});
  ok('modified plugin entry present', m4.text.includes('改动了插件：share-card'), m4.text);

  const d5 = { added: [], removed: [], changed: ['src/orchestrator.js', 'src/tools.js'] };
  const m5 = buildMessage(d5, {});
  ok('core change entry present', m5.text.includes('身体里的东西'), m5.text);
  ok('core change requires restart', m5.text.includes('重启我一次'), m5.text);
  ok('core change does not claim auto reload', !m5.text.includes('自动重新加载'), m5.text);
  ok('kinds includes core', m5.kinds.includes('核心'));

  const huge = { added: Array.from({ length: 200 }, (_, i) => `skills/hugely-named-skill-${i}/index.js`), removed: [], changed: [] };
  const m7 = buildMessage(huge, {});
  ok('oversized text is truncated', m7.text.length <= 900, `len=${m7.text.length}`);

  const m8 = buildMessage({ added: [], removed: [], changed: [] }, {});
  ok('empty diff produces no text', m8.text === '' && m8.count === 0);

  const many = { added: Array.from({ length: 30 }, (_, i) => `skills/s${i}/index.js`), removed: [], changed: [] };
  const m9 = buildMessage(many, {});
  ok('list capped with remainder note', m9.text.includes('还有 22 项'), m9.text);

  const m10 = buildMessage(d1, { notifyText: '动了 {count} 个文件（{kinds}）\n{changes}' });
  ok('template variables substituted', m10.text.includes('动了 2 个文件（技能）'), m10.text);
}

console.log('[5] model output sanitizing');
{
  ok('plain text unchanged', sanitizeNotice('又是你？') === '又是你？');
  ok('surrounding quotes removed', sanitizeNotice('"又是你？"') === '又是你？', sanitizeNotice('"又是你？"'));
  ok('cjk quotes removed', sanitizeNotice('「又是你？」') === '又是你？', sanitizeNotice('「又是你？」'));
  ok('cjk corner quotes removed', sanitizeNotice('“又是你？”') === '又是你？', sanitizeNotice('“又是你？”'));
  ok('acknowledgement prefix removed', sanitizeNotice('好的，又是你？') === '又是你？', sanitizeNotice('好的，又是你？'));
  ok('prefix then quoted', sanitizeNotice('好的，「又是你？」') === '又是你？', sanitizeNotice('好的，「又是你？」'));
  ok('code fence removed', sanitizeNotice('```\n又是你？\n```') === '又是你？', sanitizeNotice('```\n又是你？\n```'));
  ok('overlong output rejected', sanitizeNotice('啊'.repeat(300)) === '');
  ok('empty output rejected', sanitizeNotice('   ') === '');
  ok('blank lines collapsed', sanitizeNotice('第一句\n\n\n第二句').split('\n').length === 2);
}

console.log('[6] composeNotice fallback');
{
  // useModel:false 时不得调用模型，必须返回模板。
  // useModel:false must not touch the model and must return the template.
  const r1 = await internals.composeNotice({ added: ['skills/x/index.js'], removed: [], changed: [] }, { useModel: false });
  ok('model disabled uses template', r1.source === 'template', r1.source);
  ok('template text still produced', r1.text.includes('多了个技能：x'), r1.text);

  const r2 = await internals.composeNotice({ added: [], removed: [], changed: [] }, { useModel: true });
  ok('no changes yields no notice', r2.count === 0 && r2.text === '', JSON.stringify(r2));
}

console.log('[7] scan scope and ignore rules');
{
  const st = internals.loadState();
  ok('state readable', st.files === null || typeof st.files === 'object');
  const snap = internals.snapshot();
  const keys = Object.keys(snap);
  if (IN_HOST) {
    ok('files scanned', keys.length > 10, `only ${keys.length}`);
    ok('only watched roots present', keys.every((k) => k.startsWith('skills/') || k.startsWith('plugins/') || k.startsWith('src/') || k === 'config.json'), keys.find((k) => !(k.startsWith('skills/') || k.startsWith('plugins/') || k.startsWith('src/') || k === 'config.json')));
    ok('core code covered', keys.some((k) => k.startsWith('src/')), 'src/ not found');
    // 仅排除运行数据目录；src/sessions.js 这类属于核心代码，必须保留。
    // Runtime data only: src/sessions.js and similar are core code and must stay.
    ok('runtime data excluded', !keys.some((k) => /^(logs|sessions|messages|video-cache|sticker-images)\//.test(k) || /jm-suomingor\/jm-/.test(k)), keys.filter((k) => /^(logs|sessions|messages|video-cache|sticker-images)\//.test(k) || /jm-suomingor\/jm-/.test(k)).slice(0, 3).join(','));
    ok('temporary files excluded', !keys.some((k) => /\.(swp|swx|tmp|temp|bak|log|orig|rej)([-.]|$)/.test(k)), keys.filter((k) => /\.(swp|swx|tmp|temp|bak|log|orig|rej)([-.]|$)/.test(k)).slice(0, 3).join(','));
    ok('config compared by hash', !snap['config.json'] || snap['config.json'].startsWith('sha1:'));
  } else {
    console.log('  skip scope assertions (not inside a QQ Agent host layout)');
    ok('empty snapshot when no host', keys.length === 0, JSON.stringify(keys.slice(0, 3)));
  }

  // 状态往返：pending 必须能存能读，否则通知永不触发。
  // State round-trip: `pending` must survive, otherwise notices never fire.
  const before = internals.loadState();
  const probe = { added: ['skills/probe/index.js'], removed: [], changed: ['config.json'] };
  internals.saveState({ ...before, version: 1, at: 1, files: snap, lastNotifyAt: 0, pending: probe });
  const back = internals.loadState();
  ok('pending persisted', totalChanges(back.pending) === 2, JSON.stringify(back.pending));
  ok('pending added entry intact', back.pending.added.includes('skills/probe/index.js'));
  // 恢复测试前的状态，避免污染真实基线。
  // Restore the pre-test state so the real baseline is not polluted.
  internals.saveState(before);
  const restored = internals.loadState();
  ok('state restored', totalChanges(restored.pending) === totalChanges(before.pending), `${totalChanges(restored.pending)} vs ${totalChanges(before.pending)}`);
}

console.log(`\n===== passed ${pass}, failed ${fail} =====`);
process.exit(fail ? 1 : 0);
