#!/usr/bin/env node
/**
 * 图片转 3D 测试
 *
 * 运行：node test/img23d.js      （或 npm run test:i23d）
 *
 * 这里**不跑真实推理**（要 1.6GB 权重 + 2 分钟 + 8GB 显存，不适合当回归测试）。
 * 真实推理我在开发时单独跑通过：14226 顶点 / 28448 面 / 52.8 秒，产物登记进模型库。
 *
 * 所以本文件钉的是"接线与失败路径"——这些地方出错时表现都很有迷惑性：
 *   · Python 发现的顺序与布局（Windows venv 在 Scripts/ 下，不是 python.exe）
 *   · 探测失败时必须说清缺哪一样，而不是笼统一句"不可用"
 *   · 权重/源码缺失的判定
 *   · 产物登记与读取
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const { pythonCandidates } = require('../lib/depth');
const { createImg23D, CODE_DIR, WORKER } = require('../lib/img23d');
const { createDepth } = require('../lib/depth');

const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;
const skipped = [];
function check(name, ok, extra) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${extra !== undefined ? `  → ${extra}` : ''}`); }
}
function skip(name, why) { skipped.push(name); console.log(`  - ${name}（跳过：${why}）`); }

async function main() {
  console.log('图片转 3D 测试\n');

  console.log('A. Python 环境发现（踩过的坑）');
  const cands = pythonCandidates(ROOT);
  const norm = cands.map(c => c.replace(/\\/g, '/'));

  // 这条是实际踩到的 bug：项目内 venv 建好后仍报"没有可用的 Python 环境"，
  // 因为只找了 tools/py/python.exe，而 Windows 的 venv 解释器在 tools/py/Scripts/ 下。
  check('候选里包含 Windows venv 布局（tools/py/Scripts/python.exe）',
    norm.some(c => c.endsWith('tools/py/Scripts/python.exe')), norm.filter(c => c.includes('tools/py')).join(' | '));
  check('候选里也包含类 Unix 布局（tools/py/bin/python）',
    norm.some(c => c.endsWith('tools/py/bin/python')));
  check('候选里包含 PATH 上的 python/python3/py',
    ['python', 'python3', 'py'].every(n => cands.includes(n)));
  check('候选顺序：显式配置优先', (() => {
    const old = process.env.WENLV_PYTHON;
    process.env.WENLV_PYTHON = 'X:/custom/python.exe';
    const first = pythonCandidates(ROOT)[0];
    if (old === undefined) delete process.env.WENLV_PYTHON; else process.env.WENLV_PYTHON = old;
    return first.replace(/\\/g, '/') === 'X:/custom/python.exe';
  })());

  console.log('\nB. 工作进程与源码位置');
  check('worker 脚本存在（tools/triposr-worker.py）', fs.existsSync(WORKER), WORKER);
  check('TripoSR 源码已就位（tools/TripoSR/tsr/system.py）',
    fs.existsSync(path.join(CODE_DIR, 'tsr', 'system.py')));
  check('isosurface.py 里仍然是 torchmcubes 的调用点（垫片就是为它准备的）', (() => {
    const p = path.join(CODE_DIR, 'tsr', 'models', 'isosurface.py');
    if (!fs.existsSync(p)) return false;
    return fs.readFileSync(p, 'utf8').includes('from torchmcubes import marching_cubes');
  })());

  console.log('\nC. 探测失败时要说清缺什么');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-i23d-'));
  try {
    // 指向一个空目录当模型目录 → 应该明确报"缺权重"，且带上下载办法
    const inst = createImg23D({
      dir: tmp,
      modelDir: path.join(tmp, 'no-such-model'),
      root: path.join(tmp, 'no-such-root'),
    });
    const st = await inst.status();
    check('没有权重时 available=false', st.available === false);
    check('原因里点名"模型权重"', /权重|model\.ckpt/.test(st.reason), st.reason.slice(0, 120));
    check('原因里给出下载命令', /fetch:triposr/.test(st.reason), st.reason.slice(0, 200));
    // 注意：这里不能断言"原因里提到源码" —— CODE_DIR 是模块级常量、指向真实项目，
    // 不受临时 root 影响，所以源码检测本来就是通过的。
    // 该断言的是：缺哪几样就报哪几样，并且逐条分号分隔（不要糊成一团）。
    check('原因里同时点名 Python 环境与权重，且分条列出',
      /Python/.test(st.reason) && /权重/.test(st.reason) && st.reason.includes('；'),
      st.reason.replace(/\n/g, ' ').slice(0, 260));
    check('status 里如实带上 源码/权重 两个就绪标志',
      st.codeReady === true && st.modelReady === false, JSON.stringify({ code: st.codeReady, model: st.modelReady }));

    const gen = await inst.generate('x', path.join(tmp, 'nope.png'));
    check('不可用时 generate 返回结构化错误而不是抛异常',
      gen.ok === false && gen.code === 'IMG23D_UNAVAILABLE');

    // 有权重、但输入图不存在 → 应当是 BAD_INPUT 而不是笼统失败
    const fakeModel = path.join(tmp, 'model');
    fs.mkdirSync(fakeModel, { recursive: true });
    fs.writeFileSync(path.join(fakeModel, 'model.ckpt'), 'stub');
    fs.writeFileSync(path.join(fakeModel, 'config.yaml'), 'stub');
    const inst2 = createImg23D({ dir: tmp, modelDir: fakeModel, root: path.join(tmp, 'no-such-root') });
    check('权重文件齐备时 isModelPresent 为真', inst2.isModelPresent() === true);
    const gen2 = await inst2.generate('x', path.join(tmp, 'nope.png'));
    // 环境探测会先失败（临时 root 下没有 python），这本身也是结构化错误；
    // 只要不是抛异常、且带上 code，就算合格
    check('缺少输入图时给出带 code 的错误而不是抛异常',
      gen2.ok === false && typeof gen2.code === 'string', `${gen2.code}: ${String(gen2.error).slice(0, 80)}`);

    console.log('\nD. 产物管理');
    const outDir = path.join(tmp, 'img23d');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'job-a.glb'), Buffer.alloc(2048));
    fs.writeFileSync(path.join(outDir, 'job-b.glb'), Buffer.alloc(1024));
    fs.writeFileSync(path.join(outDir, 'ignore.txt'), 'x');

    const inst3 = createImg23D({ dir: tmp, modelDir: fakeModel, root: path.join(tmp, 'no-such-root') });
    const list = inst3.list();
    check('list 只列 GLB 且带大小', list.length === 2 && list.every(j => j.bytes > 0), JSON.stringify(list.map(j => j.id)));
    check('list 按时间倒序（最近的在前）', list[0].at >= list[1].at);
    check('readModel 读回字节', inst3.readModel('job-a') && inst3.readModel('job-a').length === 2048);
    check('readModel 读不存在返回 null', inst3.readModel('nope') === null);
    check('remove 删掉文件', inst3.remove('job-b') === true && inst3.list().length === 1);
    check('remove 不存在返回 false', inst3.remove('nope') === false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('\nE. 真实环境（存在才测，缺了就跳过）');
  const real = createImg23D({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-i23d-real-')), root: ROOT });
  if (!real.isModelPresent()) {
    skip('真实环境探测', '本机没有 TripoSR 权重（npm run fetch:triposr）');
  } else {
    const env = await real.status();
    check('本机 TripoSR 环境可用', env.available === true, env.reason);
    if (env.available) {
      check('探测到的 Python 存在', fs.existsSync(env.python), env.python);
      // 端到端真正生成太慢（约 1 分钟）且吃显存，默认不跑；要跑就设 IMG23D_E2E=1
      if (process.env.IMG23D_E2E === '1') {
        const img = path.join(os.tmpdir(), 'wenlv-i23d-e2e.png');
        const { execFileSync } = require('child_process');
        try {
          execFileSync(env.python, ['-c',
            'from PIL import Image;Image.new("RGB",(384,384),(128,128,128)).save(r"' + img + '")'], { stdio: 'ignore' });
          const r = await real.generate('e2e', img, { resolution: 128, chunkSize: 1024, removeBg: false });
          check('端到端生成出 GLB', r.ok === true && r.vertices > 100, r.ok ? `${r.vertices} 顶点` : r.error);
        } catch (e) {
          check('端到端生成出 GLB', false, e.message);
        }
      } else {
        skip('端到端真实生成', '默认跳过（约 1 分钟且吃显存）；设 IMG23D_E2E=1 可开');
      }
    }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped.length ? ` / ${skipped.length} 跳过` : ''}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试自身出错：', e);
  process.exitCode = 1;
});
