/**
 * web.js —— 联网工具层（零第三方依赖，仅用 Node 内置模块）
 *
 * 给本地大模型装一双"眼睛"：能搜、能读网页。三条硬约束贯穿全文件：
 *
 *   1. **要抓的 URL 来自模型输出，属于不可信输入。**
 *      所以每个请求都要过 SSRF 检查：只允许 http/https，解析 DNS 后拒绝一切
 *      内网/回环/链路本地地址，重定向逐跳复检。否则模型（或提示注入）只要
 *      写一个 http://127.0.0.1:7860/... 就能把本机服务当成它的代理去读。
 *   2. **体量和时间必须封顶。** 抓网页是外部输入，不能让它把内存或事件循环拖死。
 *   3. **失败要能说清原因。** "搜不到"和"被网络拦了"是完全不同的问题，
 *      混成一句"搜索失败"会让用户无从下手。
 *
 * 搜索引擎不用 API Key：直接解析各家的 HTML 结果页。Bing 与百度排前面是因为
 * 中文景点内容它们的覆盖最好；DuckDuckGo 作为补充。解析全部用正则且写得保守 ——
 * 页面结构一变就返回空数组并说明"可能是解析失效"，而不是抛一个看不懂的异常。
 */

const dns = require('dns').promises;
const net = require('net');

const DEFAULT_TIMEOUT = Number(process.env.WEB_TIMEOUT_MS || 20000);
const MAX_BYTES = Number(process.env.WEB_MAX_BYTES || 4 * 1024 * 1024);
const MAX_REDIRECTS = 5;
const UA = process.env.WEB_UA
  || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function mkError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ==========================================================================
 * SSRF 防护
 * ========================================================================*/

/** 判断一个 IP 字面量是否属于"不该被抓取"的地址段 */
function isPrivateAddress(addr) {
  if (!addr) return true;
  const family = net.isIP(addr);
  if (family === 4) {
    const p = addr.split('.').map(Number);
    if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = p;
    if (a === 0) return true;                                  // 0.0.0.0/8
    if (a === 10) return true;                                 // 私有
    if (a === 127) return true;                                // 回环
    if (a === 169 && b === 254) return true;                    // 链路本地（云元数据 169.254.169.254 在这里）
    if (a === 172 && b >= 16 && b <= 31) return true;           // 私有
    if (a === 192 && b === 168) return true;                    // 私有
    if (a === 192 && b === 0) return true;                      // 192.0.0.0/24
    if (a === 100 && b >= 64 && b <= 127) return true;          // CGNAT 100.64/10
    if (a === 198 && (b === 18 || b === 19)) return true;       // 基准测试段
    if (a >= 224) return true;                                  // 组播 / 保留
    return false;
  }
  if (family === 6) {
    const s = addr.toLowerCase();
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('fe80')) return true;                      // 链路本地
    if (s.startsWith('fc') || s.startsWith('fd')) return true;  // 唯一本地
    if (s.startsWith('ff')) return true;                        // 组播
    // IPv4 映射地址（::ffff:127.0.0.1）要按 IPv4 规则再判一次
    const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateAddress(m[1]);
    return false;
  }
  return true;   // 既不是合法 v4 也不是 v6，一律拒绝
}

/**
 * 校验一个待抓取的 URL。
 *
 * 只放行 80/443：抓网页用不到别的端口，而放开端口等于给"探测本机开了哪些服务"
 * 提供了便利。真需要别的端口，走 WEB_ALLOWED_PORTS 环境变量显式打开。
 */
