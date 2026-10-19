// 改动看守 · 自测（不进模型、不联网，只验证纯逻辑）
// 跑法：node selftest.mjs
import { diffSnapshots, buildMessage, totalChanges, mergeDiff, missingPrefixes, internals } from './index.js';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

console.log('[1] 快照差异');
{
  const a = { 'skills/x/index.js': '1:10', 'skills/y/index.js': '1:10', 'config.json': 'sha1:old' };
  const b = { 'skills/x/index.js': '2:20', 'config.json': 'sha1:old', 'plugins/new/index.js': '1:5' };
  const d = diffSnapshots(a, b);
  ok('识别新增', d.added.length === 1 && d.added[0] === 'plugins/new/index.js');
  ok('识别删除', d.removed.length === 1 && d.removed[0] === 'skills/y/index.js');
  ok('识别修改', d.changed.length === 1 && d.changed[0] === 'skills/x/index.js');
  ok('总数=3', totalChanges(d) === 3);
  ok('无变化返回空', totalChanges(diffSnapshots(a, { ...a })) === 0);
  ok('null 快照不炸', totalChanges(diffSnapshots(null, a)) === 3);
}

console.log('[2] 差异合并（攒起来的改动不能丢）');
{
  const a = { added: ['skills/x/index.js'], removed: [], changed: [] };
  const b = { added: [], removed: [], changed: ['plugins/p/index.js'] };
  const m = mergeDiff(a, b);
  ok('新增 + 改动都留下', m.added.length === 1 && m.changed.length === 1, JSON.stringify(m));
  ok('总数=2', totalChanges(m) === 2);

  // 先新增后删除 → 净效果删除
  const c = mergeDiff({ added: ['skills/t/index.js'], removed: [], changed: [] },
    { added: [], removed: ['skills/t/index.js'], changed: [] });
  ok('先增后删=删', c.added.length === 0 && c.removed.length === 1, JSON.stringify(c));

  // 先删除后新增（同路径重建）→ 净效果新增
  const d = mergeDiff({ added: [], removed: ['skills/r/index.js'], changed: [] },
    { added: ['skills/r/index.js'], removed: [], changed: [] });
  ok('先删后增=增', d.added.length === 1 && d.removed.length === 0, JSON.stringify(d));

  // 已在新增里的文件又被"改动"→ 不重复算
  const e = mergeDiff({ added: ['skills/n/index.js'], removed: [], changed: [] },
    { added: [], removed: [], changed: ['skills/n/index.js'] });
  ok('新增不再重复算改动', e.added.length === 1 && e.changed.length === 0, JSON.stringify(e));

  ok('空值不炸', totalChanges(mergeDiff(null, null)) === 0);
}

console.log('[2.5] 基线覆盖判定（防止升级后把老目录全报成新增）');
{
  const fresh = { 'skills/a/index.js': '1:1', 'plugins/b/index.js': '1:1', 'src/app.js': '1:1', 'config.json': 'sha1:x' };

  // 老基线只有 skills/plugins → 缺 src/，必须重建
  const oldBase = { 'skills/a/index.js': '1:1', 'plugins/b/index.js': '1:1', 'config.json': 'sha1:x' };
  const miss1 = missingPrefixes(oldBase, {}, fresh);
  ok('老基线缺 src/ 被识别', miss1.includes('src/'), JSON.stringify(miss1));

  // 覆盖齐全 → 不算缺失
  const miss2 = missingPrefixes(fresh, {}, fresh);
  ok('覆盖齐全时不重建', miss2.length === 0, JSON.stringify(miss2));

  // 目录真的是空的（新扫描也没有）→ 不能判缺失，否则每轮都重建
  const emptyCfg = {};
  const miss3 = missingPrefixes({ 'skills/a/index.js': '1:1' }, emptyCfg, { 'skills/a/index.js': '1:1' });
  ok('空目录不算缺失（防无限重建）', miss3.length === 0, JSON.stringify(miss3));

  // 关掉 src 监听后，基线里没 src 也不该重建
  const miss4 = missingPrefixes(oldBase, { watchSrc: false }, fresh);
  ok('关掉 src 监听就不要求它', !miss4.includes('src/'), JSON.stringify(miss4));
}

