/**
 * img23d.js —— 图片转 3D 的 Node 侧桥接（TripoSR）
 *
 * 与 lib/depth.js 是同一套路子：真正的推理在 Python 子进程里
 * （tools/triposr-worker.py），Node 只负责找环境、起进程、把产物登记进项目。
 *
 * 三条与深度那边一致、但更需要注意的地方：
 *
 *   1. **权重 1.6GB，绝不能随仓库走。** 所以缺权重时要给"怎么装"的明确指引，
 *      而不是让用户对着一个莫名失败发呆。
 *   2. **产物要落到项目已有的模型库**（data/models3d/），这样生成的东西能直接
 *      在「外观 → 更换形象」里选到 —— 不需要另造一套模型管理。
 *   3. **显存是这台机器上最容易撞的墙。** 8GB 卡跑 256³ 等值面很紧，
 *      所以分辨率可以调；爆显存时要把"调小分辨率"这条建议直接给出来。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const WORKER = path.join(__dirname, '..', 'tools', 'triposr-worker.py');
const CODE_DIR = path.join(__dirname, '..', 'tools', 'TripoSR');
const TIMEOUT_MS = Number(process.env.IMG23D_TIMEOUT_MS || 600000);

/** 复用 lib/depth.js 里那套 Python 发现逻辑（候选顺序完全一致） */
const { pythonCandidates } = require('./depth');

