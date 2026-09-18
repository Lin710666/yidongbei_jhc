/**
 * depth.js —— 单目深度估计的 Node 侧桥接
 *
 * 把"跑深度模型"这件事收敛成一个函数：给一张图，拿回一张归一化高度图 PNG。
 * 真正的推理在 tools/depth-worker.py 里（torch + transformers），Node 只负责
 * 找 Python、起子进程、缓存结果、把失败原因翻译成人话。
 *
 * ## 为什么每次都要起一个新 Python 进程
 *
 * 实测一次冷启动（载模型 0.7s + 推理 1.4s）约 2~3 秒，而做成常驻服务能把这 0.7 秒
 * 省掉。但常驻进程要处理保活、崩溃重启、显存常占 —— 为 0.7 秒引入这些复杂度不划算，
 * 而且深度图是**按全景图缓存**的，同一张景区图只会算一次。所以选了子进程。
 *
 * ## Python 从哪来
 *
 * 本项目的 Node 侧零依赖，但深度模型只能跑在 Python 里。所以这里做"发现"而不是
 * "内置"：先看 WENLV_PYTHON，再看项目内 tools/py，最后探几个本机已有的 AI 环境。
 * 找不到就**明确告诉用户怎么办**，而不是让功能静默失效。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const WORKER = path.join(__dirname, '..', 'tools', 'depth-worker.py');
const TIMEOUT_MS = Number(process.env.DEPTH_TIMEOUT_MS || 180000);

/** 候选 Python 位置。顺序即优先级：显式配置 > 项目内 venv > 本机既有 AI 环境 > PATH。 */
function pythonCandidates(root) {
  const list = [];
  if (process.env.WENLV_PYTHON) list.push(process.env.WENLV_PYTHON);
  // 项目内 venv。注意 Windows 的 venv 把解释器放在 Scripts/ 下，
  // 而 Linux/macOS 放在 bin/ —— 两种布局都要找，否则"明明建好了却说没有环境"。
  list.push(path.join(root, 'tools', 'py', 'Scripts', 'python.exe'));
  list.push(path.join(root, 'tools', 'py', 'bin', 'python'));
  list.push(path.join(root, 'tools', 'py', 'python.exe'));
  // 本机常见的 AI 环境：装过 qwen-tts / ComfyUI 之类的机器上通常已经有 torch，
  // 直接复用比让用户再下一份 2.5GB 的 torch 合理得多。
  list.push(path.join('E:', 'AI', 'qwen-tts-webui', 'python', 'python.exe'));
  list.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'python.exe'));
  for (const p of ['python', 'python3', 'py']) list.push(p);   // 交给 PATH
  return list;
}

