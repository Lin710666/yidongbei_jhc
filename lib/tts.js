/**
 * tts.js —— 本地语音合成（Qwen TTS WebUI）客户端
 *
 * 目标：把 airi 的"声音 / 语音输出"服务也变成纯本地服务 —— 不调用任何云端 TTS，
 * 直接用本机的 Qwen TTS WebUI（Gradio + Qwen3-TTS）出音频。
 *
 * 本机服务地址：http://127.0.0.1:7860
 * 启用方式：在 Qwen TTS WebUI 目录运行 `python launch.py --api`（或只跑 API：`--nowebui`）
 *
 * 三种合成模式，对应上游三个端点：
 *   custom-voice —— 用内置发音人 + 语气指令（默认走这条，最稳）
 *   voice-design —— 用自然语言"设计"音色，无需样本音频
 *   voice-clone  —— 上传参考音频克隆音色
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_URL = (process.env.QWEN_TTS_URL || 'http://127.0.0.1:7860').replace(/\/+$/, '');

/**
 * 内置说话人清单（Qwen3-TTS CustomVoice 模型自带的音色）。
 *
 * 为什么要把这张表写死在代码里：後端的 /qwenapi/v1/speakers 只会回一串
 * 英文 id（aiden / ono_anna / uncle_fu …），界面上没法用 —— 用户看到
 * "sohee" 根本不知道那是男是女、什么调门。这里补上中文名和实测基频。
 *
 * freq 是本机用同一句话（约 40 字，0.6B 模型）合成后，按 40ms 帧做自相关
 * 估计基频、取中位数得到的，只用来区分音区，不代表绝对音色：
 *   成年男声一般 85~155Hz，女声一般 165~255Hz。
 * 男女是按这个区间判的，不是猜的。
 */
const SPEAKER_LIBRARY = [
  { id: 'vivian',   name: '薇薇安',   gender: 'female', freq: 229, desc: '清亮女声，通用讲解' },
  { id: 'serena',   name: '瑟琳娜',   gender: 'female', freq: 229, desc: '沉稳女声，适合播报' },
  { id: 'sohee',    name: '昭熙',     gender: 'female', freq: 229, desc: '柔和女声，适合旁白' },
  { id: 'ono_anna', name: '小野安娜', gender: 'female', freq: 282, desc: '高亮少女音，最俏皮' },
  { id: 'uncle_fu', name: '付叔',     gender: 'male',   freq: 101, desc: '低沉男声，最厚重' },
  { id: 'ryan',     name: '瑞恩',     gender: 'male',   freq: 109, desc: '低男声' },
  { id: 'dylan',    name: '迪伦',     gender: 'male',   freq: 121, desc: '中低男声' },
  { id: 'eric',     name: '埃里克',   gender: 'male',   freq: 131, desc: '中男声' },
  { id: 'aiden',    name: '艾登',     gender: 'male',   freq: 136, desc: '男声，**这是后端的默认值**' },
];

/** 后端在 speaker 传 null 时会用它列表里的第一个 —— 也就是这个男声 */
const FALLBACK_SPEAKER = 'aiden';

/**
 * 默认语音（"初始语音"）：面向文旅讲解场景定的一个温和女声。
 *
 * ⚠️ 这里有个**很容易踩的坑**，之前就踩过：
 *   CustomVoice 模型下，决定"是谁在说话"的是 `speaker`（内置音色 id），
 *   `instruct` 只管**语气和节奏**，改不了说话人的性别和音色。
 *   所以只写 instruct、speaker 留空的话，后端会退回列表第一个音色 = aiden（男声），
 *   于是不管选哪个预设、instruct 写"年轻女声"还是"元气少女"，出来的都是同一个男声。
 *   —— 表现就是"音色怎么全都是男的"。speaker 必须一起给。
 */
const DEFAULT_VOICE = {
  id: 'wenlv-guide-female',
  name: '小文 · 温柔讲解',
  desc: '温柔亲切的年轻女声，语速稍慢、吐字清晰，适合景点讲解与行程播报',
  mode: 'custom-voice',
  speaker: 'vivian',
  instruct: '用温柔亲切的语气说话，语速稍慢、吐字清晰，语气自然不夸张，像在给游客做景点讲解。',
  language: 'Chinese',
  speedHint: '稍慢',
};

