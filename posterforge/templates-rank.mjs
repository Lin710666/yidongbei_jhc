/**
 * templates-rank.mjs —— 模板检索增强。
 *
 * 为什么这么做而不是"训练一个模型"：
 *   本机 8GB 显存、没有标注数据集，微调做不了；而同类系统（LayoutRAG 等）
 *   的主流做法本来就是**检索增强** —— 不指望模型记住模板库，而是按需求
 *   从库里检索最匹配的几套再交给文案模型。这样模板库改了立刻生效，
 *   不需要重新训练任何东西。
 *
 * 三段式：
 *   1. 离线索引：把每套模板的可检索文本（标题+标签+示例内容）向量化，落盘缓存
 *   2. 在线检索：把用户原话向量化，余弦相似度取 top-k
 *   3. 反馈排序：乘上"被套用次数"的增益 —— 用户真选过的模板往上抬
 *
 * 嵌入模型用本机已有的 nomic-embed-text（Ollama），不额外下载任何东西。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const EMBED_MODEL = process.env.PF_EMBED_MODEL || "nomic-embed-text";
const OLLAMA = process.env.PF_OLLAMA || "http://127.0.0.1:11434";

export class RankError extends Error {
  constructor(message, stage) {
    super(message);
    this.name = "RankError";
    this.stage = stage;
  }
}

/** 调 Ollama 拿一段文本的向量 */
export async function embed(text, { timeoutMs = 20000 } = {}) {
  const body = JSON.stringify({ model: EMBED_MODEL, prompt: String(text || "") });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${OLLAMA}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ctl.signal,
    });
    if (!r.ok) throw new RankError(`嵌入接口返回 ${r.status}`, "http");
    const j = await r.json();
    const v = j.embedding;
    if (!Array.isArray(v) || !v.length) throw new RankError("嵌入接口没返回向量", "shape");
    return v;
  } catch (e) {
    if (e.name === "AbortError") throw new RankError("嵌入超时（Ollama 未运行？）", "timeout");
    throw e instanceof RankError ? e : new RankError(String(e.message || e), "network");
  } finally {
    clearTimeout(timer);
  }
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * 均值中心化。
 *
 * 为什么需要：短中文文本上，嵌入模型有明显的 hub 现象 ——
 * 少数向量天然离所有查询都近。实测「酒店秋季促销」在四个完全不同的查询里
 * 全部排第二，包括「公司年会聚餐套餐」这种跟酒店促销无关的查询。
 * 减掉语料均值后，向量围绕原点分布，公共成分被消掉，区分度显著回升。
 * 这是检索里的标准做法，成本只是两次向量减法。
 */
function meanVector(vectors) {
  const n = vectors.length;
  if (!n) return null;
  const dim = vectors[0].length;
  const mean = new Float64Array(dim);
  let used = 0;
  for (const v of vectors) {
    if (!v || v.length !== dim) continue;
    for (let i = 0; i < dim; i++) mean[i] += v[i];
    used++;
  }
  if (!used) return null;
  for (let i = 0; i < dim; i++) mean[i] /= used;
  return Array.from(mean);
}

function center(vec, mean) {
  if (!mean || !vec || vec.length !== mean.length) return vec;
  const out = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] - mean[i];
  return out;
}

/** 受众的中文说法。audience 字段本身是英文（hotel/restaurant/bureau），
 *  直接嵌进去对中文查询几乎没有贡献，换成中文词才有区分度。 */
const AUDIENCE_CN = {
  hotel: "酒店 民宿 度假 住宿 客房",
  restaurant: "餐厅 饭馆 餐饮 菜品 套餐 茶饮",
  bureau: "文旅 景区 政务 活动 门票",
  tourist: "游客 打卡 旅行 攻略",
};

/**
 * 一套模板用于检索的文本。
 *
 * 关键：**先洗掉占位符噪声再嵌入**。
 * 每套模板的 brief 里都有"我的店名（改成你的…）""○○○-○○○○-○○○○"这类占位串，
 * 它们在所有模板里都一样，只会拉近所有向量、稀释区分度 ——
 * 实测带噪声时"公司年会聚餐套餐"检索不到「餐厅午市套餐」，洗掉后才排上来。
 */
