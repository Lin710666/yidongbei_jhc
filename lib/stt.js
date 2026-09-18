/**
 * stt.js —— 本地语音识别（Whisper）的 Node 侧桥接
 *
 * 与 lib/depth.js、lib/img23d.js 是同一套路子：真正的推理在 Python 子进程里
 * （tools/stt-worker.py），Node 只负责找环境、把音频落成临时文件、起进程、
 * 把失败原因翻译成人话。
 *
 * 相比前两个模块，这里多了四条**只属于"听觉"的要求**：
 *
 *   1. **默认关闭，且必须真的尊重开关。** 麦克风是这个项目里最敏感的一件东西，
 *      所以 prefs.stt.enabled 为假时 `transcribe` 在**做任何工作之前**就返回
 *      "未启用"，连临时文件都不建、连 Python 都不起。开关的检查放在最前面不是
 *      为了省那点开销，而是为了让"关着就一定没动静"这件事在代码里一眼可验。
 *   2. **并发保护。** Whisper 一次识别要 1~2GB 内存，而这台机器（15.8GB / 常常
 *      只剩 4.6GB）同时跑两个就是直接换页换到卡死。所以这里选**排队 + 上限**：
 *      正在跑时后来的请求进队列，队列超过 QUEUE_LIMIT 就直接拒绝并明说"前一个
 *      还在识别"。为什么不是"立刻拒绝"：用户按一次说一句话，手抖连点两下是常态，
 *      第二下直接报错很烦；为什么不是"无限排队"：队列 = 每个请求的一个音频 Buffer
 *      （最大 25MB），无限排队等于把内存交给调用方的耐心。
 *   3. **超时从"真正开始跑"算起。** 排队等待的时间不计入 120 秒 —— 否则会出现
 *      img23d 那边踩过的坑：界面上显示"正在识别"，等了很久，最后报的是超时，
 *      而用户其实只是在排队。
 *   4. **临时文件一定删掉。** 录音是隐私，不能因为这行代码没走到就把 wav 留在
 *      磁盘上。所以统一走 finally。
 *
 * 音频格式：**约定为 16kHz 单声道 16-bit PCM WAV**（前端 public/js/voice.js 负责
 * 用浏览器把 webm/opus 转成它）。Node 侧只做头部校验，不假装能解码任意格式 ——
 * 与其把一个 webm 丢给 Python 让它报一句看不懂的错，不如在这里就说清"请传 WAV"。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

/** 复用 lib/depth.js 里那套 Python 发现逻辑（候选顺序完全一致，不另起一份） */
const { pythonCandidates } = require('./depth');

const WORKER = path.join(__dirname, '..', 'tools', 'stt-worker.py');
const DEFAULT_MODEL_DIR = path.join(__dirname, '..', 'models', 'whisper');

/** 单次识别超时。Whisper-small 在 CPU 上跑 30 秒音频约 20 秒，120 秒留了足够余量。 */
const TIMEOUT_MS = Number(process.env.STT_TIMEOUT_MS || 120000);

/** 请求体上限。16kHz/16bit 单声道约 32KB/秒，25MB ≈ 13 分钟连续录音，远超需要。 */
const MAX_BYTES = Number(process.env.MAX_STT_BYTES || 25 * 1024 * 1024);

/**
 * 队列上限。1 个在跑 + 3 个等待。
 * 取 3 而不是更大的理由：每个等待项都持有一个最多 25MB 的音频 Buffer。
 */
const QUEUE_LIMIT = Number(process.env.STT_QUEUE_LIMIT || 3);

/** Whisper 只认这个采样率；前端也按它录，两边写死同一个数是有意的（见 worker 注释） */
const TARGET_RATE = 16000;

// ===== 纯函数：WAV 头部解析 =====
// 抽出来是为了能被 test/stt.js 直接测。这些判断一旦错，表现是"音频被拒"或
// "把噪音喂给模型"，两种都很难从现象倒推回原因。

