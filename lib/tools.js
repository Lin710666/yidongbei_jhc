/**
 * tools.js —— 给模型用的工具（function calling）定义与调度
 *
 * 这一层解决的是"模型想上网，但它只会说话"的问题：把能力描述成 JSON Schema
 * 交给模型，模型决定调哪个、传什么参数，我们负责真正执行并把结果**压缩成
 * 它能读的文本**再喂回去。
 *
 * 三条设计要点：
 *
 *   1. **给模型看的文本要短。** 工具结果会直接进上下文，一次抓回来 4MB 网页
 *      塞进去，轻则把 num_ctx 顶爆、重则模型开始胡言乱语。所以每个工具都有
 *      明确的结果上限，并且截断时如实标注"已截断"。
 *   2. **参数来自模型，必须校验。** 缺参、类型不对、URL 非法都要变成一条
 *      "工具返回的错误信息"回给模型，让它自己纠正后重试 —— 而不是直接抛异常
 *      把整轮对话打断。模型看不到异常，只会看到空白，然后开始编。
 *   3. **结果分两份**：`forModel` 给模型读，`data` 给程序用（比如全景候选图
 *      要交给前端渲染）。混在一起会导致"为了让程序好用而把上下文撑爆"。
 */

const web = require('./web');
// 全景检索的实现在 lib/pano.js（那边还要负责下载与校验），这里只做转述。
const panoLib = require('./pano');

/** 工具执行结果里，回给模型的最大字符数 */
const MODEL_TEXT_LIMIT = Number(process.env.TOOL_TEXT_LIMIT || 6000);

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        '联网搜索。当你需要最新的、训练数据里没有的信息时用它：景区最新开放时间与票价、'
        + '当前天气、最近的活动与节庆、某个具体地点是否存在、交通方式等。'
        + '返回若干条搜索结果的标题、网址与摘要。'
        + '**如果摘要里没有你需要的具体数字或细节，不要就此放弃，请用 web_fetch 打开其中'
        + '最相关的一条链接读取正文** —— 摘要往往被截断，正文里才有票价、时间这类信息。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词。用具体的词效果更好，例如「杭州西湖 2026 门票 开放时间」' },
          limit: { type: 'integer', description: '返回几条结果，1~10，默认 6。除非只想要某一个特定结果，否则别设成 1' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        '抓取一个网页并返回其正文纯文本。用于读取搜索结果里某条链接的详细内容。'
        + '只能抓 http/https 的公网地址，内网与本机地址会被拒绝。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '要读取的完整网址' },
          max_chars: { type: 'integer', description: '最多返回多少字符，默认 6000' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_panorama',
      description:
        '为一个景点查找可用的 360 度全景图（等距柱状投影，宽高比 2:1）。'
        + '当你需要把这个景点做成可环视的三维场景时使用。'
        + '返回若干候选图片地址及其来源，程序会自行挑选并校验。',
      parameters: {
        type: 'object',
        properties: {
          spot: { type: 'string', description: '景点名称，例如「杭州西湖」' },
          city: { type: 'string', description: '所在城市，可选，用于提高命中率' },
        },
        required: ['spot'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'avatar_action',
      description:
        '控制屏幕上这个虚拟形象本人：换表情、做一个动作、举一块牌子。'
        + '当用户说"笑一个""挥挥手""跳个舞""举牌"，或者你想用动作配合语气时用它。'
        + '**它只影响画面，不产生任何文字回答**，所以调用完仍要继续正常作答。'
        + '可用的动作名与表情名见系统提示里列出的清单，不要凭空编造。',
      parameters: {
        type: 'object',
        properties: {
          motion: {
            type: 'string',
            description: '要播放的动作名（用清单里的名字）。也可以只给动作组名，如 Idle、TapBody',
          },
          expression: {
            type: 'string',
            description: '要切换的表情名（用清单里的名字）。不传表示不变',
          },
          placard: {
            type: 'string',
            description:
              '在形象手里举一块木牌，牌面上写这段文字（不超过 20 字，宜短）。'
              + '传空字符串表示把牌子放下。不传这个字段则完全不碰牌子',
          },
        },
      },
    },
  },
];

/** 便于按名字查 schema */
const TOOL_NAMES = TOOL_SCHEMAS.map(t => t.function.name);

/**
 * 已知提供 360 全景的平台/站点特征 —— 实际定义在 lib/pano.js，
 * 这里原样转出，避免两处各维护一份（那必然会漂移）。
 */
const PANORAMA_HOSTS = panoLib.PANO_HOSTS;
const hostLabel = panoLib.hostInfo;
const looksLikeImage = panoLib.looksLikeImage;

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? `${str.slice(0, n)}\n…（已截断，原文共 ${str.length} 字）` : str;
}

