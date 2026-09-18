#!/usr/bin/env node
/**
 * 本地语音识别（听觉模块）测试
 *
 * 运行：node test/stt.js            （或 npm run test:stt）
 *       STT_E2E=1 node test/stt.js  （额外跑一次真实识别，要权重 + 几十秒）
 *
 * 这里**默认不跑真实识别**（要 1GB 权重、要起 Python 载模型，不适合当回归测试）。
 * 钉的是那些"出错时表现特别有迷惑性"的地方：
 *   · WAV 头解析 —— 判错的表现是"好文件被拒"或"把噪音喂给模型"，两种都难倒推
 *   · 开关关闭时**必须不做任何工作**（这是隐私承诺，必须可验）
 *   · 环境缺失时说清缺哪一样，而不是笼统一句"不可用"
 *   · 临时文件一定被删掉（进程被强杀时留下的也要能清）
 *   · 并发保护：第二个请求要么排队要么明确拒绝，不能两个一起跑
 *
 * 有意**不测**"识别出来的文字对不对"：本机没麦克风，夹具只能是静音或正弦波，
 * 而静音会被 Whisper 识别成什么是不可预测的（常见的是空串，也可能是一句固定客套话）。
 * 所以端到端那段只断言"不崩 + 返回结构正确"。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const sttLib = require('../lib/stt');
const {
  createSTT, inspectWav, decodeAudioInput, downsamplePcm16,
  buildWavHeader, makeTestWav, WORKER, MAX_BYTES, QUEUE_LIMIT, TARGET_RATE,
  unavailableReason,
} = sttLib;
const { createPrefs } = require('../lib/prefs');

const ROOT = path.join(__dirname, '..');
/** 项目自带的 venv。worker 协议那几条用它直接跑，不依赖 lib 的探测顺序 */
const PY = path.join(ROOT, 'tools', 'py', 'Scripts', 'python.exe');

/**
 * 是否允许跑"真的要起 Python"的部分。
 *
 * 为什么不默认跑：这些用例会 `import torch, transformers`，并让 worker 真的把
 * Whisper 权重载进内存 —— 光一次 import 就要十几秒，载完模型动辄几分钟。
 * 放进默认的 `npm test` 会让整条链慢到没人愿意跑，最后的结果是**整个测试套件
 * 被绕过**，比少测几条更糟。
 *
 * 所以默认只跑不需要 Python 的部分（纯 JS 的 WAV 解析、开关与失败路径、
 * worker 的"模型不存在"契约、临时文件清理）。要验真实链路时：
 *
 *     $env:STT_REAL='1'; node test/stt.js      # 真实排队 + 环境探测
 *     $env:STT_REAL='1'; $env:STT_E2E='1'; node test/stt.js   # 再加一次真实识别
 */
const REAL = process.env.STT_REAL === '1';

