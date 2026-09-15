/**
 * backgrounds.js —— 背景资源管理（本地）
 *
 * 三类背景，全部离线可用：
 *   ① 内置图片  —— public/backgrounds/*，随项目分发（来自 Project AIRI）
 *   ② 程序化背景 —— 不依赖任何图片文件，用 Canvas 现画（极光、波浪、樱花、星野、山水…）
 *                    这些是照着 AIRI 的 Backgrounds 组件（part-animated-wave / SakuraPetal /
 *                    pattern-cross）重做的，好处是零素材体积、任意分辨率都不糊。
 *   ③ 自定义上传 —— 用户自己的图片，存到 data/backgrounds/，存本地不出机器。
 *
 * 说明：程序化背景的"定义"（id/label/调色板）也放在这里，前端只负责按 id 去画。
 * 这样"有哪些背景"只有一处事实来源，前端不会和后台对不上。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif']);

/**
 * 程序化背景。palette 是主色序列，前端据此上色。
 * 之所以把调色板放服务端：用户可以在设置里改色相，换色不用动前端代码。
 */
const PROCEDURAL = [
  {
    id: 'proc-aurora',
    kind: 'procedural',
    label: '极光渐变',
    note: 'AIRI 默认的色相流动背景（跟随角色卡主色）',
    renderer: 'aurora',
    palette: ['#7dd3fc', '#a78bfa', '#f472b6'],
    tone: 'dark',
  },
  {
    id: 'proc-wave',
    kind: 'procedural',
    label: '动态波浪',
    note: '照 AIRI 的 part-animated-wave 重做，三层正弦波错速流动',
    renderer: 'wave',
    palette: ['#38bdf8', '#0ea5e9', '#0f766e'],
    tone: 'dark',
  },
  {
    id: 'proc-sakura',
    kind: 'procedural',
    label: '樱花飘落',
    note: '照 AIRI 的 SakuraPetal 重做，花瓣带旋转与横向摆动',
    renderer: 'sakura',
    palette: ['#fbcfe8', '#f9a8d4', '#fda4af'],
    tone: 'dark',
  },
  {
    id: 'proc-stars',
    kind: 'procedural',
    label: '夜空星野',
    note: '缓慢漂移的星点 + 轻微闪烁',
    renderer: 'stars',
    palette: ['#e2e8f0', '#a5b4fc', '#7dd3fc'],
    tone: 'dark',
  },
  {
    id: 'proc-cross',
    kind: 'procedural',
    label: '十字点纹',
    note: '照 AIRI 的 pattern-cross 重做，静态几何底纹',
    renderer: 'cross',
    palette: ['#94a3b8'],
    tone: 'dark',
  },
  {
    id: 'proc-shanshui',
    kind: 'procedural',
    label: '山水青绿',
    note: '文旅主色：远近三层山脊 + 晨雾（呼应"诗画浙江"）',
    renderer: 'shanshui',
    palette: ['#0f766e', '#14b8a6', '#99f6e4'],
    tone: 'dark',
  },
  {
    id: 'proc-sunset',
    kind: 'procedural',
    label: '暖金黄昏',
    note: '落日暖调渐变 + 地平线光晕',
    renderer: 'sunset',
    palette: ['#f59e0b', '#fb7185', '#7c3aed'],
    tone: 'dark',
  },
  {
    id: 'proc-paper',
    kind: 'procedural',
    label: '宣纸留白',
    note: '浅色纸张纹理，人物与词云对比度最高，适合截图',
    renderer: 'paper',
    palette: ['#f5f5f4', '#e7e5e4'],
    tone: 'light',
  },
  {
    id: 'proc-plain',
    kind: 'procedural',
    label: '纯色（跟随主题）',
    note: '不加任何装饰，只用主题底色',
    renderer: 'plain',
    palette: ['#121212'],
    tone: 'dark',
  },
];