function createDepth({ dir, modelDir, root = path.join(__dirname, '..'), gpu } = {}) {
  const cacheDir = path.join(dir, 'depth');
  fs.mkdirSync(cacheDir, { recursive: true });

  const effectiveModelDir = modelDir
    || process.env.WENLV_DEPTH_MODEL
    || path.join(root, 'models', 'depth-anything-v2-small');

  // 探测结果缓存在内存：探一次要起子进程，每次调用都探太浪费
  let probeCache = null;

  function run(cmd, args, { timeout = 30000 } = {}) {
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
        resolve({ ok: false, error: `超时（${Math.round(timeout / 1000)}s）` });
      }, timeout);
      child.stdout.on('data', c => { out += c; });
      child.stderr.on('data', c => { err += c; });
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ ok: code === 0, code, stdout: out, stderr: err });
      });
    });
  }

  /**
   * 探测可用的 Python。
   * 不只是"文件存在"，还要真的 `import torch, transformers` 一次 ——
   * 系统自带的 python 十有八九没这两个包，光看路径会得出错误结论。
   */
  async function probe({ force = false } = {}) {
    if (probeCache && !force) return probeCache;

    const modelReady = fs.existsSync(path.join(effectiveModelDir, 'model.safetensors'));
    const tried = [];

    for (const cmd of pythonCandidates(root)) {
      // 绝对路径但不存在，直接跳过（省一次无谓的进程启动）
      if ((cmd.includes(path.sep) || cmd.endsWith('.exe')) && !fs.existsSync(cmd)) {
        tried.push({ cmd, reason: '文件不存在' });
        continue;
      }
      const r = await run(cmd, ['-c', 'import torch, transformers, PIL, numpy; print("ok")'], { timeout: 30000 });
      if (r.ok && String(r.stdout).includes('ok')) {
        probeCache = {
          available: modelReady,
          python: cmd,
          modelDir: effectiveModelDir,
          modelReady,
          reason: modelReady ? '' : `模型还没下载（目录：${effectiveModelDir}）。运行 tools\\获取深度模型.ps1 即可，约 95MB。`,
          tried: [],
        };
        return probeCache;
      }
      tried.push({ cmd, reason: r.ok ? '缺少 torch/transformers' : (r.error || `退出码 ${r.code}`) });
    }

    probeCache = {
      available: false,
      python: null,
      modelDir: effectiveModelDir,
      modelReady,
      reason: '本机没有找到带 torch + transformers 的 Python 环境。\n'
        + `依次试过这些位置：\n${tried.map(t => `  · ${t.cmd} —— ${t.reason}`).join('\n')}\n`
        + `可以把环境变量 WENLV_PYTHON 指向一个已有这些包的 python.exe（例如项目内 venv 的 `
        + `<项目>\\tools\\py\\Scripts\\python.exe）。`,
      tried,
    };
    return probeCache;
  }

  /** 高度图缓存路径（按全景 id 命名，同一张图只算一次） */
  const cachePath = id => path.join(cacheDir, `${id}.depth.png`);

  /**
   * 计算高度图。
   * @param {string} id       缓存键（通常是全景记录 id）
   * @param {string} imagePath 输入图片绝对路径
   */
  async function compute(id, imagePath, { maxSide = 1024, force = false } = {}) {
    const out = cachePath(id);
    if (!force && fs.existsSync(out)) {
      return { ok: true, cached: true, file: out, id };
    }

    const p = await probe();
    if (!p.available) {
      return { ok: false, code: 'DEPTH_UNAVAILABLE', error: p.reason, detail: p.tried };
    }
    if (!fs.existsSync(imagePath)) {
      return { ok: false, code: 'BAD_INPUT', error: `输入图片不存在：${imagePath}` };
    }

    const depthArgs = [
      WORKER,
      '--model', p.modelDir,
      '--input', imagePath,
      '--output', out,
      '--max-side', String(maxSide),
    ];
    // 显存独占，但优先级压到最低：深度图是**后台自动**跑出来的效果，
    // 晚几秒没人会注意到；而用户在界面上点的"图片转 3D""说句话"必须能插到它前面。
    const r = gpu && gpu.withExclusive
      ? await gpu.withExclusive({ name: '深度高度图', priority: gpu.PRIORITY.background }, () => run(p.python, depthArgs, { timeout: TIMEOUT_MS }))
      : await run(p.python, depthArgs, { timeout: TIMEOUT_MS });

    // worker 约定：stdout 一行 JSON（成功或失败都走它），日志在 stderr
    const line = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
    let payload = null;
    try { payload = JSON.parse(line); } catch { /* 下面按整体失败处理 */ }

    if (!payload) {
      return {
        ok: false,
        code: 'DEPTH_FAILED',
        error: `深度工作进程没有返回可解析的结果（退出码 ${r.code}）。\n`
          + String(r.stderr || '').trim().split('\n').slice(-4).join('\n'),
      };
    }
    if (!payload.ok) {
      return { ok: false, code: 'DEPTH_FAILED', error: payload.error, detail: payload };
    }
    return { ok: true, cached: false, file: out, id, ...payload };
  }

  function readHeightmap(id) {
    const fp = cachePath(id);
    if (!fs.existsSync(fp)) return null;
    return { buffer: fs.readFileSync(fp), mime: 'image/png' };
  }

  function remove(id) {
    try { fs.unlinkSync(cachePath(id)); return true; } catch { return false; }
  }

  async function status() {
    const p = await probe();
    return {
      available: p.available,
      python: p.python,
      modelDir: p.modelDir,
      modelReady: p.modelReady,
      reason: p.reason || '',
      worker: WORKER,
    };
  }

  const isModelPresent = () => fs.existsSync(path.join(effectiveModelDir, 'model.safetensors'));

  return {
    cacheDir,
    modelDir: effectiveModelDir,
    isModelPresent,
    probe,
    compute,
    readHeightmap,
    remove,
    status,
    cachePath,
  };
}

module.exports = { createDepth, pythonCandidates, WORKER };
