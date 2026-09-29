/**
 * feeds.mjs —— 联网素材适配器
 *
 * 设计立场：**不假装能拿到可商用的免费素材。**
 *
 * 实测过的现状（2026-09，本机网络）：
 *   ✅ Bing 每日壁纸   —— 无需 key，每天更新，1920×1080 实拍，带中文标题与版权署名
 *   ✅ Lorem Picsum    —— 无需 key，随机摄影图（泛用，不聚焦文旅）
 *   ❌ Pexels / Unsplash —— 需要 API Key
 *   ❌ Bilibili 搜索   —— 需要 WBI 签名，无签名返回 412，不适合做稳定数据源
 *   ❌ Wikimedia       —— 本机 SSL 握手失败
 *
 * 所以分两种源：
 *   • inspiration（灵感/参考）—— Bing、Picsum。**带版权署名展示**，只作灵感，
 *     不能当成可商用素材分发。UI 与接口都会明确标注。
 *   • assets（可商用素材）—— 需要用户自己配 Pexels/Unsplash 的 key。
 *     配了就用，没配就跳过并在状态里说明原因。
 *
 * 结果缓存在 .cache/feed.json，断网时仍能展示上次内容（离线可用）。
 */

import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";

/**
 * 把远程图片换成服务端代理地址。
 * 为什么要代理而不是直接用远程 URL：
 *   1. 浏览器直连第三方图床可能被跨域/防盗链拦掉（Bing 的 404 就是这么暴露的）
 *   2. 代理可以做本地磁盘缓存 —— 断网也能看，且不重复下载
 *   3. 统一在这里加 UA/Referer，避免个别源挑请求头
 */
function proxyUrl(remote) {
  return `/api/img?u=${encodeURIComponent(remote)}`;
}

async function jget(url, { timeoutMs = 15000, headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, ...headers }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    // Bing 的 HPImageArchive 声明 application/json 但实际带 BOM，JSON.parse 会失败
    return JSON.parse(text.replace(/^\uFEFF/, ""));
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ 源：Bing 每日壁纸 */
async function sourceBing({ count = 8, mkt = "zh-CN" } = {}) {
  const url = `https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=${Math.min(
    Math.max(count, 1),
    8
  )}&mkt=${mkt}`;
  const d = await jget(url);
  const images = d.images || [];
  return images.map((it, i) => {
    // copyright 形如 "地坛公园秋日美景，北京，中国 (© by Wei/Adobestock)"
    const copy = String(it.copyright || "");
    const m = /\(([^)]+)\)\s*$/.exec(copy);
    // Bing 的署名本身就带 ©，这里统一剥掉，避免前端再拼一个变成 "© ©"
    const credit = (m ? m[1] : "").replace(/^©\s*/, "").trim();
    const desc = m ? copy.slice(0, m.index).trim() : copy;
    return {
      id: `bing-${it.startdate || i}`,
      source: "bing",
      sourceName: "Bing 每日壁纸",
      kind: "inspiration",
      title: it.title || desc || "每日图景",
      desc,
      credit,
      date: it.startdate || "",
      // 注意：Bing 的 th?id= 端点**只认特定尺寸**，_800x450 会返回 404。
      // 实测 1920x1080 可用，所以缩略图也用这个尺寸，由前端 CSS 缩放显示。
      // 走服务端 /api/img 代理，带本地缓存 —— 断网也能看，且不重复下载。
      thumb: proxyUrl(`https://www.bing.com${it.urlbase}_1920x1080.jpg`),
      full: proxyUrl(`https://www.bing.com${it.urlbase}_1920x1080.jpg`),
      remote: `https://www.bing.com${it.urlbase}_1920x1080.jpg`,
      // 版权提示写进数据里，前端直接展示，避免"忘记标来源"
      licenseNote: "版权归署名方所有，仅作灵感参考，不可直接用于商业交付",
      tags: ["每日灵感", "实拍"],
    };
  });
}

/* ------------------------------------------------------------------ 源：Lorem Picsum */
async function sourcePicsum({ count = 8 } = {}) {
  const d = await jget(`https://picsum.photos/v2/list?page=1&limit=${Math.min(count, 30)}`);
  return (Array.isArray(d) ? d : []).map((it) => ({
    id: `picsum-${it.id}`,
    source: "picsum",
    sourceName: "Lorem Picsum",
    kind: "inspiration",
    title: it.author || "随机摄影",
    desc: "来自 Unsplash 的公开摄影图",
    date: "",
    thumb: proxyUrl(`https://picsum.photos/id/${it.id}/800/450`),
    full: proxyUrl(`https://picsum.photos/id/${it.id}/1600/900`),
    remote: `https://picsum.photos/id/${it.id}/1600/900`,
    licenseNote: "图片来源 Unsplash（Picsum 转载），仅作灵感参考",
    tags: ["摄影", "构图参考"],
    credit: (it.author || "").replace(/^©\s*/, "").trim(),
  }));
}

