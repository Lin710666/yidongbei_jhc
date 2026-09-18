/**
 * scenery.js —— 导航模式的风景图来源（自备目录 + 联网搜索）
 *
 * 导航模式要"背景跟着所在景点换"，图从哪来有三种，本模块管后两种：
 *   · 内置程序化 —— 前端现画，不经过这里（见 public/js/nav-visuals.js）
 *   · 自备目录   —— 用户把图丢进 data/scenery/，这里按景点名去匹配
 *   · 联网搜索   —— 手动触发，搜到就下到缓存目录再给前端
 *
 * 两条刻意的设计：
 *
 *   1. **联网搜索必须显式触发，且受全局联网开关节制。** 项目的基本原则是
 *      "不联网也能用，联网要用户自己点"。所以这里不会在页面加载、切景点时
 *      偷偷发请求 —— 只有前端点了「应用」并且联网总开关是开的，才会真的去搜。
 *      搜不到就如实报错，让前端退回内置程序化风景，而不是留一片空白。
 *
 *   2. **下载的图一律落到本机缓存目录再交给前端。** 直接把外链图片地址丢给
 *      <img>/纹理会有两个问题：热链随时可能失效（今天能看明天就裂），以及
 *      用户断网后整个背景就废了。落盘之后这张图就是本机资源，和自备目录里的
 *      图走同一条路。
 *
 * 安全：所有对外暴露的文件名都过 `path.basename()` 再拼接，杜绝 `../` 穿越。
 */

const fs = require('fs');
const path = require('path');
const web = require('./web');
const pano = require('./pano');

/** 认哪些扩展名是图片 */
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif']);

/** 单张风景图大小上限。风景图不需要原图，超过这个多半是误抓了别的东西 */
const MAX_MB = 12;
const MAX_BYTES = MAX_MB * 1024 * 1024;

const mimeOf = (ext) => ({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}[String(ext).toLowerCase()] || 'application/octet-stream');

/**
 * 把文件名和景点名都归一化后再比。
 *
 * 为什么不能直接 includes：用户存的图很可能叫 `hangzhou-xihu.jpg`，
 * 而景点名是「杭州西湖」；也可能叫「西湖.jpg」而景点名是「杭州西湖」。
 * 所以既要去掉分隔符与大小写差异，也要允许"一个包含在另一个里"。
 */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s_\-·—()（）[\]【】.]/g, '');
}

/** 两个字符串的公共字符数（用于中文名的模糊兜底匹配） */
function overlap(a, b) {
  const set = new Set(b);
  let n = 0;
  for (const ch of new Set(a)) if (set.has(ch)) n++;
  return n;
}

