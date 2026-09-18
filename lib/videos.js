/**
 * videos.js —— 视频背景（大屏宣传片）的来源与存放
 *
 * 用途：首页与舞台要让杭州文旅展示西湖美景，最直接的形式就是一段宣传视频。
 *
 * ## 为什么不做"联网找视频"
 *
 * 项目里其它素材（全景图、风景图）都留了联网搜索的口子，视频**没有**，这是有意的：
 *
 *   1. 能免费拿到的西湖实拍视频，要么来源不明、要么授权不明。宣传片是要对外展示的，
 *      素材版权出问题的代价远大于省下的那点事。
 *   2. 视频文件动辄几十上百 MB，走"搜索→下载→校验"这条路，失败率高、等待久，
 *      体验远不如让用户直接把自己手上的片子拖进来。
 *
 * 所以这里的定位是：**内置一个程序化生成的西湖动态画面兜底（前端画，不占磁盘），
 * 真要用实拍宣传片就把文件放进 data/videos/**。文件是你自己提供的，版权你自己清楚。
 *
 * ## 与 lib/backgrounds.js 的关系
 *
 * 那个模块管**图片**背景（含用户上传），走 /api/backgrounds/*。
 * 这里是**视频**，单独一组接口，因为两者的量级、校验方式与失败表现都不一样：
 * 图片几 MB、上传失败重试无痛；视频上百 MB、断在半路会留下一个坏文件，
 * 所以要多一道"大小上限 + 临时文件改名"的保护。
 */

const fs = require('fs');
const path = require('path');

/** 认哪些扩展名是视频。只收浏览器原生能播的容器，转码不在本项目范围内。 */
const VIDEO_EXT = new Set(['.mp4', '.webm', '.ogv', '.mov', '.m4v']);

/**
 * 单个视频大小上限。
 *
 * 默认 300MB：够放 3~5 分钟 1080p 的宣传片，又不至于让 15.8GB 内存的机器
 * 在读取时被拖垮。超过就该先自己压一遍 —— 网页端放 4K 原片本来也不合适。
 */
const MAX_MB = Number(process.env.WENLV_MAX_VIDEO_MB || 300);
const MAX_BYTES = Math.round(MAX_MB * 1024 * 1024);

const mimeOf = (ext) => ({
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
}[String(ext).toLowerCase()] || 'application/octet-stream');

function createVideos({ dir } = {}) {
  const root = path.join(dir || '.', 'videos');

  function ensureDir() {
    try {
      fs.mkdirSync(root, { recursive: true });
      const readme = path.join(root, '放这里.txt');
      if (!fs.existsSync(readme)) {
        fs.writeFileSync(readme,
          '大屏宣传视频放这里。\n\n'
          + '支持浏览器能直接播的格式：mp4（推荐，兼容性最好）、webm、ogv、mov、m4v。\n'
          + `单个文件上限 ${MAX_MB}MB；超过请先压缩 —— 网页端放 4K 原片自己也会卡。\n\n`
          + '文件名随意，界面上的「更换视频」会列出这个目录里的全部文件。\n'
          + '文件名里带「西湖」的会被当作默认推荐项。\n\n'
          + '版权请自行确认：这里只读取你自己放进来的文件，程序不会上传到任何地方，\n'
          + '也不会自动从网上下载视频（素材授权不明，不适合用于对外宣传）。\n',
          'utf8');
      }
    } catch { /* 建不出目录不该让整个功能崩掉，后续读取自然会返回空 */ }
  }

  /** 列出可用视频，按"名字里带西湖的优先、其次按名称"排序 */
  function list() {
    ensureDir();
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return { items: [], dir: root, maxMB: MAX_MB }; }
    const items = entries
      .filter(e => e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase()))
      .map(e => {
        let bytes = 0;
        try { bytes = fs.statSync(path.join(root, e.name)).size; } catch { /* 忽略 */ }
        return {
          id: e.name,
          name: path.basename(e.name, path.extname(e.name)),
          url: `/api/videos/file/${encodeURIComponent(e.name)}`,
          bytes,
          mime: mimeOf(path.extname(e.name)),
          // 西湖优先：这个项目的场景就是西湖宣传，用户多半就是为它放的片子
          recommended: /西湖|xihu|west\s*lake/i.test(e.name),
        };
      })
      .sort((a, b) => (Number(b.recommended) - Number(a.recommended))
        || a.name.localeCompare(b.name, 'zh'));
    return { items, dir: root, maxMB: MAX_MB };
  }

  /** 安全地取一个文件（供静态接口）。只用 basename，杜绝 ../ 穿越。 */
  function readFile(name) {
    const base = path.basename(decodeURIComponent(String(name || '')));
    if (!base || !VIDEO_EXT.has(path.extname(base).toLowerCase())) return null;
    const full = path.join(root, base);
    try {
      if (!fs.statSync(full).isFile()) return null;
    } catch { return null; }
    return { full, base, mime: mimeOf(path.extname(base)), bytes: fs.statSync(full).size };
  }

  /**
   * 保存一段上传的视频（base64）。
   *
   * 先写 `.tmp` 再改名：视频动辄上百 MB，写到一半失败（磁盘满、连接断）
   * 会留下一个半截文件。而视频的"半截"在网页上表现为**能选中但播不出来**，
   * 用户完全看不出问题在哪。改名是原子的，要么完整可用、要么根本不存在。
   */
  function save(base64, name) {
    ensureDir();
    const raw = String(base64 || '');
    if (!raw) return { ok: false, error: '视频数据为空' };
    const est = Math.floor(raw.length * 3 / 4);
    if (est > MAX_BYTES) {
      return { ok: false, error: `视频过大（约 ${(est / 1024 / 1024).toFixed(1)}MB，上限 ${MAX_MB}MB）。请先压缩后再上传。` };
    }
    let buf;
    try { buf = Buffer.from(raw, 'base64'); } catch { return { ok: false, error: '视频数据不是合法的 base64' }; }
    if (!buf.length) return { ok: false, error: '视频数据为空' };

    let ext = path.extname(String(name || '')).toLowerCase();
    if (!VIDEO_EXT.has(ext)) ext = '.mp4';        // 没给扩展名就按最通用的 mp4 存

    const stem = path.basename(String(name || 'video'), path.extname(String(name || '')))
      .replace(/[^\w\u4e00-\u9fa5-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'video';
    const finalName = `${stem}-${Date.now().toString(36)}${ext}`;
    const full = path.join(root, finalName);
    const tmp = `${full}.tmp`;
    try {
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, full);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* 忽略 */ }
      return { ok: false, error: `写入失败：${e.message}` };
    }
    return { ok: true, item: list().items.find(i => i.id === finalName) || { id: finalName }, bytes: buf.length };
  }

  function remove(id) {
    const hit = readFile(id);
    if (!hit) return { ok: false, error: '视频不存在' };
    try { fs.unlinkSync(hit.full); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
  }

  function status() {
    const l = list();
    return {
      dir: root,
      count: l.items.length,
      maxMB: MAX_MB,
      // 前端拿这一条决定"有没有可播的视频"，不必自己去翻数组
      hasAny: l.items.length > 0,
      recommended: (l.items.find(i => i.recommended) || l.items[0] || null),
    };
  }

  return { list, save, remove, readFile, status, ensureDir, mimeOf, get dir() { return root; } };
}

module.exports = { createVideos, VIDEO_EXT, MAX_MB, mimeOf };
