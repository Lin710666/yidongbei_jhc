/**
 * voice.js —— 浏览器侧录音（听觉模块的前端一半）
 *
 * 单独成文件而不是塞进 app.js：app.js 正由另一个人同时改，写进去必冲突。
 * 这里只依赖浏览器标准 API，暴露一个 window.WenlvVoice，app.js 想接的时候
 * 调几下就行（用法见文件末尾的注释）。
 *
 * ## 为什么录完还要在前端转一遍 WAV
 *
 * MediaRecorder 在各家浏览器上能录出来的格式只有 webm/opus（Chrome/Edge）和
 * ogg/opus（Firefox）。想要 WAV 就得用 `MediaRecorder.isTypeSupported('audio/wav')`
 * —— 实测 Chrome/Edge/Firefox **都说 false**，这条路走不通。
 *
 * 后端的换法有两条：装 ffmpeg 解码，或者让 Python 侧用 soundfile/librosa 解 ——
 * 但 soundfile 走 libsndfile，根本不认 webm/opus。也就是说"录 webm 直接传"
 * 会把 ffmpeg 变成硬依赖，而这台机器上不保证有 ffmpeg（见 tools/stt-worker.py 头注释）。
 *
 * 于是选择：**录音仍然用 MediaRecorder（它是唯一稳定的录音入口），录完立刻在
 * 浏览器里用 AudioContext 解码成 PCM、重采样到 16kHz、写成 16-bit 单声道 WAV。**
 * 好处是三重的：
 *   · 后端只需要读 WAV，Python 内置 wave 模块就够，零外部可执行文件依赖；
 *   · 上传体积反而更小、更可控（16kHz×16bit×单声道 = 32KB/秒，1 分钟约 1.9MB）；
 *   · Whisper 要的就是 16kHz 单声道，转换发生在前端意味着后端拿到即可用。
 *
 * 代价是多花约几十毫秒的解码时间，以及这里的重采样代码必须写对 —— 所以下面的
 * encodeWav / resample 都按"能单独拿出来验算"的方式写成纯函数。
 */