function createBackgrounds({ publicDir, dataDir, maxBytes = 12 * 1024 * 1024 }) {
  const bundledDir = path.join(publicDir, 'backgrounds');
  const customDir = path.join(dataDir, 'backgrounds');
  fs.mkdirSync(customDir, { recursive: true });

  /** 读取内置图片清单（带出处信息） */
  function listBundled() {
    const metaPath = path.join(bundledDir, 'backgrounds.json');
    let meta = { items: [] };
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { /* 没有元数据就空着 */ }
    const out = [];
    for (const item of meta.items || []) {
      const file = path.join(bundledDir, item.file);
      if (!fs.existsSync(file)) continue;                 // 文件被删了就别在界面上留下死项
      out.push({
        id: item.id,
        kind: 'image',
        label: item.label,
        note: item.note || '',
        tone: item.tone || 'dark',
        url: `/backgrounds/${item.file}`,
        bundled: true,
      });
    }
    return out;
  }

  /** 读取用户上传的背景 */
  function listCustom() {
    let files = [];
    try { files = fs.readdirSync(customDir); } catch { return []; }
    return files
      .filter(f => IMAGE_EXT.has(path.extname(f).toLowerCase()))
      .map((f) => {
        const st = fs.statSync(path.join(customDir, f));
        // 文件名形如 <时间戳>-<短哈希>.<ext>，反解出上传时间用于排序展示
        const m = /^(\d+)-/.exec(f);
        return {
          id: `custom-${f}`,
          kind: 'image',
          label: f.replace(/^\d+-/, '').replace(/\.[^.]+$/, ''),
          note: '本地上传',
          tone: 'dark',
          url: `/api/backgrounds/file/${encodeURIComponent(f)}`,
          bundled: false,
          uploadedAt: m ? Number(m[1]) : st.mtimeMs,
          bytes: st.size,
        };
      })
      .sort((a, b) => b.uploadedAt - a.uploadedAt);
  }

  function list() {
    return { bundled: listBundled(), procedural: PROCEDURAL, custom: listCustom() };
  }

  /** 保存一张用户上传的图片（base64，可带 data: 前缀） */
  function save(dataUrl, originalName = '') {
    let s = String(dataUrl || '').trim();
    let ext = '';
    const m = s.match(/^data:image\/([a-z0-9.+-]+);base64,(.*)$/is);
    if (m) {
      const sub = m[1].toLowerCase();
      ext = sub === 'jpeg' ? '.jpg' : `.${sub}`;
      s = m[2];
    }
    s = s.replace(/\s+/g, '');
    if (!s || !/^[A-Za-z0-9+/=]+$/.test(s)) {
      const e = new Error('图片数据不是合法的 base64');
      e.code = 'BAD_INPUT';
      throw e;
    }
    const buf = Buffer.from(s, 'base64');
    if (!buf.length) { const e = new Error('图片内容为空'); e.code = 'BAD_INPUT'; throw e; }
    if (buf.length > maxBytes) {
      const e = new Error(`图片过大（约 ${(buf.length / 1024 / 1024).toFixed(1)}MB，上限 ${(maxBytes / 1024 / 1024).toFixed(0)}MB）`);
      e.code = 'TOO_LARGE';
      throw e;
    }
    if (!ext) ext = '.png';
    if (!IMAGE_EXT.has(ext)) {
      const e = new Error(`不支持的图片格式：${ext}`);
      e.code = 'BAD_INPUT';
      throw e;
    }
    // 文件名带时间戳，天然按上传时间排序；再带一小段哈希避免同名覆盖
    const safeBase = String(originalName || 'background')
      .replace(/\.[^.]+$/, '')
      .replace(/[^\w\u4E00-\u9FFF-]/g, '')
      .slice(0, 24) || 'background';
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 6);
    const name = `${Date.now()}-${safeBase}-${hash}${ext}`;
    fs.writeFileSync(path.join(customDir, name), buf);
    return { name, bytes: buf.length, item: listCustom().find(c => c.id === `custom-${name}`) };
  }

  /** 读取某个自定义背景文件（供静态接口返回） */
  function readCustomFile(name) {
    // 只用 basename，杜绝 ../ 穿越
    const base = path.basename(decodeURIComponent(String(name || '')));
    if (!base || !IMAGE_EXT.has(path.extname(base).toLowerCase())) return null;
    const full = path.join(customDir, base);
    if (!fs.existsSync(full)) return null;
    return { full, base };
  }

  /** 删除一个自定义背景 */
  function remove(id) {
    const base = String(id || '').replace(/^custom-/, '');
    const hit = readCustomFile(base);
    if (!hit) return { ok: false, error: '背景不存在' };
    fs.unlinkSync(hit.full);
    return { ok: true };
  }

  const mimeOf = (ext) => ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  }[ext] || 'application/octet-stream');

  return { list, save, remove, readCustomFile, mimeOf, PROCEDURAL, get customDir() { return customDir; } };
}

module.exports = { createBackgrounds, PROCEDURAL };