/** 预置音色库：不同场景换一个即可，全部本地生成 */
const VOICE_PRESETS = [
  DEFAULT_VOICE,
  {
    id: 'wenlv-guide-male',
    name: '阿杭 · 沉稳男声',
    desc: '沉稳温和的男声，适合文化历史类讲解',
    mode: 'custom-voice',
    speaker: 'uncle_fu',
    instruct: '用沉稳从容的语气说话，语速中等，像博物馆讲解员一样不紧不慢。',
    language: 'Chinese',
    speedHint: '中等',
  },
  {
    id: 'wenlv-sweet',
    name: '小游 · 元气少女',
    desc: '活泼元气的少女音，适合种草短视频口播',
    mode: 'custom-voice',
    speaker: 'ono_anna',
    instruct: '语调起伏明显、语速偏快，带一点俏皮的笑意，像在跟朋友兴奋地推荐好玩的地方。',
    language: 'Chinese',
    speedHint: '偏快',
  },
  {
    id: 'wenlv-marketing',
    name: '运营号 · 干练播报',
    desc: '干练清晰的播报腔，适合营销文案口播',
    mode: 'custom-voice',
    speaker: 'serena',
    instruct: '节奏明快、重点词加重，像电商直播里介绍产品一样利落。',
    language: 'Chinese',
    speedHint: '偏快',
  },
  {
    id: 'wenlv-gentle-slow',
    name: '静水 · 舒缓睡前',
    desc: '很慢很轻的旁白音，适合民宿/疗愈场景',
    mode: 'custom-voice',
    speaker: 'sohee',
    instruct: '非常轻柔舒缓，语速很慢，营造安静放松的氛围。',
    language: 'Chinese',
    speedHint: '很慢',
  },
];

function mkError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * 合成超时（毫秒）。
 *
 * 这个值和「单次最多合成多少字」是绑在一起的，不能单独调：
 * 本机实测实时率约 0.62 秒/字（0.6B 模型 + 8GB 显卡），synthesize() 里按 600 字封顶，
 * 也就是最坏情况约 370 秒。超时如果比这个小，长文本会在快跑完时被误杀成 504，
 * 前面几分钟全白等 —— 这是踩过的坑，所以这里留到 480 秒。
 *
 * 期间界面不是干等：前端会显示「语音正在生成本地音频…已等待 N 秒」。
 * 显存更小 / 模型更大的机器可以通过环境变量 QWEN_TTS_TIMEOUT 调大。
 */
const SYNTH_TIMEOUT = Number(process.env.QWEN_TTS_TIMEOUT || 480000);

