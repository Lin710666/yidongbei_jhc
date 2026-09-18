/**
 * pano.js —— 360° 全景图的检索、校验与缓存
 *
 * "把一个景点变成能环视的三维场景"的第一步是拿到一张**等距柱状投影**（equirectangular）
 * 的全景图。这一步比听起来麻烦，麻烦全在"搜到的到底能不能用"：
 *
 *   · 搜"XX 全景"回来的大量是攻略页、视频、JS 查看器，**不是图片**；
 *   · 就算是图片，也常常是普通照片或"小行星"投影截图 —— 贴到环境球上会整个变形；
 *   · 判断能不能用只有一条硬指标：**宽高比接近 2:1**（等距柱状投影的定义），
 *     所以必须真的把图片头读出来量尺寸，不能只看 URL 后缀。
 *
 * 为此这里做三件事：检索 → 下载 → **读图片头量尺寸并判定是否可用**，可用的才缓存。
 * 不合格的候选会带着原因被跳过，最终把"试过哪些、为什么都不行"如实报出来 ——
 * 而不是给用户一张变形的图，让他以为程序坏了。
 *
 * 图片头解析是手写的（PNG/JPEG/WebP/GIF），因为项目零第三方依赖。
 * 只读头部几十个字节，不解码像素，很快。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const web = require('./web');

/** 单张全景图下载上限（默认 12MB，全景图普遍 3~8MB） */
const DEFAULT_MAX_MB = Number(process.env.PANO_MAX_MB || 12);
/** 宽高比容差：等距柱状是 2.0，允许 1.9~2.1（有些图会被裁掉几像素） */
const RATIO_MIN = Number(process.env.PANO_RATIO_MIN || 1.9);
const RATIO_MAX = Number(process.env.PANO_RATIO_MAX || 2.12);

/**
 * 已知的全景平台。搜"XX 全景"会回来一堆旅游攻略，按域名给候选排序能显著减少
 * 无效下载 —— 每一张无效下载都是几 MB 的流量和几秒的等待。
 */
const PANO_HOSTS = [
  { re: /(^|\.)720yun\.com$/i, label: '720云', direct: false },
  { re: /(^|\.)kuula\.co$/i, label: 'Kuula', direct: false },
  { re: /(^|\.)airpano\.(com|ru)$/i, label: 'AirPano', direct: false },
  { re: /(^|\.)360cities\.net$/i, label: '360Cities', direct: false },
  { re: /(^|\.)photo-sphere-viewer\.js\.org$/i, label: 'Photo Sphere Viewer 示例', direct: true },
  { re: /(^|\.)upload\.wikimedia\.org$/i, label: '维基共享资源', direct: true },
  { re: /(^|\.)commons\.wikimedia\.org$/i, label: '维基共享资源', direct: false },
];

function hostInfo(url) {
  try {
    const h = new URL(url).hostname;
    for (const p of PANO_HOSTS) if (p.re.test(h)) return { label: p.label, direct: p.direct, host: h };
    return { label: h, direct: false, host: h };
  } catch { return { label: '', direct: false, host: '' }; }
}

const looksLikeImage = url => /\.(jpe?g|png|webp|avif)(\?|#|$)/i.test(String(url));

/* ==========================================================================
 * 图片头解析：只量尺寸，不解码像素
 * ========================================================================*/

/**
 * 从字节流头部读出图片尺寸。
 * @returns {{width:number,height:number,format:string}|null}
 */
function parseImageSize(buf) {
  if (!buf || buf.length < 16) return null;

  // ---- PNG：IHDR 固定在第 16~24 字节 ----
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  }

  // ---- GIF ----
  if (buf.slice(0, 3).toString('latin1') === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' };
  }

  // ---- WebP：RIFF....WEBP 之后分三种子格式 ----
  if (buf.slice(0, 4).toString('latin1') === 'RIFF' && buf.slice(8, 12).toString('latin1') === 'WEBP') {
    const kind = buf.slice(12, 16).toString('latin1');
    if (kind === 'VP8X' && buf.length >= 30) {
      // 扩展格式：24 位小端存 (宽-1) 与 (高-1)
      const w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
      const h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
      return { width: w, height: h, format: 'webp' };
    }
    if (kind === 'VP8 ' && buf.length >= 30) {
      // 有损：帧头在 20 字节偏移处，宽高各 14 位
      const w = buf.readUInt16LE(26) & 0x3fff;
      const h = buf.readUInt16LE(28) & 0x3fff;
      return { width: w, height: h, format: 'webp' };
    }
    if (kind === 'VP8L' && buf.length >= 25) {
      // 无损：14 位宽 + 14 位高，紧跟在 0x2f 之后
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp' };
    }
    return null;
  }

  // ---- JPEG：扫描 SOF 段 ----
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      // 跳过填充字节
      if (marker === 0xff) { i++; continue; }
      // 无长度字段的标记
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15，但 C4(DHT)、C8(JPG)、CC(DAC) 不是
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), format: 'jpeg' };
      }
      if (len < 2) break;
      i += 2 + len;
    }
    return null;
  }

  return null;
}

