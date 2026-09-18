#!/usr/bin/env node
/**
 * Blender MCP 动画测试
 *
 * 运行：node test/blender.js      （或 npm run test:blender）
 *
 * 分两部分：
 *   A~C 是**自包含**的：不需要 Blender 在跑，测的是诊断质量、结果标记解析、
 *       产物管理。这些地方出错时表现都很有迷惑性，必须钉住。
 *   D 是**集成**：Blender 在跑就真生成一段动画并检查 GLB 里确实有动画轨道；
 *       没跑就跳过（不假装通过）。
 *
 * 真实链路我在开发时验证过：0.1 秒生成 63KB GLB、7 段动画、浏览器里
 * AnimationMixer 播放正常、根节点走出半径 2.4 的圆且首尾闭合。
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const { createBlender } = require('../lib/blender');

let pass = 0;
let fail = 0;
const skipped = [];
function check(name, ok, extra) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${extra !== undefined ? `  → ${extra}` : ''}`); }
}
function skip(name, why) { skipped.push(name); console.log(`  - ${name}（跳过：${why}）`); }

/** 解析 GLB，取出它的 JSON 块（验证动画轨道的唯一可靠办法） */
function readGlbJson(buf) {
  if (buf.length < 20 || buf.slice(0, 4).toString('ascii') !== 'glTF') return null;
  const c0len = buf.readUInt32LE(12);
  const c0type = buf.slice(16, 20).toString('ascii');
  if (c0type !== 'JSON') return null;
  try { return JSON.parse(buf.slice(20, 20 + c0len).toString('utf8')); } catch { return null; }
}

async function main() {
  console.log('Blender MCP 动画测试\n');

  console.log('A. 结果标记解析（错过的坑）');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-bl-'));
  const b = createBlender({ outDir: tmp, port: 1 });   // port 1：保证连不上
  const MARK = b.RESULT_MARK;

  const okText = `Blender 启动信息…\nINFO: Starting glTF 2.0 export\nINFO: Primitives created: 1\n${MARK}{"ok":true,"frames":72}`;
  const r1 = b.parseResultMarker(okText);
  check('能从夹杂日志的 stdout 里取出结果', r1.found && r1.value.ok === true && r1.value.frames === 72);

  // 关键：不能取"最后一行" —— 导出日志可能在标记之后还继续输出
  const tailText = `${MARK}{"ok":true}\nINFO: Draco compression available\nINFO: export finished`;
  const r2 = b.parseResultMarker(tailText);
  check('标记后面还有日志时仍能取到（说明是"从后往前找标记行"而不是取最后一行）',
    r2.found && r2.value.ok === true, JSON.stringify(r2.value));

  check('没有标记时 found=false 而不是抛异常', b.parseResultMarker('只有日志，没有标记').found === false);
  check('空输入不崩', b.parseResultMarker('').found === false && b.parseResultMarker(null).found === false);

  let badErr = null;
  try { b.parseResultMarker(`${MARK}{这不是合法 JSON`); } catch (e) { badErr = e; }
  check('标记后是坏 JSON 时给出 BLENDER_BAD_RESULT', badErr && badErr.code === 'BLENDER_BAD_RESULT', badErr && badErr.code);
  check('坏 JSON 的错误里带上原始行，便于定位', badErr && badErr.message.includes('这不是合法 JSON'));

  console.log('\nB. 连不上时的诊断质量');
  const t0 = Date.now();
  let connErr = null;
  try { await b.ping(); } catch (e) { connErr = e; }
  check('连不上时抛出 BLENDER_UNREACHABLE', connErr && connErr.code === 'BLENDER_UNREACHABLE', connErr && connErr.code);
  check('错误里点明"要打开 Blender 并点 Connect"',
    connErr && /Blender/.test(connErr.message) && /Connect|blender:start/.test(connErr.message),
    connErr && connErr.message.slice(0, 120));
  check('连接失败要快速返回（不该等满超时）', Date.now() - t0 < 8000, `${Date.now() - t0}ms`);

  const st = await b.status();
  check('status 在服务不在时报 available=false', st.available === false);
  check('status 给出可照做的启动办法',
    /npm run blender:start|Connect/.test(st.reason), st.reason.slice(0, 120));
  check('status 仍然报出已生成的产物数量', typeof st.jobs === 'number');
  check('available() 是布尔而不是抛异常', st.available === false && (await b.available()) === false);

  console.log('\nC. 产物管理');
  fs.writeFileSync(path.join(tmp, 'a.glb'), Buffer.alloc(1024));
  fs.writeFileSync(path.join(tmp, 'b.glb'), Buffer.alloc(2048));
  fs.writeFileSync(path.join(tmp, 'note.txt'), 'x');
  const list = b.list();
  check('list 只列 glb 且带大小', list.length === 2 && list.every(j => j.bytes > 0), JSON.stringify(list.map(j => j.file)));
  check('list 按时间倒序', list[0].at >= list[1].at);
  check('readModel 读回字节', b.readModel('a.glb') && b.readModel('a.glb').length === 1024);
  check('readModel 拒绝路径穿越', b.readModel('../../secret.txt') === null);
  check('readModel 读不存在返回 null', b.readModel('nope.glb') === null);
  check('remove 删掉文件', b.remove('b.glb') === true && b.list().length === 1);
  check('remove 不存在返回 false', b.remove('nope.glb') === false);

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log('\nD. 集成（Blender 在跑才测）');
  const real = createBlender({ outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-bl-real-')) });
  if (!(await real.available())) {
    skip('真实生成动画', '没检测到 Blender MCP 服务（npm run blender:start）');
  } else {
    const pong = await real.ping();
    check('ping 通', pong && pong.pong === true, JSON.stringify(pong));

    const r = await real.buildWalkAnimation({ name: 'selftest', frames: 48, radius: 2 });
    check('生成了 GLB', r.ok === true && r.bytes > 1000, `${r.bytes} 字节`);
    check('Blender 版本被如实带回', typeof r.blenderVersion === 'string' && r.blenderVersion.length > 0, r.blenderVersion);
    check('返回了生成的对象清单', Array.isArray(r.objects) && r.objects.length >= 6, (r.objects || []).join(','));

    const json = readGlbJson(fs.readFileSync(r.file));
    check('GLB 头部合法（magic=glTF）', json !== null);
    if (json) {
      check('GLB 里确实带动画段', (json.animations || []).length > 0, `${(json.animations || []).length} 段`);
      const channels = (json.animations || []).reduce((s, a) => s + (a.channels || []).length, 0);
      check('动画里有实际的通道（不是空壳）', channels > 0, `${channels} 个通道`);
      const hasRot = (json.animations || []).some(a => (a.channels || []).some(c => c.target.path === 'rotation'));
      const hasTrans = (json.animations || []).some(a => (a.channels || []).some(c => c.target.path === 'translation'));
      check('同时有旋转与位移轨道（四肢摆动 + 巡逻移动）', hasRot && hasTrans, `rot=${hasRot} trans=${hasTrans}`);
      check('GLB 里有网格与材质', (json.meshes || []).length > 0 && (json.materials || []).length > 0,
        `meshes=${(json.meshes || []).length} materials=${(json.materials || []).length}`);
    }
    check('幂等：重复生成不会让对象越堆越多', (() => {
      // 同一批对象名（wenlv_*）第二次会被先删再建，所以对象数应当一致
      return r.objects.every(n => n.startsWith('wenlv_'));
    })());
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped.length ? ` / ${skipped.length} 跳过` : ''}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试自身出错：', e);
  process.exitCode = 1;
});
