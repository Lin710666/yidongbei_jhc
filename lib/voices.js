/**
 * voices.js —— "我的音色"：声音克隆用的参考音频
 *
 * 背景：
 *   Qwen3-TTS 的 CustomVoice 模型自带 9 个内置音色（见 tts.js 的 SPEAKER_LIBRARY），
 *   但用户往往想用自己的声音。Qwen3-TTS 支持 voice-clone —— 给一段 5~15 秒的
 *   干净人声，它就能把那副嗓子搬过来。
 *   这个模块负责把用户上传的那段参考音频管起来。
 *
 * 存法（和 roles/backgrounds 一个路子，都是纯本机文件）：
 *     data/voice-refs/index.json   音色清单（名称、描述、参考文本、时长…）
 *     data/voice-refs/<id>.wav     参考音频原样存着
 *
 * 为什么不把音频塞进 index.json：
 *   一段 15 秒的 WAV base64 之后有 1MB 上下，放 JSON 里会让每次读清单
 *   都很慢，也容易把文件写坏。分开存更稳。
 *
 * 数据不出本机：这些文件只在本机读写，合成时也是直接喂给 127.0.0.1 上的 TTS。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 解析 WAV 头，返回 { sampleRate, bits, channels, seconds, dataOffset }；不是真 WAV 就返回 null */
function probeWav(buf) {
  if (!buf || buf.length < 44) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;

  let pos = 12;
  let sampleRate = 0;
  let bits = 0;
  let channels = 0;
  let dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
      bits = buf.readUInt16LE(pos + 22);
    } else if (id === 'data') {
      dataLen = Math.min(size, buf.length - pos - 8);
    }
    pos += 8 + size + (size % 2);
  }
  if (!sampleRate || !bits) return null;
  const bytesPerSec = sampleRate * (bits / 8) * Math.max(1, channels);
  return { sampleRate, bits, channels, seconds: dataLen / bytesPerSec, dataOffset: 44 };
}

function createVoices({ dir, maxBytes = 24 * 1024 * 1024 } = {}) {
  const refDir = path.join(dir, 'voice-refs');
  const indexPath = path.join(refDir, 'index.json');
  fs.mkdirSync(refDir, { recursive: true });

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      return Array.isArray(j.items) ? j.items : [];
    } catch { return []; }
  }

  function persist(items) {
    const tmp = `${indexPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2));
    fs.renameSync(tmp, indexPath);
  }

  /** 清单：不带音频内容，只给界面看的元信息 */
  function list() {
    return load().map(v => ({ ...v, url: `/api/voices/${v.id}/audio` }));
  }

  function get(id) {
    const key = String(id || '').trim();
    if (!/^[a-z0-9-]{4,40}$/.test(key)) return null;
    return load().find(v => v.id === key) || null;
  }

  /** 读出音频字节，供合成时转 base64 喂给 TTS */
  function read(id) {
    const meta = get(id);
    if (!meta) return null;
    const file = path.join(refDir, `${meta.id}.wav`);
    if (!fs.existsSync(file)) return null;
    return { buffer: fs.readFileSync(file), meta };
  }

  /**
   * 保存一条音色。
   * @param {{name:string, desc?:string, refText?:string, audio:string, originalName?:string}} input
   *        audio 可以是纯 base64，也可以是 data:audio/wav;base64,xxx
   */
  function save({ name, desc = '', refText = '', audio, originalName = '' } = {}) {
    const label = String(name || '').trim();
    if (!label) { const e = new Error('请给这个音色起个名字'); e.code = 'BAD_INPUT'; throw e; }
    if (label.length > 24) { const e = new Error('音色名字最多 24 个字'); e.code = 'BAD_INPUT'; throw e; }

    let s = String(audio || '').trim();
    const m = /^data:[^;,]*;base64,(.*)$/s.exec(s);
    if (m) s = m[1];
    if (!s) { const e = new Error('没有收到音频数据'); e.code = 'BAD_INPUT'; throw e; }

    let buf;
    try { buf = Buffer.from(s, 'base64'); } catch { buf = null; }
    if (!buf || !buf.length) { const e = new Error('音频解码失败，请重新选一次文件'); e.code = 'BAD_INPUT'; throw e; }
    if (buf.length > maxBytes) {
      const e = new Error(`音频太大了（${(buf.length / 1024 / 1024).toFixed(1)}MB），上限 ${maxBytes / 1024 / 1024}MB`);
      e.code = 'TOO_LARGE'; throw e;
    }

    const probe = probeWav(buf);
    if (!probe) {
      // 这是踩过的坑：Qwen TTS 那边只是把字节写进一个 .wav 文件，什么都不检查，
      // MP3 改名成 .wav 也能"上传成功"，但合成出来是噪声。所以这里必须自己把关。
      const e = new Error('这不是真正的 WAV 文件。MP3 / M4A / FLAC 改名成 .wav 是不行的，需要先真的转成 WAV。');
      e.code = 'BAD_FORMAT'; throw e;
    }
    if (probe.seconds < 2) {
      const e = new Error(`这段只有 ${probe.seconds.toFixed(1)} 秒，太短了，音色学不稳。建议 5~15 秒。`);
      e.code = 'TOO_SHORT'; throw e;
    }

    const id = crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(path.join(refDir, `${id}.wav`), buf);

    const meta = {
      id,
      name: label,
      desc: String(desc || '').trim(),
      refText: String(refText || '').trim(),
      seconds: Number(probe.seconds.toFixed(1)),
      sampleRate: probe.sampleRate,
      bits: probe.bits,
      channels: probe.channels,
      bytes: buf.length,
      originalName: path.basename(String(originalName || '')).slice(0, 80),
      createdAt: new Date().toISOString(),
    };
    const items = load();
    items.push(meta);
    persist(items);
    return { ...meta, url: `/api/voices/${id}/audio` };
  }

  /** 改名字 / 改参考文本 */
  function update(id, patch = {}) {
    const items = load();
    const i = items.findIndex(v => v.id === id);
    if (i < 0) return null;
    if (patch.name !== undefined) {
      const label = String(patch.name).trim();
      if (!label) { const e = new Error('名字不能为空'); e.code = 'BAD_INPUT'; throw e; }
      items[i].name = label.slice(0, 24);
    }
    if (patch.desc !== undefined) items[i].desc = String(patch.desc).trim().slice(0, 120);
    if (patch.refText !== undefined) items[i].refText = String(patch.refText).trim().slice(0, 400);
    persist(items);
    return { ...items[i], url: `/api/voices/${id}/audio` };
  }

  function remove(id) {
    const items = load();
    const i = items.findIndex(v => v.id === id);
    if (i < 0) return false;
    items.splice(i, 1);
    persist(items);
    try { fs.unlinkSync(path.join(refDir, `${id}.wav`)); } catch { /* 文件本来就不在也无所谓 */ }
    return true;
  }

  return { list, get, read, save, update, remove, refDir, probeWav };
}

module.exports = { createVoices, probeWav };
