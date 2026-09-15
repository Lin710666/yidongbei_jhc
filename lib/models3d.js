/**
 * models3d.js —— 3D 角色模型管理（本地）
 *
 * 两类来源，全部离线可用：
 *   ① 内置模型 —— public/models3d/*，随项目分发（来自 Project AIRI 的 VRM 示例模型）
 *   ② 用户上传 —— data/models3d/*，用户自己的 VRM / glTF / GLB，存本地不出机器
 *
 * 支持的格式：
 *   .vrm  —— VRM 0.x / 1.0（本质是 glTF 二进制，头部同样是 "glTF" 魔数），带骨骼与表情
 *   .glb  —— glTF 二进制
 *   .gltf —— glTF 文本（+ 外部 .bin/纹理，因此这里要求用户优先用 .glb/.vrm 单文件）
 *
 * 为什么只收单文件格式：.gltf 文本格式通常还依赖一堆散装 .bin 与贴图，
 * 网页端"上传一个文件"这个交互没办法把整包一起带上来，与其让用户传完发现缺贴图，
 * 不如在界面上直接说明"请用 .vrm 或 .glb 单文件"。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 单文件 3D 格式。key 是小写扩展名，值是展示用名称 */
const FORMATS = {
  '.vrm': { label: 'VRM', mime: 'model/gltf-binary', desc: 'VRoid / VRM 虚拟形象，带骨骼与表情' },
  '.glb': { label: 'GLB', mime: 'model/gltf-binary', desc: 'glTF 二进制单文件' },
};

/** glTF 二进制（含 GLB 与 VRM）的魔数 */
const GLTF_MAGIC = 'glTF';

