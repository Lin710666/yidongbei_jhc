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
 * 默认语音（"初始语音"）：面向文旅讲解场景定的一个温和女声。
 * 之所以给出完整的 instruct 而不是只留个名字：VoiceDesign/CustomVoice 两条路
 * 都靠这段自然语言描述来决定音色，写清楚了音色才稳定、复现得出来。
 */
const DEFAULT_VOICE = {
  id: 'wenlv-guide-female',
  name: '小文 · 温柔讲解',
  desc: '温柔亲切的年轻女声，语速稍慢、吐字清晰，适合景点讲解与行程播报',
  mode: 'custom-voice',
  instruct: '用温柔亲切的年轻女声说话，语速稍慢、吐字清晰，语气自然不夸张，像在给游客做景点讲解。',
  language: 'Chinese',
  speaker: null,
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
    instruct: '用沉稳温和的男声说话，中低音，语速中等，像博物馆讲解员一样从容。',
    language: 'Chinese',
    speaker: null,
    speedHint: '中等',
  },
  {
    id: 'wenlv-sweet',
    name: '小游 · 元气少女',
    desc: '活泼元气的少女音，适合种草短视频口播',
    mode: 'voice-design',
    instruct: '体现元气活泼的少女音，音调偏高、语调起伏明显，语速偏快，带一点俏皮的笑意。',
    language: 'Chinese',
    speaker: null,
    speedHint: '偏快',
  },
  {
    id: 'wenlv-marketing',
    name: '运营号 · 干练播报',
    desc: '干练清晰的播报腔，适合营销文案口播',
    mode: 'voice-design',
    instruct: '干练清晰的年轻女声播报，节奏明快、重点词加重，像电商直播里介绍产品。',
    language: 'Chinese',
    speaker: null,
    speedHint: '偏快',
  },
  {
    id: 'wenlv-gentle-slow',
    name: '静水 · 舒缓睡前',
    desc: '很慢很轻的旁白音，适合民宿/疗愈场景',
    mode: 'voice-design',
    instruct: '非常轻柔舒缓的女声旁白，接近气声，语速很慢，营造安静放松的氛围。',
    language: 'Chinese',
    speaker: null,
    speedHint: '很慢',
  },
];

function mkError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function createTTS({ url = DEFAULT_URL, cacheDir, defaultVoice = DEFAULT_VOICE, timeout = 300000 } = {}) {
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
   * 选模型：优先 CustomVoice（音色最稳），其次 Base（可克隆），最后 VoiceDesign。
   * 本机只下了一个模型时也能正常工作。
   */
  function pickModel(list, mode) {
    const names = list.map(m => m.name || m);
    const find = re => names.find(n => re.test(n));
    if (mode === 'voice-design') return find(/VoiceDesign/i) || find(/CustomVoice/i) || names[0] || null;
    if (mode === 'voice-clone') return find(/Base/i) || names[0] || null;
    return find(/CustomVoice/i) || find(/Base/i) || find(/VoiceDesign/i) || names[0] || null;
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

    // 缓存键覆盖所有会影响音色的字段，避免"换了音色还在放旧音频"
    const key = crypto.createHash('sha1')
      .update(JSON.stringify([clipped, mode, voice.instruct, opts.speaker || voice.speaker, opts.language || voice.language, opts.model || '', opts.refText || '']))
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
    if (mode === 'voice-clone') {
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
    } else if (mode === 'voice-design') {
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
    return { buffer, mime: 'audio/wav', cached: false, voice, model: modelName };
  }

  async function interrupt() {
    try { return await api('/qwenapi/v1/interrupt', { method: 'POST' }); } catch { return { ok: false }; }
  }

  return { status, models, synthesize, interrupt, VOICE_PRESETS, DEFAULT_VOICE, get url() { return base; } };
}

module.exports = { createTTS, VOICE_PRESETS, DEFAULT_VOICE, DEFAULT_URL };