/** 读小端 32 位无符号 */
function readU32(buf, off) { return buf.readUInt32LE(off); }
/** 读小端 16 位无符号 */
function readU16(buf, off) { return buf.readUInt16LE(off); }

/**
 * 解析 WAV 头，返回 { ok, reason, format, ... }。**不解码采样点** ——
 * 解码是 Python 那边的活，这里只需要判断"这是不是一个我们能在 worker 里读的 WAV"。
 *
 * 逐块遍历而不是死记 "fmt 一定在偏移 12、data 一定在偏移 44"：
 * 这两条只对最规范的写法成立，而 libsndfile / 浏览器 / 各种工具写出来的 WAV
 * 常常在 fmt 与 data 之间插一个 LIST/INFO 块，硬编码偏移会把好文件判成坏的。
 */
function inspectWav(buf) {
  const reasons = [];
  if (!Buffer.isBuffer(buf) || buf.length < 44) {
    return { ok: false, reason: '数据太短，不是有效的 WAV 文件（至少要有 44 字节的文件头）' };
  }
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return { ok: false, reason: '文件头不是 RIFF（不是 WAV）' };
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return { ok: false, reason: 'RIFF 里的类型不是 WAVE' };

  let fmt = null;
  let dataSize = 0;
  let off = 12;
  // 块长度是 4 字节；块之间按偶数对齐（奇数长度要跳过 1 个填充字节）
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = readU32(buf, off + 4);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= buf.length) {
      fmt = {
        audioFormat: readU16(buf, body),
        channels: readU16(buf, body + 2),
        sampleRate: readU32(buf, body + 4),
        byteRate: readU32(buf, body + 8),
        blockAlign: readU16(buf, body + 12),
        bitsPerSample: readU16(buf, body + 14),
      };
    } else if (id === 'data') {
      // 有些工具把 data 的长度写成 0 或写成 0xFFFFFFFF（流式写的），
      // 那就按"文件里剩下的都是数据"来算
      dataSize = (size === 0 || size === 0xFFFFFFFF || body + size > buf.length)
        ? buf.length - body : size;
      break;
    }
    off = body + size + (size % 2);
  }

  if (!fmt) return { ok: false, reason: 'WAV 里找不到 fmt 块' };
  if (dataSize <= 0) return { ok: false, reason: 'WAV 里没有音频数据（data 块为空）' };
  if (fmt.audioFormat !== 1) {
    return { ok: false, reason: `WAV 编码不是未压缩 PCM（audioFormat=${fmt.audioFormat}），请录成 16-bit PCM WAV` };
  }
  if (fmt.bitsPerSample !== 16) {
    reasons.push(`位深是 ${fmt.bitsPerSample} 位而不是 16 位`);
  }
  if (fmt.channels !== 1) reasons.push(`声道数是 ${fmt.channels} 而不是 1`);
  if (fmt.sampleRate !== TARGET_RATE) reasons.push(`采样率是 ${fmt.sampleRate}Hz 而不是 ${TARGET_RATE}Hz`);

  // 这三条只**警告不拒绝**：worker 里有 soundfile/librosa 时会自己重采样与混音，
  // 内置 wave 路径也能处理多声道与 8/32 位。拒绝掉反而是把能用的文件挡在门外。
  return {
    ok: true,
    warning: reasons.length ? reasons.join('；') : '',
    dataBytes: dataSize,
    ...fmt,
    seconds: fmt.byteRate > 0 ? Number((dataSize / fmt.byteRate).toFixed(3)) : 0,
  };
}

/**
 * 解开前端可能传来的几种写法：裸 base64 或 data:audio/wav;base64,....
 * 与 server.js 里 normalizeImage 同一套思路（那边只管 image/*，这里管 audio/*）。
 */