function createModels3D({ publicDir, dataDir, maxBytes = 80 * 1024 * 1024 }) {
  const bundledDir = path.join(publicDir, 'models3d');
  const customDir = path.join(dataDir, 'models3d');
  const previewDir = path.join(dataDir, 'models3d-previews');
  fs.mkdirSync(customDir, { recursive: true });
  fs.mkdirSync(previewDir, { recursive: true });

  /**
   * 预览图用 URL 的哈希做键。
   * 为什么按 URL 而不是按文件名：内置模型的 url 是 /models3d/<dir>/x.vrm，
   * 上传过的是 /api/models3d/file/<name>，两种来源用同一个键空间，
   * 前端只要给 url 就能拿到对应预览，不用关心模型从哪来。
   */
  const previewKey = (url) => crypto.createHash('sha1').update(String(url || '')).digest('hex').slice(0, 16);
  const previewPath = (url) => path.join(previewDir, `${previewKey(url)}.png`);
  const hasPreview = (url) => fs.existsSync(previewPath(url));

  /** 保存一张预览图（前端截取已渲染的一帧后回传，见 app.js 的 captureModelPreview） */
  function savePreview(url, dataUrl) {
    let s = String(dataUrl || '').trim();
    const m = s.match(/^data:image\/png;base64,(.*)$/is);
    if (m) s = m[1];
    s = s.replace(/\s+/g, '');
    if (!s || !/^[A-Za-z0-9+/=]+$/.test(s)) {
      const e = new Error('预览图数据不是合法的 base64'); e.code = 'BAD_INPUT'; throw e;
    }
    const buf = Buffer.from(s, 'base64');
    if (!buf.length) { const e = new Error('预览图为空'); e.code = 'BAD_INPUT'; throw e; }
    // 预览图只是缩略图，超过 2MB 说明前端截错东西了，直接拒掉免得把磁盘写满
    if (buf.length > 2 * 1024 * 1024) {
      const e = new Error('预览图过大（超过 2MB）'); e.code = 'TOO_LARGE'; throw e;
    }
    fs.writeFileSync(previewPath(url), buf);
    return { key: previewKey(url), bytes: buf.length };
  }

  function readPreview(key) {
    const base = path.basename(String(key || '')).replace(/[^a-f0-9]/gi, '');
    if (!base) return null;
    const full = path.join(previewDir, `${base}.png`);
    return fs.existsSync(full) ? { full, base } : null;
  }

  /** 内置模型清单：每个子目录里一个模型文件 + 可选 manifest.json */
  function listBundled() {
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(bundledDir, { withFileTypes: true }).filter(d => d.isDirectory()); } catch { return out; }
    for (const d of dirs) {
      const dir = path.join(bundledDir, d.name);
      let files = [];
      try { files = fs.readdirSync(dir); } catch { continue; }
      const file = files.find(f => FORMATS[path.extname(f).toLowerCase()]);
      if (!file) continue;

      let meta = {};
      try {
        const mp = path.join(dir, 'manifest.json');
        if (fs.existsSync(mp)) meta = JSON.parse(fs.readFileSync(mp, 'utf8'));
      } catch { /* manifest 坏了不影响加载模型 */ }

      const st = fs.statSync(path.join(dir, file));
      const url = `/models3d/${d.name}/${file}`;
      out.push({
        id: `vrm-${d.name}`,
        kind: '3d',
        format: path.extname(file).slice(1).toLowerCase(),
        label: meta.label || d.name,
        note: meta.note || '',
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        url,
        preview: hasPreview(url) ? `/api/models3d/preview/${previewKey(url)}` : null,
        bundled: true,
        bytes: st.size,
      });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label, 'zh'));
  }

  /** 用户上传的模型 */
  function listCustom() {
    let files = [];
    try { files = fs.readdirSync(customDir); } catch { return []; }
    return files
      .filter(f => FORMATS[path.extname(f).toLowerCase()])
      .map((f) => {
        const st = fs.statSync(path.join(customDir, f));
        const m = /^(\d+)-/.exec(f);
        const url = `/api/models3d/file/${encodeURIComponent(f)}`;
        return {
          id: `vrm-custom-${f}`,
          kind: '3d',
          format: path.extname(f).slice(1).toLowerCase(),
          label: f.replace(/^\d+-/, '').replace(/\.[^.]+$/, ''),
          note: '我上传的模型',
          tags: ['本地上传'],
          url,
          preview: hasPreview(url) ? `/api/models3d/preview/${previewKey(url)}` : null,
          bundled: false,
          uploadedAt: m ? Number(m[1]) : st.mtimeMs,
          bytes: st.size,
        };
      })
      .sort((a, b) => b.uploadedAt - a.uploadedAt);
  }

  function list() {
    return { formats: FORMATS, bundled: listBundled(), custom: listCustom() };
  }

  /** 校验是不是真的 glTF 二进制：只看魔数，不信任扩展名 */
  function looksLikeGltf(buf) {
    return buf.length > 12 && buf.slice(0, 4).toString('ascii') === GLTF_MAGIC;
  }

  /**
   * 保存用户上传的模型。
   * @param {string} dataUrl base64（可带 data: 前缀）
   * @param {string} originalName 原始文件名，用来取扩展名与展示名
   */
  function save(dataUrl, originalName = '') {
    let s = String(dataUrl || '').trim();
    let declaredExt = String(originalName || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
    const m = s.match(/^data:[^;]+;base64,(.*)$/is);
    if (m) s = m[1];
    s = s.replace(/\s+/g, '');
    if (!s || !/^[A-Za-z0-9+/=]+$/.test(s)) {
      const e = new Error('模型数据不是合法的 base64'); e.code = 'BAD_INPUT'; throw e;
    }
    const buf = Buffer.from(s, 'base64');
    if (!buf.length) { const e = new Error('模型内容为空'); e.code = 'BAD_INPUT'; throw e; }
    if (buf.length > maxBytes) {
      const e = new Error(`模型过大（${(buf.length / 1024 / 1024).toFixed(1)}MB，上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB）`);
      e.code = 'TOO_LARGE'; throw e;
    }

    // 扩展名以魔数为准：是 glTF 二进制就按 .vrm/.glb 收；否则直接拒绝
    if (!looksLikeGltf(buf)) {
      // VRM 1.0 是 .vrm（glTF），VRM 0.x 也是 glTF，GLB 也是 glTF —— 都不是的话多半选错文件了
      const e = new Error(
        '这个文件看起来不是 VRM / GLB 模型。\n'
        + 'VRM 与 GLB 都是 glTF 二进制格式，文件头应当以 "glTF" 开头。\n'
        + '请确认你上传的是 .vrm 或 .glb 单文件（.gltf + 散装贴图 的格式本功能不支持）。',
      );
      e.code = 'BAD_INPUT'; throw e;
    }

    let ext = FORMATS[declaredExt] ? declaredExt : '.glb';
    // 有 .vrm 扩展名就保留它，方便界面上区分
    const safeBase = String(originalName || 'model')
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w\u4E00-\u9FFF-]/g, '')
      .slice(0, 32) || 'model';
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 6);
    const name = `${Date.now()}-${safeBase}-${hash}${ext}`;
    fs.writeFileSync(path.join(customDir, name), buf);
    void ext;
    return { name, bytes: buf.length, item: listCustom().find(c => c.id === `vrm-custom-${name}`) };
  }

  /** 读取某个自定义模型文件（供接口返回）。只用 basename，杜绝 ../ 穿越 */
  function readCustomFile(name) {
    const base = path.basename(decodeURIComponent(String(name || '')));
    if (!base || !FORMATS[path.extname(base).toLowerCase()]) return null;
    const full = path.join(customDir, base);
    if (!fs.existsSync(full)) return null;
    return { full, base };
  }

  function remove(id) {
    const base = String(id || '').replace(/^vrm-custom-/, '');
    const hit = readCustomFile(base);
    if (!hit) return { ok: false, error: '模型不存在' };
    fs.unlinkSync(hit.full);
    return { ok: true };
  }

  const mimeOf = (ext) => (FORMATS[ext.toLowerCase()] || {}).mime || 'application/octet-stream';

  return { list, save, remove, readCustomFile, mimeOf, FORMATS, savePreview, readPreview, previewKey, get customDir() { return customDir; } };
}

module.exports = { createModels3D, FORMATS };