/** 判定是否像一张等距柱状全景：宽高比接近 2:1，且尺寸足够大 */
function isEquirectangular(size) {
  if (!size || !size.width || !size.height) return { ok: false, reason: '读不出图片尺寸' };
  const ratio = size.width / size.height;
  if (ratio < RATIO_MIN || ratio > RATIO_MAX) {
    return { ok: false, reason: `宽高比 ${ratio.toFixed(2)}:1，不是等距柱状全景（应为 2:1 左右）`, ratio };
  }
  if (size.width < 1024) {
    return { ok: false, reason: `分辨率偏低（${size.width}×${size.height}），贴上会糊`, ratio };
  }
  return { ok: true, ratio };
}

/* ==========================================================================
 * 图片搜索（拿直链，比网页搜索靠谱得多）
 *
 * 为什么必须有这一层：实测"XX 360全景图"走**网页**搜索回来的全是攻略文章和
 * JS 查看器页面（中文全景平台如 720云 都不给直链），一个能下载的都没有。
 * 图片搜索返回的就是图片 URL，这才是拿全景图的正确入口。
 *
 * 两家都实现是因为它们各有盲区：Bing 对英文/国际内容好，百度对中文长尾好。
 * ========================================================================*/

/** 从 Bing 图片搜索页里抠出直链。改版过好几次，所以同时试三种写法。 */
function parseBingImages(html) {
  const out = [];

  // ① 直接形态（旧版）
  for (const m of html.matchAll(/"murl":"([^"]+)"/g)) out.push(m[1]);
  // ② HTML 转义形态（当前版本：murl&quot;:&quot;...&quot;）
  for (const m of html.matchAll(/murl&quot;:&quot;(.*?)&quot;/g)) out.push(web.decodeEntities(m[1]));
  // ③ iusc 元素把整个结果 JSON 塞在 m 属性里（同样是转义的）
  for (const m of html.matchAll(/class="iusc"[^>]*?m="([^"]+)"/g)) {
    try {
      const j = JSON.parse(web.decodeEntities(m[1]));
      if (j && j.murl) out.push(j.murl);
    } catch { /* 单条坏掉不影响其它 */ }
  }

  return [...new Set(out)]
    .map(u => u.replace(/&amp;/g, '&'))
    .filter(u => /^https?:\/\//i.test(u));
}