(function (global) {
  'use strict';

  /** Whisper 只认 16kHz。与 tools/stt-worker.py、lib/stt.js 里的常量是同一个数。 */
  var TARGET_RATE = 16000;

  /** 单次录音上限。16kHz/16bit/单声道下 120 秒约 3.8MB，也够说清楚一段需求了。 */
  var MAX_SECONDS = 120;

  // ===== 纯函数区（不碰任何浏览器 API，可单独验算）=====

  /**
   * 把 AudioBuffer 或裸 Float32 声道数据合成为单声道。
   * 多声道按**等权平均**而不是"只取左声道"：手机/耳麦经常只有一个声道有声音，
   * 取左声道会得到一段静音，而平均至少不会全丢。
   */
  function mixToMono(channels) {
    if (!channels || !channels.length) return new Float32Array(0);
    if (channels.length === 1) return channels[0];
    var len = channels[0].length;
    var out = new Float32Array(len);
    for (var c = 0; c < channels.length; c++) {
      var src = channels[c];
      for (var i = 0; i < len; i++) out[i] += src[i] || 0;
    }
    for (var j = 0; j < len; j++) out[j] /= channels.length;
    return out;
  }

  /**
   * 重采样到 targetRate。用加窗 sinc 插值。
   *
   * 为什么不用"最近邻/线性插值"：降采样时不做低通会把 8kHz 以上的能量折叠回
   * 可听频段（混叠），语音听起来像加了金属噪声 —— 人耳勉强能懂，识别率会掉。
   * 加窗 sinc 在降采样时把 cutoff 压到目标奈奎斯特以下，等于自带抗混叠。
   *
   * 性能上不是问题：一次录音最多几分钟，采样点百万级，纯 JS 几十毫秒量级。
   *
   * @param {Float32Array} input
   * @param {number} fromRate
   * @param {number} [targetRate]
   */
  function resample(input, fromRate, targetRate) {
    var to = targetRate || TARGET_RATE;
    if (!input || !input.length) return new Float32Array(0);
    if (fromRate === to) return input;

    var ratio = to / fromRate;
    var outLen = Math.max(1, Math.round(input.length * ratio));
    var out = new Float32Array(outLen);
    // 降采样时 cutoff 取目标奈奎斯特的 0.95，留一点过渡带；升采样时不截断。
    var cutoff = Math.min(1, ratio) * 0.95;
    var halfWidth = 16;                 // sinc 窗口半宽（采样点）。16 足够，再大只是更慢
    var step = fromRate / to;           // 每个输出点对应的输入步长

    for (var i = 0; i < outLen; i++) {
      var center = i * step;
      var left = Math.max(0, Math.ceil(center - halfWidth));
      var right = Math.min(input.length - 1, Math.floor(center + halfWidth));
      var acc = 0;
      var wsum = 0;
      for (var j = left; j <= right; j++) {
        var x = (center - j) * cutoff;
        // sinc(x) = sin(pi x)/(pi x)，x=0 时取 1
        var s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        // Blackman 窗：旁瓣比 Hann 更低，对语音这种动态范围大的信号更合适
        var t = (j - center) / halfWidth;
        var w = Math.abs(t) >= 1 ? 0
          : 0.42 + 0.5 * Math.cos(Math.PI * t) + 0.08 * Math.cos(2 * Math.PI * t);
        var weight = s * w;
        acc += (input[j] || 0) * weight;
        wsum += weight;
      }
      // 除以权重和做归一化：否则边界处（有效采样点少）会整体变小，听上去一顿一顿的
      out[i] = wsum !== 0 ? acc / wsum : 0;
    }
    return out;
  }

  /** Float32(-1~1) → 16-bit 小端 PCM。超出范围要钳位，否则写进去会回绕成反相的大噪声。 */
  function floatTo16BitPCM(samples) {
    var out = new Int16Array(samples.length);
    for (var i = 0; i < samples.length; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
    }
    return out;
  }

  /**
   * 拼一个标准的 44 字节 WAV 头 + PCM 数据。
   * 全部小端（WAV 规范如此）；字节率与块对齐按规范算出来，不要写死 ——
   * 写错这两个字段时，有些解码器会当成坏文件。
   */
  function encodeWav(pcm, sampleRate) {
    var rate = sampleRate || TARGET_RATE;
    var dataBytes = pcm.length * 2;
    var buf = new ArrayBuffer(44 + dataBytes);
    var view = new DataView(buf);
    function writeStr(off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);          // fmt 块长度
    view.setUint16(20, 1, true);           // 1 = 未压缩 PCM
    view.setUint16(22, 1, true);           // 单声道
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);    // 字节率 = 采样率 × 声道 × 位深/8
    view.setUint16(32, 2, true);           // 块对齐 = 声道 × 位深/8
    view.setUint16(34, 16, true);          // 位深
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);

    // 数据直接写进同一个 ArrayBuffer（偏移 44 之后），不需要再单独拿一个 Uint8Array 视图
    for (var i = 0; i < pcm.length; i++) {
      view.setInt16(44 + i * 2, pcm[i], true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  /**
   * 任意音频 Blob → 16kHz 单声道 16-bit WAV Blob。
   * 这是整个模块的核心：MediaRecorder 的产物（webm/opus）在这里被浏览器解码，
   * 后续后端就只面对 WAV 了。
   */
  function blobToWav(blob) {
    var Ctx = global.AudioContext || global.webkitAudioContext;
    if (!Ctx) return Promise.reject(new Error('浏览器不支持 AudioContext，无法把录音转成 WAV'));
    return blob.arrayBuffer().then(function (ab) {
      var ctx = new Ctx();
      return new Promise(function (resolve, reject) {
        // 只让先到的那个回调生效：下面两种写法在不同实现里可能**都被调用**
        // （回调形式 + 返回 Promise 形式），不设闸门会导致 ctx.close() 被调两次，
        // 第二次在部分实现上会抛 InvalidStateError 并把它变成 unhandled rejection。
        var settled = false;
        function done(audioBuffer) {
          if (settled) return;
          settled = true;
          try { resolve(audioBuffer); } finally { if (ctx.close) ctx.close(); }
        }
        function bad(e) {
          if (settled) return;
          settled = true;
          if (ctx.close) ctx.close();
          reject(e || new Error('音频解码失败'));
        }
        // 老写法（回调式）兼容性最好：Safari 长期只支持这个形式
        var ret = ctx.decodeAudioData(ab, done, bad);
        // 少数实现（含部分新版 Safari）只返回 Promise 而不调回调
        if (ret && typeof ret.then === 'function') ret.then(done, bad);
      });
    }).then(function (audioBuffer) {
      var raw = [];
      for (var c = 0; c < audioBuffer.numberOfChannels; c++) raw.push(audioBuffer.getChannelData(c));
      // getChannelData 返回的是内部缓冲的引用，而下面要重采样成新数组，不会再读它，
      // 所以这里不必复制一份（复制一分钟音频要多占几 MB）。
      var mono = mixToMono(raw);
      var resampled = resample(mono, audioBuffer.sampleRate, TARGET_RATE);
      return encodeWav(floatTo16BitPCM(resampled), TARGET_RATE);
    });
  }

  // ===== 录音状态机 =====

  var state = 'idle';        // idle | recording | converting
  var listeners = [];
  var session = null;        // { stream, recorder, chunks, chunksBytes, startedAt, cancelled, result }

  function emit(type, detail) {
    var evt = { type: type, state: state, detail: detail || null };
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](evt); } catch (e) { /* 订阅者的错不该影响录音 */ }
    }
  }

  function setState(s) {
    if (state === s) return;
    state = s;
    emit('state');
  }

  function isSupported() {
    return Boolean(
      global.navigator
      && global.navigator.mediaDevices
      && typeof global.navigator.mediaDevices.getUserMedia === 'function'
      && typeof global.MediaRecorder === 'function'
      && (global.AudioContext || global.webkitAudioContext)
    );
  }

  /** 挑一个浏览器真的支持的录音 mimeType。全都报不支持时返回 '' 交给浏览器自己选。 */
  function pickMimeType() {
    var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    if (typeof global.MediaRecorder === 'undefined' || !global.MediaRecorder.isTypeSupported) return '';
    for (var i = 0; i < candidates.length; i++) {
      try { if (global.MediaRecorder.isTypeSupported(candidates[i])) return candidates[i]; } catch (e) { /* 忽略 */ }
    }
    return '';
  }

  /**
   * 开始录音。返回 Promise，等麦克风真的拿到手（浏览器授权弹窗走完）才 resolve。
   * 为什么要等：如果立刻返回，调用方会以为"已经在录了"，而用户可能还在点允许，
   * 前面几秒的话就丢了。
   */
  function start() {
    if (state === 'recording') return Promise.reject(new Error('已经在录音了'));
    if (!isSupported()) {
      return Promise.reject(new Error('这个浏览器不支持录音（需要 HTTPS 或 localhost 下的麦克风权限）'));
    }
    return global.navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,          // 直接要单声道；转 WAV 时还要混音，这一步能省不少事
        echoCancellation: true,   // 开回音消除：笔记本外放时能显著减少把喇叭里的声音录进来
        noiseSuppression: true,
        autoGainControl: true,
      },
    }).then(function (stream) {
      var mimeType = pickMimeType();
      var recorder;
      try {
        recorder = mimeType ? new global.MediaRecorder(stream, { mimeType: mimeType })
          : new global.MediaRecorder(stream);
      } catch (e) {
        stopTracks(stream);
        throw new Error('无法创建录音器：' + (e && e.message ? e.message : e));
      }
      session = {
        stream: stream,
        recorder: recorder,
        chunks: [],
        chunksBytes: 0,
        startedAt: Date.now(),
        cancelled: false,
        result: null,
        mimeType: mimeType || (recorder.mimeType || 'audio/webm'),
      };

      recorder.ondataavailable = function (e) {
        if (e.data && e.data.size) {
          session.chunks.push(e.data);
          session.chunksBytes += e.data.size;
        }
      };
      recorder.onerror = function (e) {
        emit('error', (e && e.error) || e);
      };
      // 到上限自动停：与其让用户录 10 分钟然后上传被后端拒掉，不如在这里就截断
      session.timer = global.setTimeout(function () {
        emit('notice', { code: 'MAX_SECONDS', seconds: MAX_SECONDS });
        if (state === 'recording') stop().catch(function () { /* 忽略 */ });
      }, MAX_SECONDS * 1000);

      recorder.start(1000);   // 每 1 秒切一个 chunk：中途崩溃最多丢 1 秒，而不是整段
      setState('recording');
      emit('start', { mimeType: session.mimeType });
      return { mimeType: session.mimeType, maxSeconds: MAX_SECONDS };
    });
  }

  function stopTracks(stream) {
    try {
      var tracks = stream.getTracks ? stream.getTracks() : [];
      for (var i = 0; i < tracks.length; i++) tracks[i].stop();
    } catch (e) { /* 忽略 */ }
  }

  /** 收尾：清 timer、关麦克风。返回本次 session（cancel 与 stop 共用）。 */
  function teardown() {
    var s = session;
    if (!s) return null;
    if (s.timer) { global.clearTimeout(s.timer); s.timer = null; }
    stopTracks(s.stream);
    return s;
  }

  /**
   * 停止录音。返回 Promise<Blob>（16kHz 单声道 16-bit WAV）。
   * 如果录音为空，reject 一个说人话的错误 —— 交给调用方弹提示，而不是回一个 0 字节 Blob。
   */
  function stop() {
    if (!session || state === 'idle') return Promise.reject(new Error('当前没有在录音'));
    if (session.result) return session.result;      // 重复调用 stop 时返回同一个 Promise

    var s = session;
    var p = new Promise(function (resolve, reject) {
      function finish() {
        var raw = new Blob(s.chunks, { type: s.mimeType });
        if (!raw.size) {
          setState('idle');
          session = null;
          reject(new Error('没有录到任何声音（可能是麦克风被静音，或允许得太晚）'));
          return;
        }
        setState('converting');
        emit('converting', { bytes: raw.size });
        blobToWav(raw).then(function (wav) {
          s.timer = null;
          if (s.cancelled) {
            setState('idle');
            session = null;
            reject(new Error('录音已取消'));
            return;
          }
          setState('idle');
          session = null;
          emit('stop', { bytes: wav.size, mimeType: 'audio/wav' });
          resolve(wav);
        }, function (e) {
          setState('idle');
          session = null;
          reject(new Error('把录音转成 WAV 失败：' + (e && e.message ? e.message : e)));
        });
      }

      try {
        if (s.recorder.state === 'inactive') { teardown(); finish(); return; }
        // onstop 之后 ondataavailable 才会把最后一段交出来，所以 finish 必须挂在 onstop 上
        s.recorder.onstop = function () { teardown(); finish(); };
        s.recorder.stop();
        // 兜底：个别实现不派发 onstop（或派发得很晚），2 秒后自己收尾，
        // 免得界面永远停在"正在识别中"。
        global.setTimeout(function () {
          if (s.recorder.state === 'inactive' && session === s && state !== 'idle') {
            teardown();
            finish();
          }
        }, 2000);
      } catch (e) {
        teardown();
        setState('idle');
        session = null;
        reject(new Error('停止录音失败：' + (e && e.message ? e.message : e)));
      }
    });
    s.result = p;
    return p;
  }

  /** 取消：关掉麦克风、丢掉数据，不产生 Blob，也不报错给用户。 */
  function cancel() {
    if (!session) return Promise.resolve(false);
    var s = session;
    s.cancelled = true;
    try { if (s.recorder.state !== 'inactive') s.recorder.stop(); } catch (e) { /* 忽略 */ }
    teardown();
    setState('idle');
    session = null;
    // 如果已经有一个 stop() 的 Promise 在飞，它会在 finish 里看到 cancelled 并 reject；
    // 那个 reject 由调用方处理（通常是 catch 后忽略）。这里同步返回，不等它。
    return Promise.resolve(true);
  }

  // ===== 后端对接（可选，不强制使用）=====

  /**
   * 把 WAV Blob POST 给 /api/stt。
   * 用 base64 + JSON 而不是 multipart/form-data：server.js 里现成的 readBody() 只解析
   * JSON，用它就不必在服务端再写一套 multipart 解析器（Node 内置没有），
   * 而且这和项目里图片、参考音频的传法完全一致。
   */
  function transcribe(blob, opts) {
    var o = opts || {};
    return blob.arrayBuffer().then(function (ab) {
      var bytes = new Uint8Array(ab);
      var bin = '';
      // 分块拼字符串：一次 apply 几百万个参数会爆栈
      var CHUNK = 0x8000;
      for (var i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return global.fetch('/api/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: global.btoa(bin), language: o.language || undefined }),
      });
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok || !data || data.ok === false) {
          var err = new Error((data && data.error) || ('识别失败（HTTP ' + res.status + '）'));
          err.code = (data && data.code) || 'STT_FAILED';
          throw err;
        }
        return data;
      });
    });
  }

  /** 一次到位：录音结束后自动转写。返回 { blob, text, language, durationMs }。 */
  function recordOnce(opts) {
    var o = opts || {};
    return start().then(function () {
      return new Promise(function (resolve) {
        o.onRecording && o.onRecording();
        // 由调用方决定什么时候调 stop()；这里只在有 maxSeconds 时兜底
        if (o.maxSeconds) global.setTimeout(function () { resolve(); }, o.maxSeconds * 1000);
      });
    }).then(function () {
      return stop();
    }).then(function (blob) {
      return transcribe(blob, o).then(function (r) {
        return { blob: blob, text: r.text, language: r.language, durationMs: r.durationMs };
      });
    });
  }

  function getState() { return state; }
  function on(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  global.WenlvVoice = {
    // 开关与能力
    isSupported: isSupported,
    // 录音生命周期
    start: start,
    stop: stop,
    cancel: cancel,
    recordOnce: recordOnce,
    // 后端对接
    transcribe: transcribe,
    // 状态与事件
    getState: getState,
    on: on,
    // 纯函数（也导出，方便在控制台里验算或写测试）
    _internal: {
      mixToMono: mixToMono,
      resample: resample,
      floatTo16BitPCM: floatTo16BitPCM,
      encodeWav: encodeWav,
      blobToWav: blobToWav,
      pickMimeType: pickMimeType,
      TARGET_RATE: TARGET_RATE,
      MAX_SECONDS: MAX_SECONDS,
    },
  };
})(typeof window !== 'undefined' ? window : this);