/* ------------------------------------------------------------------ 源：Pexels（需 key） */
async function sourcePexels({ count = 8, apiKey, query = "travel" } = {}) {
  if (!apiKey) throw new Error("未配置 PEXELS_API_KEY");
  const d = await jget(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`,
    { headers: { Authorization: apiKey }, timeoutMs: 20000 }
  );
  return (d.photos || []).map((p) => ({
    id: `pexels-${p.id}`,
    source: "pexels",
    sourceName: "Pexels",
    kind: "asset",
    title: p.alt || "Pexels 素材",
    desc: p.alt || "",
    credit: p.photographer || "",
    date: "",
    thumb: proxyUrl(p.src?.large || p.src?.medium || ""),
    full: proxyUrl(p.src?.original || p.src?.large || ""),
    remote: p.src?.original || p.src?.large || "",
    licenseNote: "Pexels 许可：可免费用于商业用途，建议保留署名",
    tags: ["可商用", "素材"],
  }));
}

/* ------------------------------------------------------------------ 源：Unsplash（需 key） */
async function sourceUnsplash({ count = 8, apiKey, query = "travel" } = {}) {
  if (!apiKey) throw new Error("未配置 UNSPLASH_ACCESS_KEY");
  const d = await jget(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${count}&orientation=landscape`,
    { headers: { Authorization: `Client-ID ${apiKey}` }, timeoutMs: 20000 }
  );
  return (d.results || []).map((p) => ({
    id: `unsplash-${p.id}`,
    source: "unsplash",
    sourceName: "Unsplash",
    kind: "asset",
    title: p.alt_description || p.description || "Unsplash 素材",
    desc: p.description || "",
    credit: p.user?.name || "",
    date: p.created_at || "",
    thumb: proxyUrl(p.urls?.small || ""),
    full: proxyUrl(p.urls?.regular || p.urls?.small || ""),
    remote: p.urls?.regular || p.urls?.small || "",
    licenseNote: "Unsplash 许可：可免费用于商业用途，须保留摄影师署名",
    tags: ["可商用", "素材"],
  }));
}

/* ------------------------------------------------------------------ 注册表 */
export const SOURCES = {
  bing: { fn: sourceBing, kind: "inspiration", label: "Bing 每日壁纸", needsKey: false },
  picsum: { fn: sourcePicsum, kind: "inspiration", label: "Lorem Picsum", needsKey: false },
  pexels: {
    fn: sourcePexels,
    kind: "asset",
    label: "Pexels",
    needsKey: true,
    envKey: "PEXELS_API_KEY",
  },
  unsplash: {
    fn: sourceUnsplash,
    kind: "asset",
    label: "Unsplash",
    needsKey: true,
    envKey: "UNSPLASH_ACCESS_KEY",
  },
};

/* ------------------------------------------------------------------ 缓存 */
export function createFeedCache(cacheFile) {
  return {
    file: cacheFile,

    async read() {
      try {
        const raw = await readFile(cacheFile, "utf8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },

    async write(obj) {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, JSON.stringify(obj, null, 2), "utf8");
    },

    async age() {
      try {
        const st = await stat(cacheFile);
        return Date.now() - st.mtimeMs;
      } catch {
        return Infinity;
      }
    },
  };
}

/**
 * 拉取所有启用的源。
 * 关键行为：**单个源失败不影响其它源**，最后一个成功的组合会被写进缓存。
 * 首页永远有东西可看 —— 这是"优雅降级"的核心。
 */
export async function fetchFeeds({
  cache,
  sources = ["bing", "picsum", "pexels", "unsplash"],
  count = 8,
  query = "travel",
  env = process.env,
} = {}) {
  const items = [];
  const status = [];

  for (const key of sources) {
    const def = SOURCES[key];
    if (!def) {
      status.push({ source: key, ok: false, reason: "未知数据源" });
      continue;
    }
    if (def.needsKey && !env[def.envKey]) {
      status.push({
        source: key,
        label: def.label,
        ok: false,
        skipped: true,
        reason: `未配置 ${def.envKey}（在 site/feed.config.json 或环境变量里填）`,
      });
      continue;
    }
    try {
      const got = await def.fn({ count, query, apiKey: def.envKey ? env[def.envKey] : undefined });
      items.push(...got);
      status.push({ source: key, label: def.label, ok: true, count: got.length, kind: def.kind });
    } catch (e) {
      status.push({ source: key, label: def.label, ok: false, reason: String(e.message || e).slice(0, 160) });
    }
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    items,
    status,
  };

  // 有内容才覆盖缓存；全失败时保留旧缓存（宁可展示昨天的，也别展示空白）
  if (items.length > 0 && cache) {
    try {
      await cache.write(payload);
    } catch {
      /* 缓存写失败不影响本次返回 */
    }
  }
  return payload;
}