function createTTS({ url = DEFAULT_URL, cacheDir, defaultVoice = DEFAULT_VOICE, timeout = SYNTH_TIMEOUT } = {}) {
  const base = url.replace(/\/+$/, '');
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });

  async function api(pathname, { method = 'GET', body, timeoutMs = 20000 } = {}) {
    let res;
    try {
      res = await fetch(`${base}${pathname}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError') throw mkError(`本地语音服务响应超时（${base}）`, 'TTS_TIMEOUT');
      throw mkError(
        `无法连接本地语音合成服务（${base}）。\n`
        + '请先启动 Qwen TTS WebUI 并开启 API：\n'
        + '  · 进入 Qwen TTS WebUI 目录，双击「启动.bat」，或\n'
        + '  · 命令行执行：python launch.py --api\n'
        + '  · 只跑 API 不要网页界面：python launch.py --nowebui\n'
        + `  · 如果改过端口，请设置环境变量 QWEN_TTS_URL（当前为 ${base}）`,
        'NO_TTS',
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw mkError(`语音服务返回 ${res.status}：${text.slice(0, 300)}`, 'TTS_ERROR');
    }
    return res.json();
  }

  async function models() {
    const data = await api('/qwenapi/v1/models');
    return data.models || [];
  }

  /**
   * 内置说话人清单：以后端实际支持的为准，和本地那张中文表合并。
   *
   * 以"后端"为准而不是以本地表为准，是因为换模型/升级 WebUI 之后音色列表会变，
   * 本地表只是补充中文名和实测音高；表里有、后端没有的会被过滤掉，
   * 免得界面列出一堆点了就报错的音色。
   */
  async function speakers() {
    let live = [];
    try {
      const data = await api('/qwenapi/v1/speakers');
      live = data.speakers || [];
    } catch {
      return SPEAKER_LIBRARY.slice();   // 后端连不上就退回本地表，界面至少不空
    }
    const byId = new Map(SPEAKER_LIBRARY.map(s => [s.id, s]));
    return live.map((id) => {
      const meta = byId.get(id);
      return meta ? { ...meta } : { id, name: id, gender: 'unknown', freq: null, desc: '后端提供的音色（本地没有它的资料）' };
    });
  }

  /**
   * 想固定用某个模型时设置环境变量 QWEN_TTS_MODEL，例如：
   *   set QWEN_TTS_MODEL=Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
   */
  const MODEL_OVERRIDE = String(process.env.QWEN_TTS_MODEL || '').trim();

  /** 从模型名里抠出参数量（1.7B → 1.7），用来比较谁更小 */
  function paramB(name) {
    const m = /(\d+(?:\.\d+)?)\s*B(?![a-z0-9])/i.exec(String(name));
    return m ? parseFloat(m[1]) : Infinity;
  }

  /**
   * 选模型。
   *
   * 这里和最初的版本有个关键不同：**在各类可用模型里挑体积最小的那个**，
   * 而不是优先挑"类型最对"的那个。
   *
   * 原因是本机（RTX 4060 Laptop，8GB 显存）跑不动「7B 对话模型 + 1.7B 语音模型」两套：
   * 对话模型常驻后只剩不到 3GB，1.7B 语音模型的权重会被 accelerate offload 到 CPU，
   * 生成时直接抛 `Tensor.item() cannot be called on meta tensors`，接口返回 500。
   * 而本机的 VoiceDesign 只有 1.7B 一档、没有 0.6B，所以「声音设计」类音色硬怼 1.7B
   * 必然失败 —— 这里让它退到 0.6B 的 CustomVoice，端点由 synthesize() 自动跟着切。
   *
   * 显存充裕的机器设 QWEN_TTS_MODEL 指定具体模型（例如 1.7B）即可换回来。
   */
  function pickModel(list, mode) {
    const names = list.map(m => m.name || m);
    if (!names.length) return null;
    if (MODEL_OVERRIDE) {
      const hit = names.find(n => n === MODEL_OVERRIDE)
        || names.find(n => String(n).toLowerCase() === MODEL_OVERRIDE.toLowerCase());
      if (hit) return hit;
    }
    const ofType = re => names.filter(n => re.test(n));
    /**
     * 合并若干候选池后取参数量最小的那个。参数量相同时保持传入顺序
     * （Array.sort 是稳定排序），所以池子排在前面的类型优先。
     */
    const smallestOf = (...pools) => {
      const all = pools.flat();
      if (!all.length) return names[0];
      return all.slice().sort((a, b) => paramB(a) - paramB(b))[0];
    };
    if (mode === 'voice-design') return smallestOf(ofType(/VoiceDesign/i), ofType(/CustomVoice/i));
    if (mode === 'voice-clone') return smallestOf(ofType(/Base/i), ofType(/CustomVoice/i));
    return smallestOf(ofType(/CustomVoice/i), ofType(/Base/i), ofType(/VoiceDesign/i));
  }

  async function status() {
    try {
      const list = await models();
      return {
        running: true,
        url: base,
        models: list.map(m => ({ name: m.name || String(m), type: m.type || '' })),
        defaultVoice,
      };
    } catch (e) {
      return { running: false, url: base, models: [], defaultVoice, error: String(e.message || e), code: e.code || 'NO_TTS' };
    }
  }

  /**
   * 合成语音。
   * @param {{text:string, voice?:object, mode?:string, speaker?:string, language?:string,
   *          refAudioBase64?:string, refText?:string, model?:string, useCache?:boolean}} opts
   * @returns {Promise<{buffer:Buffer, mime:string, cached:boolean, voice:object, model:string}>}
   */
  async function synthesize(opts = {}) {
    const text = String(opts.text || '').trim();
    if (!text) throw mkError('合成文本为空', 'BAD_INPUT');
    // 太长会显著拖慢生成并可能爆显存：截断到 600 字，超出部分由前端提示
    const clipped = text.length > 600 ? `${text.slice(0, 600)}……` : text;

    const voice = { ...defaultVoice, ...(opts.voice || {}) };
    const mode = opts.mode || voice.mode || 'custom-voice';

    // 缓存键覆盖所有会影响音色的字段，避免"换了音色还在放旧音频"。
    // refKey 是"我的音色"的 id —— 不带上它的话，换一个克隆音色还会命中上一个的缓存，
    // 听起来就是"换了没反应"。
    const key = crypto.createHash('sha1')
      .update(JSON.stringify([clipped, mode, voice.instruct, opts.speaker || voice.speaker, opts.language || voice.language, opts.model || '', opts.refText || '', opts.refKey || '']))
      .digest('hex').slice(0, 20);
    const cachePath = cacheDir ? path.join(cacheDir, `${key}.wav`) : null;

    if (cachePath && opts.useCache !== false && fs.existsSync(cachePath)) {
      return { buffer: fs.readFileSync(cachePath), mime: 'audio/wav', cached: true, voice, model: opts.model || '(cached)' };
    }

    const list = await models();
    const modelName = opts.model || pickModel(list, mode);
    if (!modelName) {
      throw mkError(
        '本地语音服务里没有可用模型。请在 Qwen TTS WebUI 界面里选择并下载一个模型后重试。',
        'NO_TTS_MODEL',
      );
    }

    let payload;
    let pathname;
    // 选出来的模型未必和请求的模式对得上：本机只有 1.7B 的 VoiceDesign，而显存只够
    // 跑 0.6B 的 CustomVoice。这种情况自动降到 custom-voice 端点（音色照样由 instruct
    // 描述决定），保证"能出声"，而不是把请求打成 500。
    let endpointMode = mode;
    if (mode === 'voice-design' && !/VoiceDesign/i.test(modelName)) endpointMode = 'custom-voice';
    if (mode === 'voice-clone' && !/Base/i.test(modelName)) endpointMode = 'custom-voice';

    if (endpointMode === 'voice-clone') {
      if (!opts.refAudioBase64) throw mkError('声音克隆需要提供参考音频', 'BAD_INPUT');
      pathname = '/qwenapi/v1/voice-clone';
      payload = {
        model_name: modelName,
        text: clipped,
        ref_audio_base64: opts.refAudioBase64,
        ref_text: opts.refText || '',
        language: opts.language || voice.language || null,
        segment_gen: false,
      };
    } else if (endpointMode === 'voice-design') {
      pathname = '/qwenapi/v1/voice-design';
      payload = {
        model_name: modelName,
        text: clipped,
        instruct: opts.instruct || voice.instruct,
        language: opts.language || voice.language || null,
        segment_gen: false,
      };
    } else {
      pathname = '/qwenapi/v1/custom-voice';
      payload = {
        model_name: modelName,
        text: clipped,
        instruct: opts.instruct || voice.instruct,
        speaker: opts.speaker || voice.speaker || null,
        language: opts.language || voice.language || null,
        segment_gen: false,
      };
    }

    const data = await api(pathname, { method: 'POST', body: payload, timeoutMs: timeout });
    const b64 = (data.audio_files_base64 || [])[0];
    if (!b64) throw mkError('语音服务未返回音频数据', 'TTS_EMPTY');
    const buffer = Buffer.from(b64, 'base64');
    if (cachePath) { try { fs.writeFileSync(cachePath, buffer); } catch { /* 缓存失败不影响本次返回 */ } }
    return { buffer, mime: 'audio/wav', cached: false, voice, model: modelName, mode: endpointMode };
  }

  async function interrupt() {
    try { return await api('/qwenapi/v1/interrupt', { method: 'POST' }); } catch { return { ok: false }; }
  }

  return { status, models, speakers, synthesize, interrupt, VOICE_PRESETS, SPEAKER_LIBRARY, DEFAULT_VOICE, get url() { return base; } };
}

module.exports = { createTTS, VOICE_PRESETS, SPEAKER_LIBRARY, DEFAULT_VOICE, DEFAULT_URL };