export function searchableText(t) {
  const clean = String(t.brief || "")
    .replace(/[○〇]+[-○〇@.·]*/g, " ")            // ○○○ 占位符
    .replace(/[（(][^）)]*(改成|替换|填你)[^）)]*[）)]/g, " ")  // （改成你的店名）
    .replace(/我的(店名|餐厅名|酒店名|民宿名|茶室名|品牌名|打卡点)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [
    t.title,
    (t.tags || []).join(" "),
    AUDIENCE_CN[t.audience] || "",
    clean,
  ].filter(Boolean).join("。");
}

function contentKey(t) {
  return createHash("sha1").update(searchableText(t)).digest("hex").slice(0, 12);
}

/**
 * 建/更新索引。只对内容变了的模板重新嵌入 ——
 * 嵌入要走一次模型调用，全量重算在模板库变大后会明显变慢。
 */
export async function buildIndex(templates, cacheFile, { log = () => {} } = {}) {
  let cache = { model: EMBED_MODEL, items: {} };
  if (existsSync(cacheFile)) {
    try {
      const raw = JSON.parse(readFileSync(cacheFile, "utf8"));
      // 换了嵌入模型，旧向量不可比，整个作废
      if (raw.model === EMBED_MODEL && raw.items) cache = raw;
      else log("嵌入模型变了，索引重建");
    } catch { log("索引缓存损坏，重建"); }
  }

  let reused = 0, added = 0;
  const items = {};
  for (const t of templates) {
    const key = contentKey(t);
    const hit = cache.items[t.id];
    if (hit && hit.key === key) {
      items[t.id] = hit;
      reused++;
      continue;
    }
    try {
      const vec = await embed(searchableText(t));
      items[t.id] = { key, vec };
      added++;
    } catch (e) {
      log(`模板 ${t.id} 嵌入失败（跳过）：${e.message}`);
    }
  }

  const out = {
    model: EMBED_MODEL,
    updatedAt: new Date().toISOString(),
    // 语料均值：检索时对查询向量与条目向量同时减掉它，抑制 hub 现象
    mean: meanVector(Object.values(items).map((x) => x.vec)),
    items,
  };
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(out), "utf8");
  } catch (e) {
    log("索引落盘失败（不影响本次检索）：" + e.message);
  }
  return { index: out, reused, added };
}

/**
 * 检索 top-k。
 *
 * 打分 = 余弦相似度 × (1 + 反馈增益)
 *   反馈增益 = FEEDBACK_W * log1p(picked)
 * 为什么用 log：第一个采纳很有信息量，第五十个不该再线性放大，
 * 否则热门模板会永久霸榜，新模板没有出头机会。
 */
const FEEDBACK_W = 0.18;

export async function rank(query, templates, index, { topK = 3 } = {}) {
  if (!templates.length) return [];
  let qv;
  try {
    qv = await embed(query);
  } catch (e) {
    // 检索失败不能挡住主流程：退回"按采纳次数+热度"的朴素排序
    return templates
      .map((t) => ({ template: t, score: 0, fallback: true }))
      .sort((a, b) => (b.template.picked || 0) - (a.template.picked || 0)
        || (b.template.likes || 0) - (a.template.likes || 0))
      .slice(0, topK);
  }

  // 查询向量与条目向量都在同一中心化空间里比，否则会被公共成分主导
  const mean = index?.mean || null;
  const qc = center(qv, mean);

  const scored = templates.map((t) => {
    const hit = index?.items?.[t.id];
    const sim = hit ? cosine(qc, center(hit.vec, mean)) : 0;
    const boost = 1 + FEEDBACK_W * Math.log1p(t.picked || 0);
    return { template: t, sim: Number(sim.toFixed(4)), score: Number((sim * boost).toFixed(4)) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/** 给前端/接口用的状态 */
export function rankStatus(index) {
  const n = index?.items ? Object.keys(index.items).length : 0;
  return { model: EMBED_MODEL, indexed: n, updatedAt: index?.updatedAt || null };
}