function decodeAudioInput(input) {
  if (!input) return { ok: false, error: '缺少音频数据' };
  if (Buffer.isBuffer(input)) return { ok: true, buffer: input };
  let s = String(input).trim();
  const m = s.match(/^data:audio\/[a-z0-9.+-]+;base64,(.*)$/is);
  if (m) s = m[1];
  s = s.replace(/\s+/g, '');
  if (!s) return { ok: false, error: '音频数据是空的' };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    return { ok: false, error: '音频数据不是合法的 base64' };
  }
  return { ok: true, buffer: Buffer.from(s, 'base64') };
}

/** 把 PCM16 单声道/多声道交错数据按时间窗平均成目标采样率（供测试与离线脚本用） */
function downsamplePcm16(samples, fromRate, toRate) {
  if (fromRate === toRate) return Int16Array.from(samples);
  const ratio = fromRate / toRate;
  const nOut = Math.max(1, Math.floor(samples.length / ratio));
  const out = new Int16Array(nOut);
  for (let i = 0; i < nOut; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let acc = 0;
    let n = 0;
    for (let j = start; j < end; j++) { acc += samples[j]; n++; }
    out[i] = n ? Math.round(acc / n) : 0;
  }
  return out;
}

/** 生成一段 WAV 文件头（只用于测试与离线自检：造输入、造夹具） */
function buildWavHeader({ dataBytes, sampleRate = TARGET_RATE, channels = 1, bitsPerSample = 16 }) {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);                    // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bitsPerSample, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/**
 * 生成一段 16kHz 单声道 16-bit WAV Buffer。
 * 测试用它造夹具；也让"没有麦克风的机器上验证整条链路"成为可能。
 * @param {number} seconds 时长
 * @param {number} freq    正弦波频率；传 0 得到静音
 */
function makeTestWav(seconds = 1, freq = 440, sampleRate = TARGET_RATE) {
  const n = Math.max(1, Math.round(seconds * sampleRate));
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = freq > 0 ? Math.round(Math.sin(2 * Math.PI * freq * i / sampleRate) * 8000) : 0;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
  }
  return { buffer: Buffer.concat([buildWavHeader({ dataBytes: data.length, sampleRate }), data]), seconds, sampleRate };
}

/**
 * 把"缺什么"整理成一句用户能照着做的说明。缺多项时用「；」分条，不糊成一团。
 *
 * 为什么抽成独立的纯函数：这段文案要在**一台既没有 Python、也没有权重**的机器上
 * 才走得到，而本机的 Python 候选里有一条硬编码路径（E:\AI\qwen-tts-webui\python），
 * 只要它还在，就永远构造不出"完全没有 Python"的环境 —— 靠环境去测这条分支是测不到的。
 * 抽出来之后可以直接喂参数验证，测试不再依赖本机装了什么。
 *
 * 顺序也有讲究：**先报 Python 再报权重**。反过来会出现"让用户去下 1GB 权重、
 * 下完依然跑不起来"的情况，因为根本没有 Python 能载它。
 */
function unavailableReason({ python, modelReady, modelDir }) {
  const missing = [];
  if (!python) missing.push('没有可用的 Python 环境（需要 torch + transformers）');
  if (!modelReady) {
    missing.push(`缺少 Whisper 权重（${modelDir}），运行 npm run fetch:whisper 下载，`
      + '默认 openai/whisper-small 约 1GB（走 hf-mirror 镜像）；嫌大可以设 WHISPER_MODEL=openai/whisper-base');
  }
  return missing.join('；');
}