/** 从百度图片的 acjson 接口取直链 */
function parseBaiduImages(json) {
  const list = (json && json.data) || [];
  const out = [];
  for (const it of list) {
    if (!it) continue;
    // middleURL / thumbURL 是百度自己的图床直链，可直接下载；
    // objURL 是加密过的原图地址，需要另一套解密，不值得为它增加复杂度。
    const u = it.middleURL || it.thumbURL || it.hoverURL;
    if (u && /^https?:\/\//i.test(u)) out.push(u);
  }
  return [...new Set(out)];
}

/**
 * 图片搜索。返回直链数组（已去重、已按"像不像全景"粗排）。
 * 真正的判定不在这里 —— 宽高比要下载下来量，见 isEquirectangular。
 */
async function searchImages(query, { limit = 12, timeout = 20000 } = {}) {
  const out = [];
  const failures = [];

  const bing = `https://cn.bing.com/images/search?q=${encodeURIComponent(query)}&first=1&form=HDRSC2`;
  try {
    const res = await web.fetchRaw(bing, { timeout });
    if (res.status === 200) out.push(...parseBingImages(res.body.toString('utf8')));
    else failures.push(`Bing 图片：HTTP ${res.status}`);
  } catch (e) { failures.push(`Bing 图片：${e.message.split('\n')[0]}`); }

  const baidu = 'https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&rn=30'
    + `&word=${encodeURIComponent(query)}&queryWord=${encodeURIComponent(query)}`;
  try {
    const res = await web.fetchRaw(baidu, {
      timeout,
      accept: 'application/json',
      // 百度这个接口会查 Referer，不带就直接拒
      headers: { Referer: 'https://image.baidu.com/' },
    });
    if (res.status === 200) {
      let j = null;
      try { j = JSON.parse(res.body.toString('utf8')); } catch { /* 可能返回 HTML */ }
      if (j) out.push(...parseBaiduImages(j));
      else failures.push('百度图片：返回的不是 JSON');
    } else failures.push(`百度图片：HTTP ${res.status}`);
  } catch (e) { failures.push(`百度图片：${e.message.split('\n')[0]}`); }

  return { urls: [...new Set(out)].slice(0, limit), failures };
}

/* ==========================================================================
 * 检索
 * ========================================================================*/

/**
 * 搜全景候选。**图片搜索优先**，网页搜索兜底。
 *
 * 顺序不能反：网页搜索对"找全景图"这件事几乎无用（回来的都是攻略），
 * 但它偶尔能给出托管在直链站点上的图片页，所以留着当补充。
 */
async function searchCandidates(spot, { city, limit = 10 } = {}) {
  const base = city && !String(spot).includes(String(city)) ? `${city}${spot}` : String(spot);
  const failures = [];
  const seen = new Set();
  const out = [];

  const push = (url, meta) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    const info = hostInfo(url);
    out.push({
      url,
      title: meta.title || '',
      snippet: meta.snippet || '',
      source: info.label,
      host: info.host,
      looksLikeImage: looksLikeImage(url),
      from: meta.from,
      score: meta.score || 0,
    });
  };

  // ---- ① 图片搜索：三组词，英文词更接近"等距柱状"的表述 ----
  const imageQueries = [
    `${base} 360 panorama equirectangular`,
    `${base} 球形全景 360度`,
    `${base} 全景图 高清 360`,
  ];
  for (const q of imageQueries) {
    try {
      const r = await searchImages(q, { limit: 12 });
      failures.push(...r.failures);
      for (const u of r.urls) push(u, { from: 'image-search', title: q, score: 6 });
    } catch (e) {
      failures.push(`${q}：${String(e.message).split('\n')[0]}`);
    }
  }

  // ---- ② 网页搜索兜底 ----
  try {
    const r = await web.search(`${base} 360全景图 全景照片`, { limit: 8 });
    for (const x of r.results) {
      const info = hostInfo(x.url);
      let score = 1;
      if (looksLikeImage(x.url)) score += 4;
      if (info.direct) score += 2;
      push(x.url, { title: x.title, snippet: x.snippet, from: 'web-search', score });
    }
  } catch (e) {
    failures.push(`网页搜索：${String(e.message).split('\n')[0]}`);
  }

  if (!out.length) {
    const err = new Error(`没能搜到「${base}」的任何全景图候选。\n${[...new Set(failures)].join('\n')}`);
    err.code = 'SEARCH_FAILED';
    throw err;
  }

  // 直链图片排前面；同分时保持原始顺序（图片搜索的整体质量更稳）
  out.sort((a, b) => (b.looksLikeImage ? 1 : 0) - (a.looksLikeImage ? 1 : 0) || b.score - a.score);
  return { spot: base, candidates: out.slice(0, limit), failures: [...new Set(failures)] };
}

/* ==========================================================================
 * 缓存
 * ========================================================================*/