async function assertPublicUrl(rawUrl) {
  let u;
  try {
    u = new URL(String(rawUrl));
  } catch {
    throw mkError(`不是一个合法的网址：${String(rawUrl).slice(0, 120)}`, 'BAD_URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw mkError(`只支持 http/https，收到的是 ${u.protocol}`, 'BAD_URL');
  }

  const host = u.hostname;
  // 先判"是不是内网"，再判端口。
  // 顺序有讲究：127.0.0.1:8000 两条都犯，先报"内网地址"才是真正的原因，
  // 报"端口不允许"会把人的注意力引到错误的方向（去改端口白名单，然后还是连不上）。
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw mkError(`拒绝访问内网/本机地址：${host}（这是为了防止把本服务当成内网代理）`, 'BLOCKED_PRIVATE');
    }
  } else if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) {
    throw mkError(`拒绝访问本机地址：${host}`, 'BLOCKED_PRIVATE');
  }

  // 只放行 80/443：抓网页用不到别的端口，而放开端口等于给"探测本机开了哪些服务"
  // 提供了便利。真需要别的端口，走 WEB_ALLOWED_PORTS 显式打开。
  const allowedPorts = String(process.env.WEB_ALLOWED_PORTS || '80,443')
    .split(',').map(s => Number(s.trim())).filter(Boolean);
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!allowedPorts.includes(port)) {
    throw mkError(`出于安全考虑只允许访问 ${allowedPorts.join('/')} 端口，收到的是 ${port}`, 'BLOCKED_PORT');
  }

  if (net.isIP(host)) return u;

  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    throw mkError(`域名解析失败：${host}`, 'DNS_FAILED');
  }
  if (!addrs.length) throw mkError(`域名解析不到地址：${host}`, 'DNS_FAILED');
  // 只要有一个解析结果落在内网就整条拒绝 —— DNS 轮询重绑定（rebinding）就是靠这个绕的
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw mkError(`域名 ${host} 解析到内网地址 ${a.address}，已拒绝（防 SSRF）`, 'BLOCKED_PRIVATE');
    }
  }
  return u;
}

/** 带上限地读取响应体：超了就直接中断，绝不把整个响应先塞进内存 */
async function readCapped(res, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > maxBytes) {
      try { res.body.cancel(); } catch { /* 忽略 */ }
      throw mkError(`页面超过 ${(maxBytes / 1024 / 1024).toFixed(1)}MB 上限，已停止读取`, 'TOO_LARGE');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 抓一个 URL，返回 { url, status, contentType, body(Buffer) }。
 * 重定向手动跟（最多 MAX_REDIRECTS 跳），每一跳都重新做 SSRF 校验 ——
 * 用 fetch 的自动重定向会跳过校验，等于留了个后门。
 */
async function fetchRaw(rawUrl, { timeout = DEFAULT_TIMEOUT, maxBytes = MAX_BYTES, accept, headers } = {}) {
  let url = String(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = await assertPublicUrl(url);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    let res;
    try {
      res = await fetch(u.href, {
        redirect: 'manual',
        signal: ac.signal,
        headers: {
          'User-Agent': UA,
          Accept: accept || 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          // 调用方可以覆盖/补充请求头（例如 Nominatim 要求带可识别的 User-Agent）。
          // 放在后面覆盖，但仍然不允许改掉 Host 之类的关键头 —— 那些由 fetch 自己管。
          ...(headers || {}),
        },
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError' || e.name === 'TimeoutError') {
        throw mkError(`访问 ${u.href} 超过 ${Math.round(timeout / 1000)} 秒没有响应`, 'TIMEOUT');
      }
      // Node 的 fetch 只给一句 "fetch failed"，真正的原因藏在 cause 里。
      // 把 cause.code 提出来：ENOTFOUND 是域名解析不了、ECONNRESET 是被重置
      // （国内访问境外站点很常见）、CERT_* 是证书问题 —— 三种排查方向完全不同。
      const cause = e.cause || {};
      const detail = cause.code || cause.errno || cause.message || e.message;
      const hint = cause.code === 'ENOTFOUND' ? '（域名解析不了，可能是域名写错或 DNS 不可用）'
        : cause.code === 'ECONNRESET' || cause.code === 'UND_ERR_SOCKET' ? '（连接被重置，该站点可能被网络环境拦截）'
          : cause.code === 'ECONNREFUSED' ? '（对方拒绝连接）'
            : '';
      throw mkError(`连不上 ${u.host}：${detail}${hint}`, 'NETWORK');
    }

    // 3xx：手动跟一跳
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      clearTimeout(timer);
      try { res.body.cancel(); } catch { /* 忽略 */ }
      if (!loc) throw mkError(`服务器返回 ${res.status} 但没有 Location 头`, 'BAD_REDIRECT');
      url = new URL(loc, u.href).href;
      continue;
    }

    try {
      const body = await readCapped(res, maxBytes);
      clearTimeout(timer);
      return {
        url: u.href,
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        body,
      };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }
  throw mkError(`重定向次数超过 ${MAX_REDIRECTS} 次，已放弃`, 'TOO_MANY_REDIRECTS');
}

/* ==========================================================================
 * HTML → 纯文本
 * ========================================================================*/

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…', mdash: '—', ndash: '–',
  middot: '·', times: '×', laquo: '«', raquo: '»', deg: '°', copy: '©', reg: '®',
  trade: '™', bull: '•', prime: '′', Prime: '″', yen: '¥', euro: '€', pound: '£',
};

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10FFFF) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, ent) ? ENTITIES[ent] : m;
  });
}