function createImg23D({ dir, modelDir, root = path.join(__dirname, '..'), gpu } = {}) {
  const outDir = path.join(dir, 'img23d');
  fs.mkdirSync(outDir, { recursive: true });

  const effectiveModelDir = modelDir
    || process.env.WENLV_TRIPOSR_MODEL
    || path.join(root, 'models', 'triposr');

  let probeCache = null;

  function run(cmd, args, { timeout = 30000, onStderr } = {}) {
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let child;
      try {
        child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch (e) {
        return resolve({ ok: false, error: e.message });
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* 忽略 */ }
        resolve({ ok: false, error: `超时（${Math.round(timeout / 1000)}s）`, stdout: out, stderr: err });
      }, timeout);
      child.stdout.on('data', c => { out += c; });
      child.stderr.on('data', (c) => { err += c; if (onStderr) onStderr(String(c)); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stdout: out, stderr: err }); });
    });
  }

  const isModelPresent = () =>
    fs.existsSync(path.join(effectiveModelDir, 'model.ckpt'))
    && fs.existsSync(path.join(effectiveModelDir, 'config.yaml'));

  /**
   * 探测可用性。要求三样都齐：Python 环境有 torch/trimesh 等、TripoSR 源码在、
   * 权重在。任何一样缺了都要说清是哪一样 —— "图生 3D 不可用"这种话没法照做。
   */
  async function probe({ force = false } = {}) {
    if (probeCache && !force) return probeCache;

    const modelReady = isModelPresent();
    const codeReady = fs.existsSync(path.join(CODE_DIR, 'tsr', 'system.py'));
    const tried = [];
    let python = null;

    for (const cmd of pythonCandidates(root)) {
      if ((cmd.includes(path.sep) || cmd.endsWith('.exe')) && !fs.existsSync(cmd)) {
        tried.push({ cmd, reason: '文件不存在' });
        continue;
      }
      // 比深度那次多检查 trimesh / omegaconf / mcubes —— 它们只有 TripoSR 需要
      const r = await run(cmd, ['-c', 'import torch, trimesh, omegaconf, mcubes, numpy; print("ok")'], { timeout: 60000 });
      if (r.ok && String(r.stdout).includes('ok')) { python = cmd; break; }
      tried.push({ cmd, reason: r.ok ? '缺少 torch/trimesh/omegaconf/mcubes' : (r.error || `退出码 ${r.code}`) });
    }

    const missing = [];
    if (!python) missing.push('没有可用的 Python 环境（需要 torch + trimesh + omegaconf + PyMCubes）');
    if (!codeReady) missing.push(`缺少 TripoSR 源码（${CODE_DIR}/tsr）`);
    if (!modelReady) missing.push(`缺少模型权重（${effectiveModelDir}/model.ckpt），运行 npm run fetch:triposr 下载，约 1.6GB`);

    probeCache = {
      available: missing.length === 0,
      python,
      modelDir: effectiveModelDir,
      modelReady,
      codeReady,
      reason: missing.length ? missing.join('；') : '',
      tried: missing.length ? tried : [],
      worker: WORKER,
    };
    return probeCache;
  }

  /**
   * 生成模型。
   * @param {string} id        任务 id（决定输出文件名）
   * @param {string} imagePath 输入图片绝对路径
   */
  async function generate(id, imagePath, { resolution = 160, chunkSize = 2048, removeBg = true, bakeTexture = true, textureResolution = 1024, rembgModel = '', onLog } = {}) {
    const p = await probe();
    if (!p.available) {
      return { ok: false, code: 'IMG23D_UNAVAILABLE', error: p.reason, detail: p.tried };
    }
    if (!fs.existsSync(imagePath)) {
      return { ok: false, code: 'BAD_INPUT', error: `输入图片不存在：${imagePath}` };
    }

    const output = path.join(outDir, `${id}.glb`);
    const args = [
      WORKER,
      '--model', p.modelDir,
      '--code', CODE_DIR,
      '--input', imagePath,
      '--output', output,
      '--resolution', String(resolution),
      '--chunk-size', String(chunkSize),
      '--rembg-model', String(rembgModel || ''),
    ];
    if (!removeBg) args.push('--no-remove-bg');
    if (bakeTexture) {
      args.push('--bake-texture');
      // 贴图集分辨率：1024 已经够用，2048 会明显更慢且 GLB 大一圈
      args.push('--texture-resolution', String(Math.min(Math.max(Number(textureResolution) || 1024, 256), 2048)));
    }

    const runOpts = {
      timeout: TIMEOUT_MS,
      onLog,
      onStderr: (chunk) => { if (onLog) for (const line of chunk.split('\n')) if (line.trim()) onLog(line.trim()); },
    };

    // 显存独占：TripoSR 是全项目最吃显存的一步（256³ 等值面，8GB 卡上很紧）。
    // 必须和 Whisper / TTS / 深度图 / Ollama 串起来 —— 这是"抢显存"里最容易炸的一环。
    // 优先级给 user：这是用户点出来的活，不该被后台跑的深度图挡在后面。
    const r = gpu && gpu.withExclusive
      ? await gpu.withExclusive({ name: '图片转 3D', priority: gpu.PRIORITY.user }, () => run(p.python, args, runOpts))
      : await run(p.python, args, runOpts);

    const line = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    let payload = null;
    try { payload = JSON.parse(line); } catch { /* 按整体失败处理 */ }

    if (!payload) {
      return {
        ok: false,
        code: 'IMG23D_FAILED',
        error: `图生 3D 工作进程没有返回可解析的结果（退出码 ${r.code}）。\n`
          + String(r.stderr || '').trim().split('\n').slice(-6).join('\n'),
      };
    }
    if (!payload.ok) {
      return { ok: false, code: 'IMG23D_FAILED', error: payload.error, detail: payload };
    }
    if (!fs.existsSync(output)) {
      return { ok: false, code: 'IMG23D_FAILED', error: '工作进程报告成功，但输出文件不存在' };
    }
    return { ok: true, ...payload, file: output, id };
  }

  /** 读出生成的 GLB（供登记进模型库） */
  function readModel(id) {
    const fp = path.join(outDir, `${id}.glb`);
    if (!fs.existsSync(fp)) return null;
    return fs.readFileSync(fp);
  }

  function remove(id) {
    try { fs.unlinkSync(path.join(outDir, `${id}.glb`)); return true; } catch { return false; }
  }

  function list() {
    try {
      return fs.readdirSync(outDir).filter(f => f.endsWith('.glb')).map(f => {
        const st = fs.statSync(path.join(outDir, f));
        return { id: path.basename(f, '.glb'), bytes: st.size, at: st.mtimeMs };
      }).sort((a, b) => b.at - a.at);
    } catch { return []; }
  }

  async function status() {
    const p = await probe();
    return {
      available: p.available,
      python: p.python,
      modelDir: p.modelDir,
      modelReady: p.modelReady,
      codeReady: p.codeReady,
      reason: p.reason || '',
      worker: WORKER,
      jobs: list().length,
    };
  }

  return {
    outDir,
    modelDir: effectiveModelDir,
    isModelPresent,
    probe,
    generate,
    readModel,
    remove,
    list,
    status,
  };
}

module.exports = { createImg23D, WORKER, CODE_DIR, TIMEOUT_MS };
