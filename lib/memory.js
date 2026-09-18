/**
 * memory.js —— 机体记忆（长期记忆）本地实现
 *
 * airi 原版的机体记忆依赖 Postgres + pgvector（packages/memory-pgvector），
 * 对一个"一键部署、数据不出本机"的赛题交付物来说太重了。这里做了等价替换：
 *
 *   存储：data/memory.json（纯本地文件，可随时导出/备份/删除）
 *   检索：混合检索
 *       ① 语义召回 —— 若本机装了向量模型，用 Ollama /api/embeddings 算余弦相似度
 *       ② 词法召回 —— 无向量模型时的兜底，用「中文字符二元组 + 英文词」做 TF-IDF 式打分
 *      两条路都可用时按权重融合，保证「装没装向量模型都能用」。
 *
 * 为什么要专门为中文写词法检索：中文没有空格分词，按英文那套空格切词会把整句当成一个词，
 * 检索几乎必然失效。字符二元组（bigram）是零依赖条件下最稳的中文近似分词方案。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STOP = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'it', 'that', 'this',
]);

/** 中文按字符二元组切、英文数字按词切 —— 零依赖下最稳的中文近似分词 */
function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];
  // 英文/数字词
  for (const m of s.matchAll(/[a-z0-9]+/g)) {
    if (m[0].length > 1 && !STOP.has(m[0])) tokens.push(m[0]);
  }
  // 中文：先取出连续中文串，再滑窗取相邻两字
  for (const m of s.matchAll(/[\u4E00-\u9FFF]+/g)) {
    const run = m[0];
    if (run.length === 1) { tokens.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return tokens;
}

function termFreq(text) {
  const tf = new Map();
  for (const t of tokenize(text)) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function createMemory({ dir, ollama, file = 'memory.json', maxItems = 5000 }) {
  const filePath = path.join(dir, file);
  fs.mkdirSync(dir, { recursive: true });

  /** @type {Array<{id:string,ts:number,kind:string,role:string,text:string,tags:string[],sessionId:string,embedding:number[]|null}>} */
  let items = [];
  let dirty = false;

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        items = Array.isArray(raw.items) ? raw.items : [];
      }
    } catch (e) {
      // 记忆文件损坏不能让整个服务起不来：备份坏文件后从空记忆继续
      console.error('[memory] 记忆文件损坏，已备份为 memory.corrupt.json 并重新开始：', e.message);
      try { fs.copyFileSync(filePath, path.join(dir, 'memory.corrupt.json')); } catch { /* 忽略 */ }
      items = [];
    }
  }
  load();

  let flushTimer = null;
  function persist() {
    dirty = true;
    if (flushTimer) return;
    // 攒 300ms 合并写盘，避免流式对话时每句话都触发磁盘 IO
    flushTimer = setTimeout(() => {
      flushTimer = null;
      if (!dirty) return;
      dirty = false;
      try {
        const tmp = `${filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, updatedAt: Date.now(), items }, null, 0), 'utf8');
        fs.renameSync(tmp, filePath);          // 原子替换，防止写一半断电导致记忆全丢
      } catch (e) {
        console.error('[memory] 写入失败：', e.message);
      }
    }, 300);
  }

  /** 异步补算向量；失败就留 null，检索时自动走词法通道 */
  async function attachEmbedding(rec) {
    try {
      const { embedModel } = await ollama.resolveModels();
      if (!embedModel) return;
      const [vec] = await ollama.embed({ model: embedModel, input: rec.text });
      rec.embedding = vec;
      rec.embedModel = embedModel;
      persist();
    } catch {
      // 没有向量模型是正常状态，不是错误 —— 词法检索照样能用
    }
  }

  async function add({ text, role = 'user', kind = 'turn', tags = [], sessionId = 'default', embed: doEmbed = true }) {
    const clean = String(text || '').trim();
    if (!clean) return null;
    const rec = {
      id: crypto.randomUUID(),
      ts: Date.now(),
      kind, role,
      text: clean.slice(0, 4000),
      tags: Array.isArray(tags) ? tags.filter(Boolean).slice(0, 12) : [],
      sessionId,
      embedding: null,
    };
    items.push(rec);
    if (items.length > maxItems) items = items.slice(items.length - maxItems);
    persist();
    if (doEmbed) attachEmbedding(rec);          // 不 await：写记忆必须立刻返回，向量后台补
    return rec;
  }

  /**
   * 混合检索。
   * @param {string} query
   * @param {{limit?:number, kind?:string, sessionId?:string}} opts
   */
  async function search(query, { limit = 6, kind, sessionId } = {}) {
    const q = String(query || '').trim();
    const pool = items.filter(it => (!kind || it.kind === kind) && (!sessionId || it.sessionId === sessionId));
    if (!q || !pool.length) return [];

    // ---- 通道一：词法（永远可用）----
    const qtf = termFreq(q);
    const df = new Map();
    const docTfs = pool.map((it) => {
      const tf = termFreq(it.text);
      for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
      return tf;
    });
    const N = pool.length;
    const lexical = pool.map((it, i) => {
      let score = 0;
      for (const [t, qc] of qtf) {
        const c = docTfs[i].get(t);
        if (!c) continue;
        const idf = Math.log(1 + N / (1 + (df.get(t) || 0)));   // 越罕见越有区分度
        score += (1 + Math.log(c)) * idf * qc;
      }
      // 标签命中额外加权：用户显式打的城市/业态标签比正文更可信
      for (const tag of it.tags) if (q.includes(tag)) score += 1.5;
      // 时间衰减：两周半衰，让"最近聊过的"更容易被想起
      const ageDays = (Date.now() - it.ts) / 86400000;
      const recency = Math.exp(-ageDays / 14);
      return { it, score: score * (0.6 + 0.4 * recency) };
    });

    // ---- 通道二：语义（有向量模型时）----
    let semantic = null;
    try {
      const { embedModel } = await ollama.resolveModels();
      // 只跟「用同一个向量模型算出来的」向量做比较。
      //
      // 为什么必须过滤：余弦相似度只有落在同一个向量空间里才有意义。切过向量模型之后
      // （本地换模型，或在「设置 → 模型接入」里把向量切到外部 API），旧向量和新向量
      // 的维度与语义空间都不一样，硬比出来的分数是纯噪声 —— 而且它比"召回不到"更糟：
      // 会以一种看起来很正常的分数，把毫不相关的记忆排到最前面。
      // 没有 embedModel 标签的旧数据同样排除（无从得知它当初是用哪个模型算的）。
      // 这些记忆并不会丢 —— 词法通道照样检索得到，只是不参与语义打分。
      const withVec = pool.filter(it => Array.isArray(it.embedding) && it.embedModel === embedModel);
      if (embedModel && withVec.length) {
        const [qv] = await ollama.embed({ model: embedModel, input: q });
        semantic = new Map();
        for (const it of withVec) semantic.set(it.id, cosine(qv, it.embedding));
      }
    } catch { semantic = null; }

    const merged = lexical.map(({ it, score }) => {
      const lex = score / (Math.max(...lexical.map(l => l.score), 1e-6));
      const sem = semantic ? (semantic.get(it.id) || 0) : 0;
      // 有语义通道时 6:4 融合，纯词法时就是词法分本身
      const final = semantic ? 0.4 * lex + 0.6 * sem : lex;
      return { ...it, score: final };
    });

    return merged
      .filter(r => r.score > 0.01)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** 把召回的记忆拼成可注入提示词的文本 */
  async function buildContext(query, limit = 5) {
    const hits = await search(query, { limit });
    if (!hits.length) return { text: '', hits: [] };
    const lines = hits.map((h) => {
      const d = new Date(h.ts);
      const stamp = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const label = h.kind === 'fact' ? '事实' : h.role === 'user' ? '用户' : 'AIRI';
      return `- [${stamp}] (${label}) ${h.text.replace(/\s+/g, ' ').slice(0, 300)}`;
    });
    return { text: lines.join('\n'), hits };
  }

  function list({ limit = 200, offset = 0, kind } = {}) {
    const pool = kind ? items.filter(i => i.kind === kind) : items;
    return { total: pool.length, items: pool.slice().reverse().slice(offset, offset + limit) };
  }

  function remove(id) {
    const n = items.length;
    items = items.filter(i => i.id !== id);
    if (items.length !== n) { persist(); return true; }
    return false;
  }

  function clear() {
    items = [];
    persist();
  }

  async function stats() {
    let embedModel = null;
    try { embedModel = (await ollama.resolveModels()).embedModel; } catch { /* Ollama 未启动 */ }
    // 把"有向量"和"当前模型下能用的向量"分开报。
    // 两者相等时才是真正的混合检索；不相等说明有历史向量因为换过模型而失效，
    // 这时如实告诉用户，比笼统报一个 withEmbedding 更容易排查"为什么检索变差了"。
    const withEmbedding = items.filter(i => Array.isArray(i.embedding)).length;
    const usable = items.filter(i => Array.isArray(i.embedding) && embedModel && i.embedModel === embedModel).length;
    return {
      total: items.length,
      withEmbedding,
      usableEmbedding: usable,
      staleEmbedding: withEmbedding - usable,
      facts: items.filter(i => i.kind === 'fact').length,
      turns: items.filter(i => i.kind === 'turn').length,
      embedModel,
      mode: embedModel ? (usable ? 'hybrid(语义+词法)' : 'lexical(纯词法：现存向量与当前模型不匹配)') : 'lexical(纯词法)',
      file: filePath,
    };
  }

  return { add, search, buildContext, list, remove, clear, stats, get path() { return filePath; } };
}

module.exports = { createMemory, tokenize, cosine };