function createScenery({ dir, prefs } = {}) {
  const root = path.join(dir || '.', 'scenery');
  const cacheDir = path.join(root, 'cache');

  function ensureDirs() {
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      // 放一张说明，省得用户对着空目录猜该往哪放图
      const readme = path.join(root, '放这里.txt');
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme,
          '导航模式的「自备风景图」目录。\n\n'
          + '把景点风景图（jpg / png / webp）直接放在这个目录下即可，不用建子目录。\n'
          + '文件名里带上景点名就会被匹配到，例如：杭州西湖.jpg、西湖-断桥.png。\n\n'
          + 'cache/ 子目录是联网搜索时自动下载的图，可以随时清空。\n'
          + '图片版权请自行确认；本程序只读取你自己放的图，不会上传到任何地方。\n',
          'utf8');
      }
    } catch { /* 目录建不出来也不该让整个功能崩掉，后续读取自然会返回空 */ }
  }

  /** 列出用户自备的图（不含 cache 子目录里的） */
  function listLocal() {
    ensureDirs();
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
    return entries
      .filter(e => e.isFile() && IMAGE_EXT.has(path.extname(e.name).toLowerCase()))
      .map(e => e.name);
  }

  /**
   * 按景点名找一张自备图。
   *
   * 匹配从紧到松分三档，取第一个命中的：完全相等 → 互相包含 → 中文字符重合 ≥2。
   * 最后一档是给"杭州西湖.jpg 对 西湖景区"这类情况兜底的；再宽就会乱配，
   * 所以到 2 个重合字为止，宁可返回"没找到"让用户自己改名。
   */
  function localFor(spot) {
    const want = norm(spot);
    if (!want) return { ok: false, error: '景点名为空' };
    const files = listLocal();
    if (!files.length) {
      return { ok: false, error: `自备目录还是空的。把图片放进 ${root} 即可（文件名里带上景点名）` };
    }

    const stems = files.map(f => ({ file: f, stem: norm(path.basename(f, path.extname(f))) }));
    let hit = stems.find(s => s.stem === want);
    if (!hit) hit = stems.find(s => s.stem.includes(want) || want.includes(s.stem));
    if (!hit) hit = stems.find(s => overlap(s.stem, want) >= 2);

    if (!hit) {
      return { ok: false, error: `目录里没有匹配「${spot}」的图（现有 ${files.length} 张）` };
    }
    return { ok: true, url: `/api/scenery/file/${encodeURIComponent(hit.file)}`, name: hit.file };
  }

  /**
   * 联网搜一张风景图并下载到缓存。
   *
   * 搜图复用了 lib/pano.js 的 `searchImages` —— 那套已经处理好了 Bing/百度的
   * 解析与失败汇总，再写一份必然会漂移。区别只在筛选：这里不要全景，
   * 只要一张横构图的普通风景照。
   */
  async function searchFor(spot, city) {
    const cfg = (prefs && prefs.getConfig && prefs.getConfig().web) || {};
    if (!cfg.enabled) {
      return { ok: false, error: '联网总开关是关的。要联网找图，请先在「外观 → 联网」里打开它（或用「内置程序化」风景，完全离线）' };
    }

    const base = city && !String(spot).includes(String(city)) ? `${city}${spot}` : String(spot);
    let r;
    try {
      r = await pano.searchImages(`${base} 风景`, { limit: 12 });
    } catch (e) {
      return { ok: false, error: `搜图请求失败：${String(e.message || e).split('\n')[0]}` };
    }
    const urls = (r && r.urls) || [];
    if (!urls.length) {
      return { ok: false, error: `没搜到「${base}」的图片${r && r.failures && r.failures.length ? `（${r.failures.join('；')}）` : ''}` };
    }

    ensureDirs();
    const tried = [];
    for (const url of urls) {
      try {
        const res = await web.fetchRaw(url, { timeout: 25000 });
        if (res.status !== 200) { tried.push(`${url} → HTTP ${res.status}`); continue; }
        const buf = res.body;
        if (!buf || buf.length < 2048) { tried.push(`${url} → 太小（${buf ? buf.length : 0}B）`); continue; }
        if (buf.length > MAX_BYTES) { tried.push(`${url} → 超过 ${MAX_MB}MB`); continue; }
        // 必须是图片：有些站点会在图片地址上返回一个 HTML 拦截页
        const info = pano.parseImageSize(buf);
        if (!info) { tried.push(`${url} → 不是可识别的图片`); continue; }

        const ext = info.format === 'jpeg' ? '.jpg' : `.${info.format}`;
        if (!IMAGE_EXT.has(ext)) { tried.push(`${url} → 不支持的格式 ${info.format}`); continue; }

        const safe = norm(spot).slice(0, 24) || 'spot';
        const name = `${safe}-${Date.now().toString(36)}${ext}`;
        const full = path.join(cacheDir, name);
        // 先写临时文件再改名：中途失败不会留下一个半截的图让前端加载出破图
        const tmp = `${full}.tmp`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, full);

        return {
          ok: true,
          url: `/api/scenery/cache/${encodeURIComponent(name)}`,
          name,
          source: url,
          width: info.width,
          height: info.height,
          bytes: buf.length,
        };
      } catch (e) {
        tried.push(`${url} → ${String(e.message || e).split('\n')[0]}`);
      }
    }
    return { ok: false, error: `搜到 ${urls.length} 个候选但都下载失败：${tried.slice(0, 3).join('；')}` };
  }

  /** 安全地取一个文件（自备目录或缓存目录），供静态接口使用 */
  function readFile(name, { cache = false } = {}) {
    // 只用 basename，杜绝 ../ 穿越 —— 这里拿的是 URL 里的字符串，绝不能直接拼
    const base = path.basename(decodeURIComponent(String(name || '')));
    if (!base || !IMAGE_EXT.has(path.extname(base).toLowerCase())) return null;
    const full = path.join(cache ? cacheDir : root, base);
    if (cache && base === 'cache') return null;
    try {
      if (!fs.statSync(full).isFile()) return null;
    } catch { return null; }
    return { full, base, mime: mimeOf(path.extname(base)) };
  }

  /** 清掉缓存目录里的联网搜图（用户可能想回收空间） */
  function clearCache() {
    let n = 0;
    try {
      for (const f of fs.readdirSync(cacheDir)) {
        if (!IMAGE_EXT.has(path.extname(f).toLowerCase())) continue;
        try { fs.unlinkSync(path.join(cacheDir, f)); n++; } catch { /* 单个删不掉就跳过 */ }
      }
    } catch { /* 目录不存在等于没有可清的 */ }
    return n;
  }

  function status() {
    const list = listLocal();
    let cached = 0;
    try {
      cached = fs.readdirSync(cacheDir).filter(f => IMAGE_EXT.has(path.extname(f).toLowerCase())).length;
    } catch { /* 还没建过 cache 目录 */ }
    return { dir: root, count: list.length, cached, files: list.slice(0, 50), maxMB: MAX_MB };
  }

  return { localFor, searchFor, readFile, listLocal, clearCache, status, ensureDirs, get dir() { return root; } };
}

module.exports = { createScenery, mimeOf, IMAGE_EXT, MAX_MB };