/**
 * 把 HTML 变成可以喂给模型的纯文本。
 *
 * 不做完整解析（零依赖，也没必要）：去掉 script/style/noscript/svg/iframe 这类
 * 只会污染上下文的东西，块级标签转换行，其余标签直接剥掉，最后压缩空白。
 * 目标是"模型能读懂正文"，不是"还原排版"。
 */
function htmlToText(html, { maxChars = 20000 } = {}) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript|svg|iframe|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  s = s.replace(/<(br|hr)\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|header|footer|nav)\s*>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0\u3000]+/g, ' ');
  s = s.replace(/\n\s*\n\s*\n+/g, '\n\n');
  s = s.replace(/^[ \t]+|[ \t]+$/gm, '');
  s = s.trim();
  if (s.length > maxChars) s = `${s.slice(0, maxChars)}\n…（正文过长，已截断）`;
  return s;
}

/* ==========================================================================
 * 搜索引擎（无需 API Key）
 * ========================================================================*/

const ENGINES = {
  /**
   * Bing。中文景点内容覆盖好，且国内可直连。
   * 结果块形如 <li class="b_algo"><h2><a href="...">标题</a></h2>…<p>摘要</p>
   */
  bing: {
    label: 'Bing',
    url: q => `https://cn.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&ensearch=0`,
    parse(html) {
      const out = [];
      const blocks = html.split(/<li class="b_algo"/i).slice(1);
      for (const b of blocks) {
        const a = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!a) continue;
        const snip = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
        out.push({
          url: decodeEntities(a[1]),
          title: htmlToText(a[2], { maxChars: 200 }),
          snippet: snip ? htmlToText(snip[1], { maxChars: 400 }) : '',
        });
      }
      return out;
    },
  },

  /**
   * 百度。中文长尾内容最全，但结果链接是跳转链接（baidu.com/link?url=...），
   * 这里保留原始跳转地址（可读性差但能用）；模型主要参考摘要。
   */
  baidu: {
    label: '百度',
    url: q => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=20`,
    parse(html) {
      const out = [];
      const blocks = html.split(/<div[^>]+class="result[^"]*"/i).slice(1);
      for (const b of blocks) {
        const a = b.match(/<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!a) continue;
        // 百度的摘要有多种 class，取第一个像正文的块
        const snip = b.match(/<span[^>]*class="[^"]*content-right[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
          || b.match(/<div[^>]*class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
        out.push({
          url: decodeEntities(a[1]),
          title: htmlToText(a[2], { maxChars: 200 }),
          snippet: snip ? htmlToText(snip[1], { maxChars: 400 }) : '',
        });
      }
      return out;
    },
  },

  /** DuckDuckGo 的免 JS 版本，作为境外内容的补充 */
  duckduckgo: {
    label: 'DuckDuckGo',
    url: q => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    parse(html) {
      const out = [];
      const blocks = html.split(/class="result__body"/i).slice(1);
      for (const b of blocks) {
        const a = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
        if (!a) continue;
        const snip = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
        out.push({
          url: decodeEntities(a[1]),
          title: htmlToText(a[2], { maxChars: 200 }),
          snippet: snip ? htmlToText(snip[1], { maxChars: 400 }) : '',
        });
      }
      return out;
    },
  },

  /** 自建 SearXNG：设 SEARXNG_URL 即可启用，解析它的 JSON 接口最稳 */
  searxng: {
    label: 'SearXNG',
    json: true,
    url: q => `${String(process.env.SEARXNG_URL).replace(/\/+$/, '')}/search?q=${encodeURIComponent(q)}&format=json`,
    parse(json) {
      return (json.results || []).map(r => ({
        url: r.url,
        title: r.title || '',
        snippet: r.content || '',
      }));
    },
  },
};

/**
 * 联网搜索。
 *
 * 引擎按顺序逐个尝试，**第一个成功的就用**：国内网络下 Bing/百度通、DuckDuckGo 常被
 * 重置，顺序错了会出现"明明能搜却说搜不到"。全部失败时把每家的失败原因一起报出来，
 * 让用户知道是网络问题还是解析失效。
 */
async function search(query, { limit = 6, timeout = DEFAULT_TIMEOUT, engines } = {}) {
  const q = String(query || '').trim();
  if (!q) throw mkError('搜索关键词为空', 'BAD_INPUT');

  const order = engines
    || String(process.env.WEB_SEARCH_ENGINES || 'bing,baidu,duckduckgo').split(',').map(s => s.trim()).filter(Boolean);
  const failures = [];

  for (const name of order) {
    const eng = ENGINES[name];
    if (!eng) { failures.push(`${name}: 未知引擎`); continue; }
    if (name === 'searxng' && !process.env.SEARXNG_URL) { failures.push('searxng: 未配置 SEARXNG_URL'); continue; }

    try {
      const res = await fetchRaw(eng.url(q), { timeout });
      if (res.status !== 200) { failures.push(`${eng.label}: HTTP ${res.status}`); continue; }
      const text = res.body.toString('utf8');
      const parsed = eng.json ? eng.parse(JSON.parse(text)) : eng.parse(text);
      const clean = parsed
        .filter(r => r && r.url && r.title)
        .slice(0, limit)
        .map(r => ({
          title: r.title.replace(/\s+/g, ' ').trim().slice(0, 200),
          url: r.url,
          snippet: String(r.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 400),
        }));
      if (!clean.length) { failures.push(`${eng.label}: 没解析到结果（页面结构可能变了）`); continue; }
      return { query: q, engine: name, engineLabel: eng.label, results: clean, failures };
    } catch (e) {
      failures.push(`${eng.label}: ${e.message}`);
    }
  }

  throw mkError(
    `所有搜索引擎都没能返回结果。\n逐家情况：\n  · ${failures.join('\n  · ')}\n`
    + '如果是网络受限，可以设 SEARXNG_URL 指向自建的 SearXNG，或调整 WEB_SEARCH_ENGINES 顺序。',
    'SEARCH_FAILED',
  );
}

/** 取网页正文并转纯文本 */
async function readPage(url, { timeout = DEFAULT_TIMEOUT, maxChars = 20000 } = {}) {
  const res = await fetchRaw(url, { timeout });
  if (res.status !== 200) {
    throw mkError(`抓取失败：HTTP ${res.status}（${res.url}）`, 'HTTP_ERROR');
  }
  const ct = res.contentType.toLowerCase();
  const raw = res.body.toString('utf8');

  if (ct.includes('application/json')) {
    let pretty = raw;
    try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* 原样 */ }
    return { url: res.url, contentType: ct, title: '', text: pretty.slice(0, maxChars), truncated: pretty.length > maxChars };
  }
  if (ct.includes('text/plain')) {
    return { url: res.url, contentType: ct, title: '', text: raw.slice(0, maxChars), truncated: raw.length > maxChars };
  }
  if (!ct.includes('html') && !ct.includes('xml')) {
    throw mkError(`这个地址返回的不是网页（${ct || '未知类型'}），无法当正文阅读`, 'BAD_CONTENT_TYPE');
  }

  const titleM = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleM ? htmlToText(titleM[1], { maxChars: 200 }) : '';
  const text = htmlToText(raw, { maxChars });
  return { url: res.url, contentType: ct, title, text, truncated: text.length >= maxChars };
}

module.exports = {
  isPrivateAddress,
  assertPublicUrl,
  fetchRaw,
  htmlToText,
  decodeEntities,
  search,
  readPage,
  ENGINES,
  DEFAULT_TIMEOUT,
  MAX_BYTES,
};