function createPano({ dir, fetchRaw, maxMB = DEFAULT_MAX_MB } = {}) {
  const panoDir = path.join(dir, 'panoramas');
  const indexPath = path.join(panoDir, 'index.json');
  fs.mkdirSync(panoDir, { recursive: true });

  let index = { version: 1, items: [] };

  function load() {
    try {
      if (!fs.existsSync(indexPath)) return;
      const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      index = { version: 1, items: Array.isArray(raw.items) ? raw.items : [] };
    } catch (e) {
      console.error('[pano] 全景索引损坏，已重建：', e.message);
      try { fs.copyFileSync(indexPath, `${indexPath}.corrupt`); } catch { /* 忽略 */ }
      index = { version: 1, items: [] };
    }
  }
  load();

  function persist() {
    try {
      const tmp = `${indexPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
      fs.renameSync(tmp, indexPath);
    } catch (e) {
      console.error('[pano] 全景索引写入失败：', e.message);
    }
  }

  const extOf = fmt => ({ png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif' }[fmt] || '.bin');

  /**
   * 下载并校验一个候选。
   *
   * 关键在"先量尺寸再决定留不留"：不合格的**直接丢掉**，不写进缓存 ——
   * 否则缓存里会堆一堆贴上去就变形的废图，下次还优先命中它们。
   */
  async function fetchOne(url, { spot = '', timeout = 20000 } = {}) {
    const sizeLimit = maxMB * 1024 * 1024;
    const res = await fetchRaw(url, { timeout, maxBytes: sizeLimit, accept: 'image/*' });
    if (res.status !== 200) {
      return { ok: false, url, reason: `HTTP ${res.status}` };
    }
    const ct = (res.contentType || '').toLowerCase();
    if (ct && !/^image\//.test(ct) && !/octet-stream/.test(ct)) {
      return { ok: false, url, reason: `不是图片（Content-Type: ${ct}）` };
    }

    const size = parseImageSize(res.body);
    const verdict = isEquirectangular(size);
    if (!verdict.ok) {
      return { ok: false, url, reason: verdict.reason, size };
    }

    const id = crypto.createHash('sha1').update(url).digest('hex').slice(0, 16);
    const ext = extOf(size.format);
    const file = path.join(panoDir, `${id}${ext}`);
    fs.writeFileSync(file, res.body);

    const info = hostInfo(url);
    const rec = {
      id,
      url,
      file: `${id}${ext}`,
      width: size.width,
      height: size.height,
      ratio: Number(verdict.ratio.toFixed(3)),
      format: size.format,
      bytes: res.body.length,
      source: info.label,
      spot,
      at: Date.now(),
    };
    // 同一张图重复下到时更新记录而不是再插一条
    index.items = index.items.filter(x => x.id !== id);
    index.items.unshift(rec);
    if (index.items.length > 40) {
      // 只留最近 40 条，并把被淘汰的文件删掉，避免 data/ 无限长大
      const dropped = index.items.splice(40);
      for (const d of dropped) {
        try { fs.unlinkSync(path.join(panoDir, d.file)); } catch { /* 忽略 */ }
      }
    }
    persist();
    return { ok: true, record: rec };
  }

  /**
   * 自动获取：按候选顺序逐个试，**第一个通过校验的就算成功**。
   * 失败尝试会带上原因一起返回，便于如实告诉用户"试了哪些、为什么都不行"。
   */
  async function acquire(spot, { city, limit = 6, timeout = 20000 } = {}) {
    const { candidates, failures } = await searchCandidates(spot, { city, limit });
    const tried = [];
    for (const c of candidates) {
      try {
        const r = await fetchOne(c.url, { spot, timeout });
        if (r.ok) {
          return { ok: true, record: r.record, tried, searchFailures: failures, candidate: c };
        }
        tried.push({ url: c.url, title: c.title, reason: r.reason });
      } catch (e) {
        tried.push({ url: c.url, title: c.title, reason: e.message.split('\n')[0] });
      }
    }
    const err = new Error(
      `没能为「${spot}」找到可用的等距柱状全景图。\n`
      + `试过 ${tried.length} 个候选，逐个的原因：\n`
      + tried.map(t => `  · ${t.title || t.url}\n    ${t.reason}`).join('\n'),
    );
    err.code = 'NO_USABLE_PANO';
    err.tried = tried;
    throw err;
  }

  function list() {
    return index.items.map(({ file, ...rest }) => rest);
  }

  function get(id) {
    return index.items.find(x => x.id === id) || null;
  }

  /** 读出图片字节，供 HTTP 接口回给浏览器 */
  function readImage(id) {
    const rec = get(id);
    if (!rec) return null;
    const fp = path.join(panoDir, rec.file);
    if (!fs.existsSync(fp)) return null;
    const mime = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[rec.format] || 'application/octet-stream';
    return { buffer: fs.readFileSync(fp), mime, record: rec };
  }

  function remove(id) {
    const rec = get(id);
    if (!rec) return false;
    try { fs.unlinkSync(path.join(panoDir, rec.file)); } catch { /* 忽略 */ }
    index.items = index.items.filter(x => x.id !== id);
    persist();
    return true;
  }

  return {
    dir: panoDir,
    searchCandidates,
    fetchOne,
    acquire,
    list,
    get,
    readImage,
    remove,
    maxMB,
  };
}

module.exports = {
  createPano,
  searchCandidates,
  searchImages,
  parseBingImages,
  parseBaiduImages,
  parseImageSize,
  isEquirectangular,
  hostInfo,
  looksLikeImage,
  PANO_HOSTS,
  RATIO_MIN,
  RATIO_MAX,
  DEFAULT_MAX_MB,
};