/* ==========================================================================
 * 各工具的实现
 * ========================================================================*/

async function toolWebSearch(args = {}) {
  const query = String(args.query || '').trim();
  if (!query) {
    return { ok: false, error: '缺少 query 参数（要搜索的关键词）' };
  }
  const limit = Math.min(Math.max(Number(args.limit) || 6, 1), 10);

  const r = await web.search(query, { limit });
  const lines = r.results.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet || '（无摘要）'}`);
  const text = truncate(
    `搜索引擎：${r.engineLabel}　关键词：${query}\n\n${lines.join('\n\n')}`,
    MODEL_TEXT_LIMIT,
  );
  return {
    ok: true,
    forModel: text,
    summary: `${r.engineLabel} 搜到 ${r.results.length} 条`,
    data: { query, engine: r.engine, results: r.results },
  };
}

async function toolWebFetch(args = {}) {
  const url = String(args.url || '').trim();
  if (!url) return { ok: false, error: '缺少 url 参数' };
  const maxChars = Math.min(Math.max(Number(args.max_chars) || 6000, 500), MODEL_TEXT_LIMIT);

  const page = await web.readPage(url, { maxChars });
  const text = truncate(
    `标题：${page.title || '（无）'}\n网址：${page.url}\n\n${page.text}`,
    MODEL_TEXT_LIMIT,
  );
  return {
    ok: true,
    forModel: text,
    summary: `读取 ${new URL(page.url).hostname}（${page.text.length} 字）`,
    data: { url: page.url, title: page.title, text: page.text },
  };
}

/**
 * 找全景图。
 *
 * 检索逻辑复用 lib/pano.js 的 `searchCandidates` —— 那边同时服务于
 * "给模型看看有哪些候选"和"真的下载并建场景"两条路。写两份的话，
 * 迟早出现"模型说有、程序却下不到"这种对不上的情况。
 */
async function toolFindPanorama(args = {}) {
  const spot = String(args.spot || '').trim();
  if (!spot) return { ok: false, error: '缺少 spot 参数（景点名称）' };
  const city = String(args.city || '').trim();

  let r;
  try {
    r = await panoLib.searchCandidates(spot, { city, limit: 8 });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const top = r.candidates;
  if (!top.length) return { ok: false, error: `没能搜到「${r.spot}」的全景图候选。` };

  const lines = top.map((c, i) =>
    `${i + 1}. ${c.title}\n   ${c.url}\n   来源：${c.source}${c.looksLikeImage ? '（直链图片）' : ''}`);
  const text = truncate(
    `「${r.spot}」的全景图候选（按可用性排序）：\n\n${lines.join('\n\n')}\n\n`
    + '注意：等距柱状全景图宽高比应为 2:1，程序会下载并校验；全部不合格时会如实报错。',
    MODEL_TEXT_LIMIT,
  );

  return {
    ok: true,
    forModel: text,
    summary: `找到 ${top.length} 个全景候选`,
    data: { spot: r.spot, candidates: top },
  };
}

/**
 * 形象动作（换表情 / 做动作 / 举牌）。
 *
 * 这个工具和前三个有本质区别：它**不产生任何给模型读的信息**，只是把"要做什么"
 * 打包成 `data` 交给前端执行。
 *
 * 为什么非要在前端执行：agent 循环跑在服务端，而"这只模型有哪些动作、表情叫什么"
 * 只有浏览器把模型加载完之后才知道 —— 那个清单在模型文件里，服务端不去解析它。
 * 所以服务端只负责把意图传下去，真正的名字模糊匹配与播放（含找不到时的退化）
 * 在 public/js/live2d.js 与 stage3d.js 里。
 *
 * 能力清单由前端随请求上报（ctx.avatar）。有清单时顺手校验一遍：
 * 模型编一个不存在的动作名时，与其"说了挥手却没反应"，不如把可用的名字
 * 作为工具错误回给它，让它自己改 —— 这是本项目对工具错误的一贯处理方式。
 */
async function toolAvatarAction(args = {}, ctx = {}) {
  const caps = (ctx && ctx.avatar) || null;
  const motionList = (caps && caps.motions) || [];
  const exprList = (caps && caps.expressions) || [];

  const pickName = (wantRaw, list) => {
    const want = String(wantRaw || '').trim().toLowerCase();
    if (!want) return { ok: true, name: '' };
    if (!list.length) return { ok: true, name: String(wantRaw).trim(), unverified: true };
    const names = list.map(x => String(x.name || x).trim());
    const exact = names.find(n => n.toLowerCase() === want);
    if (exact) return { ok: true, name: exact };
    // 组名要在"子串匹配"**之前**判：否则模型说 `Idle`（想在该组里随机播一个）时，
    // 会先被子串匹配抢中 `00_idle` 这个具体动作，语义就从"随机"变成了"就播那个"。
    const grp = list.find(x => x.group && String(x.group).toLowerCase() === want);
    if (grp) return { ok: true, name: String(grp.group), isGroup: true };
    const part = names.find(n => n.toLowerCase().includes(want));
    if (part) return { ok: true, name: part };
    return { ok: false, available: names };
  };

  const avatar = {};
  const parts = [];

  if (args.motion != null && String(args.motion).trim()) {
    const r = pickName(args.motion, motionList);
    if (!r.ok) {
      return {
        ok: false,
        error: `没有名为「${args.motion}」的动作。可用的有：${r.available.join('、') || '（清单为空）'}`,
      };
    }
    avatar.motion = r.name;
    parts.push(r.isGroup ? `动作组 ${r.name}` : `动作 ${r.name}`);
  }

  if (args.expression != null && String(args.expression).trim()) {
    const r = pickName(args.expression, exprList);
    if (!r.ok) {
      return {
        ok: false,
        error: `没有名为「${args.expression}」的表情。可用的有：${r.available.join('、') || '（该形象没有可切换的表情）'}`,
      };
    }
    avatar.expression = r.name;
    parts.push(`表情 ${r.name}`);
  }

  // 用 in 判断而不是真值：placard:'' 是"把牌子放下"的合法指令，
  // 用真值判断会把"放下牌子"和"没提牌子"混为一谈，牌子永远放不下来。
  if ('placard' in args) {
    const text = String(args.placard == null ? '' : args.placard).trim().slice(0, 60);
    avatar.placard = text;
    parts.push(text ? `举牌「${text}」` : '放下牌子');
  }

  if (!parts.length) {
    return { ok: false, error: '没有给出 motion / expression / placard 中的任何一个，不知道该做什么' };
  }

  return {
    ok: true,
    forModel: `已让形象${parts.join('、')}。这只是画面变化，请继续照常回答用户。`,
    summary: parts.join('、'),
    data: { avatar },
  };
}

/* ==========================================================================
 * 调度
 * ========================================================================*/
const IMPL = {
  web_search: toolWebSearch,
  web_fetch: toolWebFetch,
  find_panorama: toolFindPanorama,
  avatar_action: toolAvatarAction,
};

/**
 * 执行一个工具调用。
 *
 * **任何失败都不抛异常**，而是返回 { ok:false, forModel:'…错误说明…' }。
 * 原因见文件头第 2 条：模型看不到异常，只会看到空结果然后开始编造。
 * 把错误当成"工具的输出"回给它，它才有机会换关键词、换个网址重试。
 *
 * @param {string} name
 * @param {object|string} args
 * @param {object} [ctx] 调用方上下文。目前只有 avatar_action 用得到 ——
 *   它需要前端上报的"这只模型有哪些动作/表情"才能校验名字。
 */
async function runTool(name, args, ctx) {
  const fn = IMPL[name];
  if (!fn) {
    return {
      ok: false,
      name,
      forModel: `错误：不存在名为 ${name} 的工具。可用工具：${TOOL_NAMES.join('、')}`,
      summary: `未知工具 ${name}`,
    };
  }
  let parsedArgs = args;
  if (typeof args === 'string') {
    try { parsedArgs = JSON.parse(args || '{}'); } catch {
      return {
        ok: false, name,
        forModel: `错误：参数不是合法 JSON（收到：${String(args).slice(0, 200)}）`,
        summary: '参数解析失败',
      };
    }
  }

  try {
    const r = await fn(parsedArgs || {}, ctx || {});
    if (!r.ok) {
      return { ok: false, name, forModel: `工具执行失败：${r.error}`, summary: String(r.error).split('\n')[0], data: null };
    }
    return { ok: true, name, forModel: r.forModel, summary: r.summary, data: r.data };
  } catch (e) {
    // web.js 抛出的错误在这里被转成"给模型的说明"
    return {
      ok: false, name,
      forModel: `工具执行失败（${e.code || 'ERROR'}）：${e.message}`,
      summary: `${e.code || 'ERROR'}：${String(e.message).split('\n')[0]}`,
      data: null,
    };
  }
}

module.exports = {
  TOOL_SCHEMAS,
  TOOL_NAMES,
  PANORAMA_HOSTS,
  runTool,
  looksLikeImage,
  hostLabel,
};