function createSTT({ dir, modelDir, root = path.join(__dirname, '..'), prefs, gpu } = {}) {
  const tmpDir = path.join(dir || path.join(root, 'data'), 'stt');
  fs.mkdirSync(tmpDir, { recursive: true });

  const effectiveModelDir = modelDir
    || process.env.WENLV_WHISPER_MODEL
    || DEFAULT_MODEL_DIR;

  let probeCache = null;
  let counter = 0;

  // ===== 并发保护 =====
  // busy：当前是否有识别在跑；queue：等待中的 resolve 回调。
  // 注意计时器**不**在这里起 —— 见下面 transcribe 里 unlock 之后才起。
  let busy = false;
  const queue = [];

  function acquireSlot() {
    if (!busy) { busy = true; return Promise.resolve({ waitedMs: 0 }); }
    if (queue.length >= QUEUE_LIMIT) return Promise.resolve(null);
    const enqueuedAt = Date.now();
    return new Promise((resolve) => { queue.push(() => resolve({ waitedMs: Date.now() - enqueuedAt })); });
  }

  function releaseSlot() {
    const next = queue.shift();
    if (next) next();          // busy 保持 true，锁直接交给下一个人
    else busy = false;
  }

  function run(cmd, args, { timeout = 30000 } = {}) {
    return new Promise((resolve) => {
      let out = '';
      let err = '';
      let child;
      try {
        child = spawn(cmd, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          // !!! 必须显式指定 UTF-8，否则中文错误信息会变成乱码 !!!
          //
          // Windows 上 Python 的 stdout 默认用**系统 ANSI 代码页**（这台机器是 GBK）
          // 编码，而 Node 按 UTF-8 解码 Buffer，于是 worker 精心写的中文提示
          //（"模型目录不存在，请先运行 npm run fetch:whisper"）到用户眼前会变成
          // 「妯″瀷鐩綍涓嶅瓨鍦?」这种一看就不知道在说什么的东西 —— 比报英文还糟。
          //
          // PYTHONUTF8=1 让 CPython 3.7+ 直接以 UTF-8 打开 stdio（PEP 540 的 UTF-8 模式），
          // PYTHONIOENCODING 再兜一层（老版本 / 被 PYTHONLEGACYWINDOWSSTDIO 影响的情况）。
          // 只影响这一个子进程，不动本进程，也不动用户的全局环境。
          env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
        });
      } catch (e) {
        return resolve({ ok: false, error: e.message });
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* 忽略 */ }
        resolve({ ok: false, error: `超时（${Math.round(timeout / 1000)}s）`, stdout: out, stderr: err, timeout: true });
      }, timeout);
      child.stdout.on('data', c => { out += c; });
      child.stderr.on('data', c => { err += c; });
      child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stdout: out, stderr: err }); });
    });
  }

  /** 权重是否下载好（廉价检查：只看文件在不在，不起进程） */
  function isModelPresent() {
    const files = ['model.safetensors', 'pytorch_model.bin', 'model.safetensors.index.json'];
    return files.some(f => {
      try { return fs.statSync(path.join(effectiveModelDir, f)).size > 0; } catch { return false; }
    });
  }

  /** 开关状态。prefs 没传进来时**一律当作关闭** —— 失败方向必须偏向"不录音"。 */
  function isEnabled() {
    try { return Boolean(prefs && prefs.getConfig().stt.enabled); } catch { return false; }
  }

  function preferredLanguage() {
    try { return String(prefs.getConfig().stt.language || 'zh'); } catch { return 'zh'; }
  }

  /**
   * 探测可用性。除了"文件在不在"，还要真的 `import torch, transformers` 一次 ——
   * 系统自带的 python 十有八九没这两个包，光看路径会得出错误结论（与 lib/depth.js 同理）。
   */
  async function probe({ force = false } = {}) {
    if (probeCache && !force) return probeCache;

    const modelReady = isModelPresent();
    const tried = [];
    let python = null;

    for (const cmd of pythonCandidates(root)) {
      if ((cmd.includes(path.sep) || cmd.endsWith('.exe')) && !fs.existsSync(cmd)) {
        tried.push({ cmd, reason: '文件不存在' });
        continue;
      }
      const r = await run(cmd, ['-c', 'import torch, transformers; print("ok")'], { timeout: 60000 });
      if (r.ok && String(r.stdout).includes('ok')) { python = cmd; break; }
      tried.push({ cmd, reason: r.ok ? '缺少 torch/transformers' : (r.error || `退出码 ${r.code}`) });
    }

    const reason = unavailableReason({ python, modelReady, modelDir: effectiveModelDir });
    probeCache = {
      available: !reason,
      python,
      modelDir: effectiveModelDir,
      modelReady,
      reason,
      tried: reason ? tried : [],
      worker: WORKER,
    };
    return probeCache;
  }

  /**
   * 语音识别。
   *
   * @param {string|Buffer} filePathOrBuffer 音频路径，或 16kHz 单声道 16-bit WAV 的字节
   * @param {object} [opts]
   * @param {string} [opts.language] 'zh' / 'en' / 'auto'；不给就用偏好里的，默认 zh
   * @param {string} [opts.device]   'auto' | 'cuda' | 'cpu'
   * @param {number} [opts.timeoutMs]
   * @returns {Promise<object>} { ok:true, text, language, durationMs, ... } 或 { ok:false, code, error }
   */
  async function transcribe(filePathOrBuffer, opts = {}) {
    // ---- 第 0 步：开关。放在最前面，任何副作用之前 ----
    if (!isEnabled()) {
      return {
        ok: false,
        code: 'STT_DISABLED',
        error: '听觉模块未启用。请在「设置 → 听觉（语音识别）」里打开开关后再试 —— '
          + '开启后录音只在本机识别，不会发到任何服务器。',
      };
    }

    if (!filePathOrBuffer) {
      return { ok: false, code: 'BAD_INPUT', error: '没有收到音频（既不是文件路径也不是音频数据）' };
    }

    // ---- 第 1 步：把输入统一成 { buffer | path } ----
    let inputPath = null;          // 传给 worker 的路径
    let cleanupPath = null;        // 需要我们自己删掉的临时文件
    let inputBytes = 0;
    let wavInfo = null;

    if (Buffer.isBuffer(filePathOrBuffer)) {
      const buf = filePathOrBuffer;
      inputBytes = buf.length;
      if (inputBytes > MAX_BYTES) {
        return {
          ok: false,
          code: 'TOO_LARGE',
          error: `音频过大（${(inputBytes / 1024 / 1024).toFixed(1)}MB，上限 ${(MAX_BYTES / 1024 / 1024).toFixed(0)}MB）。`
            + '请说得短一些，或分段上传。',
        };
      }
      wavInfo = inspectWav(buf);
      if (!wavInfo.ok) {
        return { ok: false, code: 'BAD_FORMAT', error: `音频格式不对：${wavInfo.reason}。请让前端用 public/js/voice.js 录成 16kHz 单声道 16-bit WAV 再上传。` };
      }
      // 落盘：worker 的接口是"--input 一个文件路径"，而不是"从 stdin 读字节"。
      // 这样 worker 那边可以完全复用 Python 的音频读取生态（soundfile/librosa/wave），
      // 不必再为二进制流写一套解析。
      counter = (counter + 1) % 100000;
      cleanupPath = path.join(tmpDir, `in-${Date.now().toString(36)}-${counter}.wav`);
      fs.writeFileSync(cleanupPath, buf);
      inputPath = cleanupPath;
    } else {
      inputPath = path.resolve(String(filePathOrBuffer));
      let st = null;
      try { st = fs.statSync(inputPath); } catch { /* 下面统一报错 */ }
      if (!st || !st.isFile()) {
        return { ok: false, code: 'BAD_INPUT', error: `音频文件不存在：${inputPath}` };
      }
      inputBytes = st.size;
      if (inputBytes > MAX_BYTES) {
        return {
          ok: false,
          code: 'TOO_LARGE',
          error: `音频过大（${(inputBytes / 1024 / 1024).toFixed(1)}MB，上限 ${(MAX_BYTES / 1024 / 1024).toFixed(0)}MB）`,
        };
      }
      if (inputBytes === 0) return { ok: false, code: 'BAD_INPUT', error: `音频文件是空的：${inputPath}` };
      wavInfo = inspectWav(fs.readFileSync(inputPath));
      // 路径输入只警告不拒绝：调用方（脚本/测试）可能故意喂 flac 之类，
      // 而 worker 有 soundfile/librosa 能读。Buffer 输入来自浏览器，就必须是 WAV。
      if (!wavInfo.ok) wavInfo = { ok: true, warning: wavInfo.reason, unknown: true };
    }

    // ---- 第 2 步：探测环境（模型/解释器缺了就没必要排队了）----
    const p = await probe();
    if (!p.available) {
      if (cleanupPath) { try { fs.unlinkSync(cleanupPath); } catch { /* 忽略 */ } }
      // 注意：这里**不**返回 STT_UNAVAILABLE 之外的 code，避免前端把"没装模型"
      // 和"开关没开"混在一起显示 —— 两者的处置完全不同（一个是去设置里打开，
      // 一个是去跑 npm run fetch:whisper）。
      return { ok: false, code: 'STT_UNAVAILABLE', error: p.reason, detail: p.tried };
    }

    // ---- 第 3 步：排队 ----
    //
    // 所有返回路径都带 waitedMs / elapsedMs，包括失败的那些。为什么失败也要带：
    // 前端要能区分"等了两分钟才轮到我，然后失败了"和"立刻就失败了"——
    // 这两种情况该给用户的建议完全不同（一个是去说短一点，一个是去查环境）。
    // 一开始只在成功路径上带了这两个字段，结果是"排队等了很久然后模型加载失败"
    // 这种情况在界面上看不出等过 —— 是测试里的一条断言把这个问题暴露出来的。
    const queueEnteredAt = Date.now();
    const slot = await acquireSlot();
    if (!slot) {
      if (cleanupPath) { try { fs.unlinkSync(cleanupPath); } catch { /* 忽略 */ } }
      return {
        ok: false,
        code: 'BUSY',
        error: `听觉模块正忙（已有 1 条正在识别、${queue.length} 条在等待）。请等前一条识别完成后再试。`,
        waitedMs: Date.now() - queueEnteredAt,
        elapsedMs: Date.now() - queueEnteredAt,
      };
    }

    const t0 = Date.now();
    const waitedMs = slot.waitedMs;
    try {
      const language = String(opts.language || preferredLanguage() || 'zh').trim();
      const args = [
        WORKER,
        '--model', p.modelDir,
        '--input', inputPath,
        '--json',
      ];
      if (language) args.push('--language', language);
      if (opts.device && opts.device !== 'auto') args.push('--device', String(opts.device));

      // 显存独占，优先级 audio：说话与听话是交互性最强的，不该被后台任务拖住。
      // 注意这里已经有本文件自己的并发槽（acquireSlot），两者职责不重叠 ——
      // 那个槽管"同一时刻只跑一条识别"，这个闸门管"和别的子系统别抢显存"。
      const r = gpu && gpu.withExclusive
        ? await gpu.withExclusive({ name: '语音识别', priority: gpu.PRIORITY.audio },
          () => run(p.python, args, { timeout: Number(opts.timeoutMs) || TIMEOUT_MS }))
        : await run(p.python, args, { timeout: Number(opts.timeoutMs) || TIMEOUT_MS });

      // worker 约定：stdout 一行 JSON（成功失败都走它），日志在 stderr
      const line = String(r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
      let payload = null;
      try { payload = JSON.parse(line); } catch { /* 下面按整体失败处理 */ }

      if (!payload) {
        if (r.timeout) {
          return {
            ok: false,
            code: 'STT_TIMEOUT',
            error: `语音识别超时（${Math.round((Number(opts.timeoutMs) || TIMEOUT_MS) / 1000)}s）。`
              + '可以照做：说短一点、或把 WHISPER_MODEL 换成更小的 openai/whisper-base 重新下载。',
            waitedMs,
            elapsedMs: Date.now() - t0,
          };
        }
        return {
          ok: false,
          code: 'STT_FAILED',
          error: `语音识别工作进程没有返回可解析的结果（退出码 ${r.code}）。\n`
            + String(r.stderr || '').trim().split('\n').slice(-4).join('\n'),
          waitedMs,
          elapsedMs: Date.now() - t0,
        };
      }
      if (!payload.ok) {
        return {
          ok: false,
          code: payload.code || 'STT_FAILED',
          error: payload.error || '语音识别失败（工作进程没有给出原因）',
          detail: payload,
          waitedMs,
          elapsedMs: Date.now() - t0,
        };
      }
      return {
        ok: true,
        text: String(payload.text || ''),
        language: payload.language || language,
        durationMs: Number(payload.durationMs) || 0,
        audioSeconds: payload.audioSeconds,
        inferSeconds: payload.inferSeconds,
        device: payload.device,
        deviceFallback: payload.deviceFallback || null,
        decoder: payload.decoder,
        segments: payload.segments || 0,
        empty: Boolean(payload.empty),
        waitedMs,
        elapsedMs: Date.now() - t0,
        wavWarning: wavInfo && wavInfo.warning ? wavInfo.warning : '',
        bytes: inputBytes,
      };
    } finally {
      // 临时文件与锁都必须在这里释放：中途 return、抛异常、超时都要走到。
      // 录音是隐私，留在磁盘上比失败本身更糟。
      releaseSlot();
      if (cleanupPath) { try { fs.unlinkSync(cleanupPath); } catch { /* 已被删掉就算了 */ } }
    }
  }

  async function status() {
    const p = await probe();
    return {
      enabled: isEnabled(),
      available: p.available,
      python: p.python,
      modelDir: p.modelDir,
      modelReady: p.modelReady,
      language: preferredLanguage(),
      reason: p.reason || '',
      worker: WORKER,
      busy,
      queued: queue.length,
      maxBytes: MAX_BYTES,
      timeoutMs: TIMEOUT_MS,
      tmpDir,
    };
  }

  /**
   * 廉价状态：不探测环境、不起 Python 进程，只读内存里的开关与队列。
   * 给 /api/status 用 —— 那个接口每次进页面都会调，不该顺手去 import 一次 torch。
   * 与 lib/img23d.js 里 isModelPresent() 的角色相同（那边也是"文件在不在"级别）。
   */
  function quickStatus() {
    return {
      enabled: isEnabled(),
      modelPresent: isModelPresent(),
      modelDir: effectiveModelDir,
      language: preferredLanguage(),
      busy,
      queued: queue.length,
    };
  }

  /** 清掉 data/stt 下遗留的临时音频（进程被强杀时 finally 走不到，会留下文件） */
  function cleanupTmp() {
    let n = 0;
    try {
      for (const f of fs.readdirSync(tmpDir)) {
        if (!f.startsWith('in-')) continue;
        try { fs.unlinkSync(path.join(tmpDir, f)); n++; } catch { /* 忽略 */ }
      }
    } catch { /* 目录不存在就算了 */ }
    return n;
  }

  return {
    tmpDir,
    modelDir: effectiveModelDir,
    isModelPresent,
    isEnabled,
    probe,
    transcribe,
    status,
    quickStatus,
    cleanupTmp,
  };
}

module.exports = {
  createSTT,
  unavailableReason,
  inspectWav,
  decodeAudioInput,
  downsamplePcm16,
  buildWavHeader,
  makeTestWav,
  WORKER,
  TIMEOUT_MS,
  MAX_BYTES,
  QUEUE_LIMIT,
  TARGET_RATE,
  DEFAULT_MODEL_DIR,
};