/*
 * ===== app.js 该这样接（这段只是说明，不会执行）=====
 *
 * // 1) 设置面板里读开关状态：/api/status 的 stt.enabled
 * //    打开开关（向后兼容，lib/prefs.js 只认它认识的键）：
 * await fetch('/api/prefs', {
 *   method: 'PUT',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ stt: { enabled: true, language: 'zh' } }),
 * });
 *
 * // 2) 按住说话 / 点一下开始、再点一下结束
 * const btn = document.querySelector('#voiceBtn');
 * let recording = false;
 * btn.addEventListener('click', async () => {
 *   if (!WenlvVoice.isSupported()) return toast('这个浏览器不支持录音');
 *   if (!recording) {
 *     await WenlvVoice.start();
 *     recording = true;
 *     btn.classList.add('recording');
 *     return;
 *   }
 *   recording = false;
 *   btn.classList.remove('recording');
 *   try {
 *     const wav = await WenlvVoice.stop();          // Blob，已经是 16kHz 单声道 WAV
 *     const r = await WenlvVoice.transcribe(wav);   // 也可以直接把 wav 传给 /api/stt
 *     input.value = r.text;                        // 塞进输入框，让用户改完再发
 *     if (!r.text) toast('没听清，再说一次？');
 *   } catch (e) {
 *     toast(e.message);                            // 例如「听觉模块未启用…」
 *   }
 * });
 *
 * // 3) 想按 ESC 取消录音
 * document.addEventListener('keydown', (e) => {
 *   if (e.key === 'Escape' && WenlvVoice.getState() === 'recording') WenlvVoice.cancel();
 * });
 *
 * // 4) 也可以只用录音、自己上传（比如想复用已有的上传逻辑）：
 * //    const wav = await WenlvVoice.stop();
 * //    const b64 = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(wav); });
 * //    fetch('/api/stt', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ audio: b64 }) });
 */