console.log('[3] 文案生成');
{
  // 新装一个技能（目录里所有文件都是新增）
  const d1 = { added: ['skills/video-frames/index.js', 'skills/video-frames/plugin.json'], removed: [], changed: [] };
  const m1 = buildMessage(d1, {});
  ok('认出"多了个技能"', m1.text.includes('多了个技能：video-frames'), m1.text);
  ok('带上询问', m1.text.includes('自动重新加载'), m1.text);
  ok('kinds 含技能', m1.kinds.includes('技能'));

  // 删掉一个插件
  const d2 = { added: [], removed: ['plugins/old/index.js'], changed: [] };
  const m2 = buildMessage(d2, {});
  ok('认出"删了个插件"', m2.text.includes('删了个插件：old'), m2.text);

  // 只改设置
  const d3 = { added: [], removed: [], changed: ['config.json'] };
  const m3 = buildMessage(d3, {});
  ok('认出设置变更', m3.text.includes('改了我的设置'), m3.text);
  ok('设置类询问措辞', m3.text.includes('重启我才吃进去'), m3.text);

  // 改了一行插件代码 → 不是新增也不是删除
  const d4 = { added: [], removed: [], changed: ['plugins/share-card/index.js'] };
  const m4 = buildMessage(d4, {});
  ok('认出"改动了插件"', m4.text.includes('改动了插件：share-card'), m4.text);

  // 改了核心代码 → 必须明说"得重启"，且不能说"我自动重载了"
  const d5 = { added: [], removed: [], changed: ['src/orchestrator.js', 'src/tools.js'] };
  const m5 = buildMessage(d5, {});
  ok('认出"动了我身体里的东西"', m5.text.includes('身体里的东西'), m5.text);
  ok('核心改动要求重启', m5.text.includes('重启我一次'), m5.text);
  ok('核心改动不说自动重载', !m5.text.includes('自动重新加载'), m5.text);
  ok('kinds 含核心', m5.kinds.includes('核心'));

  // 只改技能 → 说"我自己会重载"，别让主人白等
  const d6 = { added: [], removed: [], changed: ['skills/trendy-memes/skill.json'] };
  const m6 = buildMessage(d6, {});
  ok('技能改动用自动重载措辞', m6.text.includes('自动重新加载'), m6.text);

  // 超长消息要收口（QQ 单条有长度限制）
  const huge = { added: Array.from({ length: 200 }, (_, i) => `skills/hugely-named-skill-${i}/index.js`), removed: [], changed: [] };
  const m7 = buildMessage(huge, {});
  ok('超长消息被截断', m7.text.length <= 900, `len=${m7.text.length}`);

  // 无改动不产生消息
  const m8 = buildMessage({ added: [], removed: [], changed: [] }, {});
  ok('无改动输出空', m8.text === '' && m8.count === 0);

  // 超量截断（列表层面）
  const many = { added: Array.from({ length: 30 }, (_, i) => `skills/s${i}/index.js`), removed: [], changed: [] };
  const m9 = buildMessage(many, {});
  ok('最多列 8 项 + 余量提示', m9.text.includes('还有 22 项'), m9.text);

  // 自定义模板
  const m10 = buildMessage(d1, { notifyText: '动了 {count} 个文件（{kinds}）\n{changes}' });
  ok('模板变量生效', m10.text.includes('动了 2 个文件（技能）'), m10.text);
}

console.log("[4] 忽略规则");
{
  const st = internals.loadState();
  ok('状态可读（首次为空）', st.files === null || typeof st.files === 'object');
  const snap = internals.snapshot();
  const keys = Object.keys(snap);
  ok('扫描到文件', keys.length > 10, `只有 ${keys.length}`);
  ok('只含三处范围', keys.every((k) => k.startsWith('skills/') || k.startsWith('plugins/') || k.startsWith('src/') || k === 'config.json'), keys.find((k) => !(k.startsWith('skills/') || k.startsWith('plugins/') || k.startsWith('src/') || k === 'config.json')));
  ok('覆盖核心代码 src/', keys.some((k) => k.startsWith('src/')), '没扫到 src/');
  // 只排除"运行数据"，别误伤 src/ 下的真核心文件（例如 src/sessions.js 是她身体的一部分）
  ok('不含运行数据', !keys.some((k) => /^(logs|sessions|messages|video-cache|sticker-images)\//.test(k) || /jm-suomingor\/jm-/.test(k)), keys.filter((k) => /^(logs|sessions|messages|video-cache|sticker-images)\//.test(k) || /jm-suomingor\/jm-/.test(k)).slice(0, 3).join(','));
  ok('排除临时文件', !keys.some((k) => /\.(swp|swx|tmp|temp|bak|log|orig|rej)([-.]|$)/.test(k)), keys.filter((k) => /\.(swp|swx|tmp|temp|bak|log|orig|rej)([-.]|$)/.test(k)).slice(0, 3).join(','));
  ok('config.json 用哈希', !snap['config.json'] || snap['config.json'].startsWith('sha1:'));

  // 状态往返：pending 必须活着回来（丢了就永远不发提醒）
  const before = internals.loadState();
  const probe = { added: ['skills/probe/index.js'], removed: [], changed: ['config.json'] };
  internals.saveState({ ...before, version: 1, at: 1, files: snap, lastNotifyAt: 0, pending: probe });
  const back = internals.loadState();
  ok('pending 能存能读', totalChanges(back.pending) === 2, JSON.stringify(back.pending));
  ok('pending 的 added 完整', back.pending.added.includes('skills/probe/index.js'));
  // 还原成测试前的状态，别污染真实基线（真实环境可能正攥着待报改动）
  internals.saveState(before);
  const restored = internals.loadState();
  ok('状态可还原', totalChanges(restored.pending) === totalChanges(before.pending), `${totalChanges(restored.pending)} vs ${totalChanges(before.pending)}`);
}

console.log(`\n===== 通过 ${pass}，失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