let pass = 0;
let fail = 0;
const skipped = [];
function check(name, ok, extra) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${extra !== undefined ? `  → ${extra}` : ''}`); }
}
function skip(name, why) { skipped.push(name); console.log(`  - ${name}（跳过：${why}）`); }

/** 建一个带 STT 偏好的 prefs 实例（写进临时目录，绝不碰真实的 data/prefs.json） */
function makePrefs(dir, enabled, language) {
  const p = createPrefs({ dir });
  p.update({ stt: { enabled, language: language || 'zh' } });
  return p;
}

async function main() {
  console.log('听觉（本地 Whisper 语音识别）测试\n');

  // ================= A. 接线与文件位置 =================
  console.log('A. 接线与文件位置');
  check('worker 脚本存在（tools/stt-worker.py）', fs.existsSync(WORKER), WORKER);
  check('纯函数都导出了（inspectWav / decodeAudioInput / downsamplePcm16 / buildWavHeader / makeTestWav）',
    [inspectWav, decodeAudioInput, downsamplePcm16, buildWavHeader, makeTestWav].every(f => typeof f === 'function'));
  check('常量都导出了且取值合理',
    MAX_BYTES === 25 * 1024 * 1024 && QUEUE_LIMIT >= 1 && TARGET_RATE === 16000,
    `maxBytes=${MAX_BYTES} queue=${QUEUE_LIMIT} rate=${TARGET_RATE}`);

  // ================= B. WAV 头解析（重点） =================
  console.log('\nB. WAV 解析工具函数');
  const wav = makeTestWav(1, 440);
  const info = inspectWav(wav.buffer);
  check('合法的 16kHz 单声道 16-bit WAV 被接受', info.ok === true, info.reason);
  check('解析出正确的采样率/声道/位深',
    info.sampleRate === 16000 && info.channels === 1 && info.bitsPerSample === 16,
    JSON.stringify({ r: info.sampleRate, c: info.channels, b: info.bitsPerSample }));
  check('按字节率算出的时长约为 1 秒', Math.abs(info.seconds - 1) < 0.01, info.seconds);
  check('data 块大小与实际字节数一致', info.dataBytes === 16000 * 2, info.dataBytes);

  // 浏览器录出来的是 48kHz 立体声 —— 后端不该直接拒绝（Python 侧能重采样/混音），
  // 但要给出警告，好让前端知道"这次没按约定录"
  const stereo48 = Buffer.concat([
    buildWavHeader({ dataBytes: 48000 * 2 * 2, sampleRate: 48000, channels: 2 }),
    Buffer.alloc(48000 * 2 * 2),
  ]);
  const si = inspectWav(stereo48);
  check('48kHz 立体声仍然接受（留给 Python 侧重采样）', si.ok === true, si.reason);
  check('但会警告"采样率/声道数不是约定值"',
    /48000Hz/.test(si.warning) && /声道数是 2/.test(si.warning), si.warning);

  // fmt 与 data 之间插一个 LIST 块：libsndfile 等工具经常这么写，
  // 硬编码偏移 44 的实现会把这种好文件判成坏的
  const listWav = (() => {
    const data = Buffer.alloc(1600);
    const head = buildWavHeader({ dataBytes: data.length });
    const list = Buffer.concat([Buffer.from('LIST', 'ascii'), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(10, 0); return b; })(), Buffer.from('INFOxxxxxx', 'ascii')]);
    const out = Buffer.concat([head.subarray(0, 36), list, head.subarray(36), data]);
    // 上面把 data 头也接在 list 后面了：36 起是 'data'+size，正确
    out.writeUInt32LE(out.length - 8, 4);
    return out;
  })();
  const li = inspectWav(listWav);
  check('fmt 与 data 之间夹着 LIST 块时仍能解析（不硬编码偏移）', li.ok === true && li.dataBytes === 1600, li.ok ? String(li.dataBytes) : li.reason);

  check('非 RIFF 数据被拒且说明原因', (() => {
    const r = inspectWav(Buffer.alloc(64, 0x41));
    return r.ok === false && /RIFF/.test(r.reason);
  })(), inspectWav(Buffer.alloc(64, 0x41)).reason);
  check('太短的数据被拒', (() => { const r = inspectWav(Buffer.alloc(10)); return r.ok === false && /44/.test(r.reason); })());
  check('半截文件（RIFF 头正确但没写完）被拒', (() => {
    const r = inspectWav(wav.buffer.subarray(0, 40));
    return r.ok === false;
  })());
  check('位深不是 16 位时给出警告而不是拒绝', (() => {
    const b = Buffer.concat([buildWavHeader({ dataBytes: 8000, bitsPerSample: 8 }), Buffer.alloc(8000)]);
    const r = inspectWav(b);
    return r.ok === true && /8 位/.test(r.warning);
  })());
  check('data 块长度为 0 时被拒（空录音）', (() => {
    const b = Buffer.concat([buildWavHeader({ dataBytes: 0 }), Buffer.alloc(0)]);
    const r = inspectWav(b);
    return r.ok === false && /没有音频数据/.test(r.reason);
  })(), inspectWav(Buffer.concat([buildWavHeader({ dataBytes: 0 })])).reason);
  check('压缩编码（audioFormat != 1）被拒并说清是编码问题', (() => {
    const b = Buffer.concat([buildWavHeader({ dataBytes: 1600 }), Buffer.alloc(1600)]);
    b.writeUInt16LE(7, 20);   // 7 = μ-law
    const r = inspectWav(b);
    return r.ok === false && /PCM/.test(r.reason);
  })());

  // 前端生成的 WAV 必须和后端解析器是同一套约定 —— 这里做一个"跨端契约"校验：
  // public/js/voice.js 里 encodeWav 写的头，字段位置必须和这里读的一致。
  console.log('\nC. 与前端约定的一致性');
  const voiceSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'voice.js'), 'utf8');
  check('voice.js 里写的是 16kHz / 单声道 / 16-bit（与后端同一个约定）',
    /TARGET_RATE = 16000/.test(voiceSrc) && /setUint16\(22, 1, true\)/.test(voiceSrc) && /setUint16\(34, 16, true\)/.test(voiceSrc));
  check('voice.js 导出 window.WenlvVoice 且带 isSupported/start/stop/cancel',
    /global\.WenlvVoice\s*=/.test(voiceSrc)
    && ['isSupported', 'start', 'stop', 'cancel'].every(k => new RegExp(`${k}\\s*:`).test(voiceSrc)));
  check('voice.js 用的是 MediaRecorder + AudioContext 解码（而不是直接求 audio/wav）',
    /MediaRecorder/.test(voiceSrc) && /decodeAudioData/.test(voiceSrc));
  check('voice.js 没有改动被冻结的 app.js（本测试不读 app.js，只确认文件仍在）',
    fs.existsSync(path.join(ROOT, 'public', 'js', 'app.js')));

  // 前后端字段名必须对得上。这条是**实际踩过的 bug**：app.js 去读
  // status.available / status.modelReady，而 quickStatus() 给的是 modelPresent，
  // 于是界面永远显示"环境不完整"，即使一切正常。
  const appSrc2 = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const quickKeys = Object.keys(createSTT({
    dir: os.tmpdir(), root: ROOT, prefs: makePrefs(path.join(os.tmpdir(), 'wenlv-stt-keys'), false),
  }).quickStatus());
  check('app.js 读的 STT 状态字段都真实存在（不是凭空写的）',
    ['enabled', 'modelPresent', 'language'].every(k => quickKeys.includes(k)),
    `quickStatus 实际给出：${quickKeys.join(', ')}`);
  check('app.js 用的是 modelPresent，而不是不存在的 modelReady/available',
    /S\.stt\.modelPresent/.test(appSrc2) && !/S\.stt\.modelReady/.test(appSrc2),
    'quickStatus 不做探测，所以它不可能知道 available；那两个字段只有 /api/stt/status 才有');
  check('app.js 里出现了麦克风按钮与听觉开关的接线',
    /btn-mic/.test(appSrc2) && /stt-enabled/.test(appSrc2) && /WenlvVoice/.test(appSrc2));

  // ================= D. 采样率转换 =================
  console.log('\nD. 采样率转换（downsamplePcm16）');
  const ramp = Int16Array.from({ length: 48000 }, (_, i) => i % 1000);
  const down = downsamplePcm16(ramp, 48000, 16000);
  check('48000 → 16000 后长度约为 1/3', Math.abs(down.length - 16000) <= 1, down.length);
  const same = downsamplePcm16(ramp, 16000, 16000);
  check('采样率相同时原样返回', same.length === ramp.length);
  const constSig = Int16Array.from({ length: 1600 }, () => 1234);
  const held = downsamplePcm16(constSig, 16000, 8000);
  check('常量信号降采样后仍然是同一个常量（没有引入偏移）',
    held.length === 800 && held.every(v => v === 1234), held[0]);

  // ================= E. base64 输入解析 =================
  console.log('\nE. base64 音频输入解析');
  const b64 = wav.buffer.toString('base64');
  check('裸 base64 能解析回原字节',
    decodeAudioInput(b64).ok && decodeAudioInput(b64).buffer.length === wav.buffer.length);
  check('data URL 形式（data:audio/wav;base64,...）能解析',
    decodeAudioInput(`data:audio/wav;base64,${b64}`).ok);
  check('带换行的 base64 能解析', decodeAudioInput(`${b64.slice(0, 40)}\n${b64.slice(40)}`).ok);
  check('空输入被拒', decodeAudioInput('').ok === false);
  check('非法 base64 被拒且说明原因',
    decodeAudioInput('这不是 base64！！').ok === false && /base64/.test(decodeAudioInput('这不是 base64！！').error));
  check('Buffer 直接可用', decodeAudioInput(wav.buffer).ok === true);

  // ================= F. 开关与失败路径（不碰真实环境） =================
  console.log('\nF. 开关与失败路径');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-stt-'));

  try {
    // ---- 关键用例：开关关闭时必须"什么都不做" ----
    const offPrefs = makePrefs(path.join(tmp, 'prefs-off'), false);
    const instOff = createSTT({ dir: tmp, modelDir: path.join(tmp, 'no-such-model'), root: path.join(tmp, 'no-such-root'), prefs: offPrefs });
    check('默认偏好就是关闭（不传 stt 时 enabled 为 false）',
      createPrefs({ dir: path.join(tmp, 'prefs-default') }).getConfig().stt.enabled === false);
    check('没传 prefs 时 isEnabled() 为 false（失败方向偏向"不录音"）',
      createSTT({ dir: tmp }).isEnabled() === false);

    const before = fs.readdirSync(instOff.tmpDir).length;
    const rOff = await instOff.transcribe(wav.buffer, {});
    check('关闭时 transcribe 返回 STT_DISABLED', rOff.ok === false && rOff.code === 'STT_DISABLED', `${rOff.code}: ${String(rOff.error).slice(0, 60)}`);
    check('关闭时的错误信息是中文且指向设置开关', /未启用/.test(rOff.error) && /设置/.test(rOff.error), rOff.error);
    check('关闭时没有产生任何临时文件（没做任何工作）',
      fs.readdirSync(instOff.tmpDir).length === before);
    const rOffPath = await instOff.transcribe(path.join(tmp, 'whatever.wav'), {});
    check('关闭时连"文件不存在"都不检查，直接返回未启用', rOffPath.code === 'STT_DISABLED');

    // ---- 打开之后的各种拒绝路径 ----
    const onPrefs = makePrefs(path.join(tmp, 'prefs-on'), true);
    const instOn = createSTT({ dir: tmp, modelDir: path.join(tmp, 'no-such-model'), root: path.join(tmp, 'no-such-root'), prefs: onPrefs });

    const rMissing = await instOn.transcribe(path.join(tmp, 'nope.wav'), {});
    check('音频文件不存在时给出中文错误（BAD_INPUT）',
      rMissing.ok === false && rMissing.code === 'BAD_INPUT' && /不存在/.test(rMissing.error), `${rMissing.code}: ${rMissing.error}`);

    const rEmpty = path.join(tmp, 'empty.wav');
    fs.writeFileSync(rEmpty, Buffer.alloc(0));
    const rEmptyRes = await instOn.transcribe(rEmpty, {});
    check('空文件被单独识别为"文件是空的"',
      rEmptyRes.ok === false && /空的/.test(rEmptyRes.error), rEmptyRes.error);

    const rBadFmt = await instOn.transcribe(Buffer.from('这不是 WAV，只是一段随便的字节'.repeat(10)), {});
    check('Buffer 不是 WAV 时给 BAD_FORMAT 并指明要传 WAV',
      rBadFmt.ok === false && rBadFmt.code === 'BAD_FORMAT' && /WAV/.test(rBadFmt.error), `${rBadFmt.code}: ${String(rBadFmt.error).slice(0, 80)}`);

    const rNoAudio = await instOn.transcribe(null, {});
    check('什么都没传时给 BAD_INPUT', rNoAudio.ok === false && rNoAudio.code === 'BAD_INPUT');

    // ---- 大小限制 ----
    const rTooBig = await instOn.transcribe(Buffer.alloc(MAX_BYTES + 1), {});
    check('超过 25MB 上限被拒（TOO_LARGE，中文说明带上两个数字）',
      rTooBig.ok === false && rTooBig.code === 'TOO_LARGE' && /25MB/.test(rTooBig.error), rTooBig.error);

    const bigPath = path.join(tmp, 'big.wav');
    fs.writeFileSync(bigPath, Buffer.alloc(MAX_BYTES + 1024));
    const rTooBig2 = await instOn.transcribe(bigPath, {});
    check('路径输入超限也被拒（不会先把文件读进内存再判断）',
      rTooBig2.ok === false && rTooBig2.code === 'TOO_LARGE');

    // ---- 环境缺失：必须点名缺哪一样 ----
    const rNoEnv = await instOn.transcribe(wav.buffer, {});
    check('环境缺失时给 STT_UNAVAILABLE 而不是笼统失败',
      rNoEnv.ok === false && rNoEnv.code === 'STT_UNAVAILABLE', `${rNoEnv.code}: ${String(rNoEnv.error).slice(0, 60)}`);
    check('原因里点名"缺少 Whisper 权重"并给出下载命令',
      /权重/.test(rNoEnv.error) && /fetch:whisper/.test(rNoEnv.error), String(rNoEnv.error).slice(0, 160));

    // 单独验"连 Python 都没有"这一条。要真的走到这个分支，得把**所有**能成功的
    // 候选都排除掉：本机 E:\AI\qwen-tts-webui\python 是硬编码候选，不这样设的话
    // 它一定会被找到，那验的就是另一条路了（第一版就是这么错的 —— 断言里写了
    // "原因里要点名 Python 环境"，而实际拿到的只有"缺权重"，测试红了一次才发现）。
    const noPyPrefs = makePrefs(path.join(tmp, 'prefs-nopy'), true);
    const instNoPy = createSTT({
      dir: tmp, modelDir: path.join(tmp, 'no-such-model'), root: path.join(tmp, 'no-such-root'), prefs: noPyPrefs,
    });
    const savedPath = process.env.PATH;
    const savedWenlvPy = process.env.WENLV_PYTHON;
    let rNoPy;
    try {
      process.env.WENLV_PYTHON = path.join(tmp, 'no-such-python', 'python.exe');
      delete process.env.PATH;
      rNoPy = await instNoPy.transcribe(wav.buffer, {});
    } finally {
      if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
      if (savedWenlvPy === undefined) delete process.env.WENLV_PYTHON; else process.env.WENLV_PYTHON = savedWenlvPy;
    }

    // 「完全没有 Python」这条分支**没法靠环境构造**：Python 候选里有一条硬编码的
    // 本机路径（E:\AI\qwen-tts-webui\python），只要它还在就一定会被找到。
    // 所以真正的断言放在下面的纯函数上，这里只验"确实报了不可用 + 分条 + 带 detail"。
    if (/Python/.test(String(rNoPy.error))) {
      check('连 Python 都找不到时，原因里点名"没有可用的 Python 环境（需要 torch + transformers）"',
        rNoPy.code === 'STT_UNAVAILABLE' && /torch/.test(String(rNoPy.error)),
        String(rNoPy.error).replace(/\n/g, ' ').slice(0, 200));
    } else {
      skip('连 Python 都找不到时的报错文案',
        '本机存在可用的 Python 候选（硬编码路径），构造不出"完全没有 Python"的环境；改由下面的纯函数直接验证');
    }
    check('不可用时返回结构化错误码与可读说明',
      rNoPy.code === 'STT_UNAVAILABLE' && String(rNoPy.error).length > 10,
      `${rNoPy.code}: ${String(rNoPy.error).replace(/\n/g, ' ').slice(0, 160)}`);
    check('多条缺失用「；」分条列出（不糊成一团）',
      String(rNoPy.error).includes('；'), String(rNoPy.error).replace(/\n/g, ' ').slice(0, 200));
    check('探测失败时把依次试过的位置带在 detail 里（便于排查）',
      Array.isArray(rNoPy.detail) && rNoPy.detail.length > 0, JSON.stringify(rNoPy.detail).slice(0, 120));

    // 纯函数直接验证"什么都没有"和"只缺一样"的文案。
    // 这部分不依赖本机装了什么，因此在任何机器上结果都一样。
    const both = unavailableReason({ python: null, modelReady: false, modelDir: '/x' });
    check('Python 与权重都缺时，两条都报出来',
      /Python/.test(both) && /torch/.test(both) && /权重/.test(both) && both.includes('；'), both.slice(0, 120));
    check('两条缺失的先后顺序是「先 Python 后权重」',
      both.indexOf('Python') < both.indexOf('权重'),
      '反过来的话会误导用户先下 1GB 权重，下完依然跑不起来');
    const onlyPy = unavailableReason({ python: null, modelReady: true, modelDir: '/x' });
    check('只缺 Python 时不提权重', /Python/.test(onlyPy) && !/权重/.test(onlyPy), onlyPy);
    const onlyModel = unavailableReason({ python: '/usr/bin/python', modelReady: false, modelDir: '/x' });
    check('只缺权重时给出下载命令', /权重/.test(onlyModel) && /fetch:whisper/.test(onlyModel), onlyModel);
    check('什么都不缺时返回空串（available 的判据）',
      unavailableReason({ python: '/usr/bin/python', modelReady: true, modelDir: '/x' }) === '');

    const stOff = await instOn.status();
    check('status 里如实带上开关与权重就绪标志',
      stOff.enabled === true && stOff.modelReady === false && stOff.available === false,
      JSON.stringify({ e: stOff.enabled, m: stOff.modelReady, a: stOff.available }));
    check('status 带队列与上限信息（供前端显示）',
      typeof stOff.busy === 'boolean' && stOff.queued === 0 && stOff.maxBytes === MAX_BYTES);
    const quick = instOn.quickStatus();
    check('quickStatus 不探测环境也给出开关与权重（供 /api/status）',
      quick.enabled === true && quick.modelPresent === false && quick.modelDir === path.join(tmp, 'no-such-model'),
      JSON.stringify(quick));

    // ================= G. 并发保护 =================
    console.log('\nG. 并发保护（同一时刻只允许一个识别任务）');
    // 队列上限至少是 1（0 会让第二个请求必然被拒，与设计说明不符）
    check('队列上限 >= 1（第二个请求有得等，而不是必然被拒）', QUEUE_LIMIT >= 1, QUEUE_LIMIT);

    // 真的跑并发请求来验排队。
    //
    // 难点：真实 worker 在模型不完整时**失败得太快**（约 0.2 秒），第一个请求早就
    // 结束了，`quickStatus()` 抓不到 busy，`waitedMs` 也永远是 0 —— 那样"排队"
    // 这条路径根本没被执行到，测试等于没测。
    //
    // 所以这里显式注入一个**假的 python**：它直接转调真 venv 的 python，但在转调
    // worker 之前故意 sleep 几秒。环境探测（-c "import torch, transformers"）也照常
    // 交给真 python（把 import 手写一遍会和 venv 状态耦合，不如转发）。
    // 于是"一次识别"稳定地占用约 3 秒，足以让我们观察第二个请求的去向。
    const fakeModel = path.join(tmp, 'fake-model');
    fs.mkdirSync(fakeModel, { recursive: true });
    fs.writeFileSync(path.join(fakeModel, 'model.safetensors'), Buffer.alloc(64));

    const fakePy = path.join(tmp, 'slow-python.py');
    fs.writeFileSync(fakePy, [
      '# -*- coding: utf-8 -*-',
      '# 测试替身：转发给真 python，但跑 worker 前先慢 3 秒（用来观察排队行为）',
      'import subprocess, sys, time',
      'REAL = r"' + PY + '"',
      'if "-c" in sys.argv[1:2] + sys.argv[1:3]:',
      '    sys.exit(subprocess.call([REAL] + sys.argv[1:]))',
      'time.sleep(3)',
      'sys.exit(subprocess.call([REAL] + sys.argv[1:]))',
    ].join('\n'), 'utf8');

    if (!fs.existsSync(PY)) {
      skip('并发保护的真实排队行为', '项目 venv 不存在（tools/py/Scripts/python.exe）');
    } else if (!REAL) {
      // 这一段会真的转发给 venv 的 python 并载入模型，默认不跑（原因见 REAL 的注释）
      skip('并发保护的真实排队行为', '默认跳过（要起 Python 载模型）；设 STT_REAL=1 可开');
    } else {
      const qDir = path.join(tmp, 'queue-run');
      // 偏好里的语言故意写成 en，再用 opts.language='zh' 覆盖，
      // 这样"语言"这条断言不依赖偏好文件的内容。
      const instQ = createSTT({ dir: qDir, modelDir: fakeModel, root: ROOT, prefs: makePrefs(path.join(tmp, 'prefs-q'), true, 'en') });
      instQ.probe = () => Promise.resolve({
        available: true, python: fakePy, modelDir: fakeModel, modelReady: true, reason: '', tried: [],
      });

      // 先确认这个替身真的能跑起来（否则下面的断言会全部指向"环境不可用"）
      const probeCheck = spawnSync(PY, [fakePy, '-c', 'import torch, transformers; print("ok")'], { encoding: 'utf8', timeout: 120000 });
      check('（前置）测试用的慢速 python 替身可以转发 -c 探测',
        probeCheck.status === 0 && /ok/.test(String(probeCheck.stdout)), String(probeCheck.stderr).slice(-160));

      // ---- (1) 两个并发：一个占位，一个排队 ----
      const p1 = instQ.transcribe(wav.buffer, { language: 'zh' });
      const p2 = instQ.transcribe(wav.buffer, { language: 'zh' });
      // 这两个 Promise 前面有几段同步代码（写临时文件、读 WAV 头），要让出事件循环
      // 才会走到 acquireSlot。1 秒足够 —— 替身光是启动 python 就要几百毫秒。
      await new Promise(r => setTimeout(r, 1000));
      const stBusy = instQ.quickStatus();
      check('第一个识别在跑时 quickStatus 报 busy、第二个已进队列',
        stBusy.busy === true && stBusy.queued === 1,
        JSON.stringify({ busy: stBusy.busy, queued: stBusy.queued }));

      const [r1, r2] = await Promise.all([p1, p2]);
      check('两个并发请求都返回结构化结果（不抛异常、不互相踩）',
        r1.ok === false && r2.ok === false
        && typeof r1.code === 'string' && typeof r2.code === 'string',
        JSON.stringify({ code1: r1.code, code2: r2.code }));
      check('第一个请求没有被排队（waitedMs 为 0）', r1.waitedMs === 0, `waitedMs=${r1.waitedMs}`);
      check('第二个请求是排队等到的（waitedMs > 1s），不是被直接拒绝',
        r2.waitedMs > 1000, `waitedMs=${r2.waitedMs} code=${r2.code}`);
      check('失败路径也带 waitedMs/elapsedMs（否则界面上看不出"等了很久才失败"）',
        Number.isFinite(r2.waitedMs) && Number.isFinite(r2.elapsedMs) && r2.elapsedMs >= r2.waitedMs,
        JSON.stringify({ waitedMs: r2.waitedMs, elapsedMs: r2.elapsedMs }));
      check('两个请求都真的走到了 worker（报的是模型加载失败，不是格式/开关错误）',
        /模型|STT_FAILED/.test(String(r1.error)) && /模型|STT_FAILED/.test(String(r2.error)),
        `${String(r1.error).slice(0, 70)} | ${String(r2.error).slice(0, 70)}`);
      check('错误信息里的中文没有变成乱码（子进程 stdio 强制 UTF-8）',
        !/\ufffd/.test(String(r1.error)) && /模型/.test(String(r1.error)),
        String(r1.error).slice(0, 70));
      check('两个都跑完后队列清空、busy 归位',
        instQ.quickStatus().busy === false && instQ.quickStatus().queued === 0,
        JSON.stringify(instQ.quickStatus()));
      check('临时文件在请求结束后都被删掉了（失败路径也要删）',
        fs.readdirSync(instQ.tmpDir).filter(f => f.startsWith('in-')).length === 0,
        fs.readdirSync(instQ.tmpDir).join(','));

      // ---- (2) 队列满了要明确拒绝，而不是无限堆积（每个等待项最多持有一个 25MB Buffer）----
      // 发 QUEUE_LIMIT+2 个：第 1 个占位、接下来 QUEUE_LIMIT 个进队列、再多的必须被拒。
      const many = [];
      for (let i = 0; i < QUEUE_LIMIT + 2; i++) many.push(instQ.transcribe(wav.buffer, {}));
      await new Promise(r => setTimeout(r, 1000));
      const stFull = instQ.quickStatus();
      check(`队列被塞满时 busy 且 queued 恰好等于上限（${QUEUE_LIMIT}）`,
        stFull.busy === true && stFull.queued === QUEUE_LIMIT, JSON.stringify(stFull));
      const results = await Promise.all(many);
      const busyCount = results.filter(r => r.code === 'BUSY').length;
      check(`并发超过「1 个在跑 + ${QUEUE_LIMIT} 个排队」时，多余的请求被明确拒绝为 BUSY`,
        busyCount >= 1, results.map(r => r.code).join(','));
      check('被拒绝的那条带上中文说明与建议',
        results.some(r => r.code === 'BUSY' && /正忙/.test(r.error) && /再试/.test(r.error)),
        String((results.find(r => r.code === 'BUSY') || {}).error || '').slice(0, 140));
    }

    // ================= H. 临时文件清理 =================
    console.log('\nH. 临时文件清理');
    const leftoverDir = instOn.tmpDir;
    fs.writeFileSync(path.join(leftoverDir, 'in-stale-1.wav'), Buffer.alloc(100));
    fs.writeFileSync(path.join(leftoverDir, 'in-stale-2.wav'), Buffer.alloc(100));
    fs.writeFileSync(path.join(leftoverDir, 'keep-me.txt'), 'x');
    check('cleanupTmp 清掉遗留的 in-*.wav', instOn.cleanupTmp() === 2);
    check('cleanupTmp 不碰其它文件', fs.existsSync(path.join(leftoverDir, 'keep-me.txt')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ================= I. worker 的命令行契约（用真 Python，缺权重也应该说清楚） =================
  console.log('\nI. worker 命令行契约（不需要模型权重）');
  if (!fs.existsSync(PY)) {
    skip('worker 命令行契约', '项目 venv 不存在');
  } else {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-stt-py-'));
    // 直接 spawn python 时也要显式要 UTF-8：Windows 上 Python 的 stdout 默认按系统
    // ANSI 代码页（GBK）编码，Node 按 UTF-8 解出来就是乱码，断言会全部失败 ——
    // 而这条契约（中文错误信息）正是本测试要钉的东西。lib/stt.js 里做的是同一件事。
    const pyEnv = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
    const runPy = (args) => spawnSync(PY, args, { encoding: 'utf8', timeout: 120000, env: pyEnv });
    try {
      const missing = runPy([WORKER, '--model', path.join(t, 'nope'), '--input', path.join(t, 'nope.wav'), '--json']);
      let payload = null;
      try { payload = JSON.parse(String(missing.stdout).trim().split('\n').filter(Boolean).pop() || ''); } catch { /* 下面断言失败 */ }
      check('模型目录不存在时输出一行结构化 JSON（而不是栈）', Boolean(payload) && payload.ok === false,
        String(missing.stdout).slice(0, 120) || String(missing.stderr).slice(-160));
      check('错误信息是中文且带上"npm run fetch:whisper"这条可操作指令',
        Boolean(payload) && /模型目录不存在/.test(payload.error) && /fetch:whisper/.test(payload.error),
        payload ? payload.error.replace(/\n/g, ' ').slice(0, 160) : '(无 JSON)');
      check('退出码非零（约定 2 = 模型不可用）', missing.status === 2, String(missing.status));
      check('机器可读的 code 字段是 NO_MODEL_DIR', Boolean(payload) && payload.code === 'NO_MODEL_DIR', payload && payload.code);

      // 模型目录在、但里面没有权重 → 应该报"下载可能中断了"，而不是"目录不存在"
      const emptyModel = path.join(t, 'empty-model');
      fs.mkdirSync(emptyModel, { recursive: true });
      const noWeights = runPy([WORKER, '--model', emptyModel, '--input', path.join(t, 'nope.wav'), '--json']);
      let p2 = null;
      try { p2 = JSON.parse(String(noWeights.stdout).trim().split('\n').filter(Boolean).pop() || ''); } catch { /* 忽略 */ }
      check('目录在但缺权重时，提示是"权重文件缺失 + 重新下载"而不是"目录不存在"',
        Boolean(p2) && p2.code === 'NO_MODEL_WEIGHTS' && /重新运行/.test(p2.error),
        p2 ? String(p2.error).replace(/\n/g, ' ').slice(0, 160) : '(无 JSON)');
    } finally {
      fs.rmSync(t, { recursive: true, force: true });
    }
  }

  // ================= J. 真实环境与端到端（权重存在才测） =================
  console.log('\nJ. 真实环境（存在才测，缺了就跳过）');
  const realTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-stt-real-'));
  const realPrefs = makePrefs(path.join(realTmp, 'prefs'), true);
  const real = createSTT({ dir: realTmp, root: ROOT, prefs: realPrefs });

  if (!real.isModelPresent()) {
    skip('真实环境探测', '本机没有 Whisper 权重（npm run fetch:whisper）');
    skip('端到端真实识别', '同上，没有权重');
  } else if (!REAL) {
    // 权重在，但 status() 会起一次 Python（import torch 就要十几秒），默认不跑
    skip('真实环境探测', '权重已就绪，但默认跳过（要起 Python；设 STT_REAL=1 可验）');
    skip('端到端真实识别', '默认跳过；设 STT_REAL=1 STT_E2E=1 可开');
  } else {
    const env = await real.status();
    check('本机 Whisper 环境可用（Python + 权重都齐）', env.available === true, env.reason);
    if (env.available) {
      check('探测到的 Python 存在', fs.existsSync(env.python), String(env.python));
      check('权重目录里确实有 model.safetensors',
        fs.existsSync(path.join(real.modelDir, 'model.safetensors')));

      if (process.env.STT_E2E === '1') {
        // 夹具：1.2 秒 16kHz 单声道正弦波。**不断言识别出的文字** —— 静音/纯音调
        // 会被识别成什么是不可预测的（常见空串，也可能是一句固定客套话），
        // 断言文字内容等于给未来的自己埋一个随机失败的测试。
        const fixture = makeTestWav(1.2, 440);
        const t0 = Date.now();
        const r = await real.transcribe(fixture.buffer, { language: 'zh', timeoutMs: 600000 });
        const secs = ((Date.now() - t0) / 1000).toFixed(1);
        check('端到端识别不崩且返回 ok', r.ok === true, r.ok ? '' : `${r.code}: ${String(r.error).slice(0, 200)}`);
        if (r.ok) {
          check('返回结构完整（text/language/durationMs/device/decoder）',
            typeof r.text === 'string' && typeof r.language === 'string'
            && Number.isFinite(r.durationMs) && typeof r.device === 'string' && typeof r.decoder === 'string',
            JSON.stringify({ text: r.text.slice(0, 40), lang: r.language, ms: r.durationMs, dev: r.device, dec: r.decoder }));
          check('时长与夹具大致吻合（1.2 秒）', Math.abs(r.durationMs - 1200) < 200, r.durationMs);
          check('跑在 GPU 或 CPU 上都行，但必须自报设备',
            ['cuda', 'cpu'].includes(r.device), r.device);
          // 走显存失败自动回退时 deviceFallback 有值，这是设计里要求的，不是错误
          console.log(`      （真实识别耗时 ${secs}s，设备 ${r.device}，解码器 ${r.decoder}`
            + `${r.deviceFallback ? `，回退说明：${r.deviceFallback}` : ''}）`);
          console.log(`      （识别出的文字：${JSON.stringify(r.text)} —— 不断言内容，静音/音调的识别结果本就不可预测）`);
        }
      } else {
        skip('端到端真实识别', '默认跳过（要起 Python 载 1GB 模型，几十秒）；设 STT_E2E=1 可开');
      }
    }
  }
  fs.rmSync(realTmp, { recursive: true, force: true });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败${skipped.length ? ` / ${skipped.length} 跳过` : ''}`);
  if (skipped.length) console.log(`跳过的项：${skipped.join('、')}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试自身出错：', e);
  process.exitCode = 1;
});
