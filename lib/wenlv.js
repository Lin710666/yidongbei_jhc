/**
 * wenlv.js —— 文旅智能 Skill 引擎（原 yidongbei-2.2 的 server.js 逻辑抽成模块）
 *
 * 与原始版本相比，这一版多了三件事：
 *   1. 从"只能非流式"变成"流式 + 非流式都支持"，长方案不再让界面干等几十秒；
 *   2. 把可选项（城市、预算、人群、平台…）集中定义成一份常量，
 *      同时供「表单」和「交互词云」两处使用 —— 词云和表单永远不可能对不上；
 *   3. 新增 capabilities()，输出词云需要的词条 + 权重 + 点击行为。
 *
 * 原样保留的核心能力：SKILL.md 作系统提示词 + references 样本库注入 + 输出质检（audit）。
 */

const fs = require('fs');
const path = require('path');
const { createAuditor } = require('./audit');

// ===== 选项常量：词云与表单的唯一事实来源 =====
const OPTIONS = {
  budget: ['经济', '舒适', '高端'],
  crowd: ['单人', '情侣', '朋友', '亲子', '带老人', '团建'],
  interests: ['自然风光', '人文历史', '美食', '亲子', '文艺打卡', '购物'],
  diet: ['无', '素食', '忌辣', '清真'],
  product: ['景区', '酒店', '餐饮', '文创', '活动'],
  platform: ['朋友圈', '小红书', '抖音', 'OTA', '公众号'],
  audience: ['亲子家庭', '年轻情侣', '银发族', '商务', '学生'],
  style: ['种草', '亲切', '文艺', '促销', '权威'],
};

const DEFAULTS = {
  city: '杭州',
  days: 2,
  budget: '舒适',
  crowd: '朋友',
  interests: ['自然风光', '人文历史'],
  diet: '无',
  product: '景区',
  platform: '小红书',
  audience: '年轻情侣',
  style: '种草',
};

// ===== 交互词云：把本项目的全部可交互能力做成可点击的词条 =====
// weight 决定字号大小；action 是前端要执行的动作；payload 是动作参数。
const WORD_CLOUD = [
  // —— 核心功能（最大最醒目）——
  { word: '个性化方案', weight: 100, action: 'panel', payload: { tab: 'plan' }, group: '核心功能', hint: '生成游玩·旅居·餐饮一体化方案' },
  { word: '营销文案', weight: 96, action: 'panel', payload: { tab: 'marketing' }, group: '核心功能', hint: '按平台生成可直接发布的种草文案' },
  { word: '让 AI 先问我', weight: 78, action: 'intake', group: '异常处理', hint: '不填任何信息，演示信息缺失时的集中追问' },
  { word: '输出质检', weight: 72, action: 'audit', group: '可信度', hint: '核对推荐项是否真的来自本地样本库' },

  // —— 行程字段 ——
  { word: '行程规划', weight: 84, action: 'plan', payload: { city: '杭州', days: 2 }, group: '行程' },
  { word: '游玩天数', weight: 60, action: 'focus', payload: { field: 'plan-days' }, group: '行程' },
  { word: '费用预估', weight: 62, action: 'plan', payload: { city: '杭州', days: 3, budget: '舒适' }, group: '行程' },
  { word: '避坑提示', weight: 58, action: 'plan', payload: { city: '杭州', days: 2, crowd: '带老人' }, group: '行程' },
  { word: '替代方案', weight: 56, action: 'plan', payload: { city: '杭州', days: 2, interests: ['亲子'] }, group: '行程' },
  { word: '一键导出', weight: 54, action: 'export', group: '行程', hint: '把结果导出为 Markdown，数据不出本机' },

  // —— 目的地（来自本地样本库）——
  { word: '杭州', weight: 88, action: 'plan', payload: { city: '杭州', days: 2 }, group: '目的地' },
  { word: '苏州', weight: 74, action: 'plan', payload: { city: '苏州', days: 2 }, group: '目的地' },
  { word: '成都', weight: 74, action: 'plan', payload: { city: '成都', days: 3 }, group: '目的地' },
  { word: '丽江', weight: 70, action: 'plan', payload: { city: '丽江', days: 3 }, group: '目的地' },
  { word: '西安', weight: 70, action: 'plan', payload: { city: '西安', days: 3 }, group: '目的地' },

  // —— 预算 / 人群 / 兴趣 ——
  { word: '经济', weight: 48, action: 'plan', payload: { budget: '经济' }, group: '预算' },
  { word: '舒适', weight: 52, action: 'plan', payload: { budget: '舒适' }, group: '预算' },
  { word: '高端', weight: 48, action: 'plan', payload: { budget: '高端' }, group: '预算' },
  { word: '亲子', weight: 62, action: 'plan', payload: { crowd: '亲子', interests: ['亲子'] }, group: '同行人群' },
  { word: '情侣', weight: 60, action: 'plan', payload: { crowd: '情侣' }, group: '同行人群' },
  { word: '带老人', weight: 56, action: 'plan', payload: { crowd: '带老人' }, group: '同行人群' },
  { word: '团建', weight: 54, action: 'plan', payload: { crowd: '团建' }, group: '同行人群' },
  { word: '自然风光', weight: 64, action: 'plan', payload: { interests: ['自然风光'] }, group: '兴趣' },
  { word: '人文历史', weight: 62, action: 'plan', payload: { interests: ['人文历史'] }, group: '兴趣' },
  { word: '美食', weight: 66, action: 'plan', payload: { interests: ['美食'] }, group: '兴趣' },
  { word: '文艺打卡', weight: 56, action: 'plan', payload: { interests: ['文艺打卡'] }, group: '兴趣' },
  { word: '购物', weight: 48, action: 'plan', payload: { interests: ['购物'] }, group: '兴趣' },
  { word: '素食', weight: 44, action: 'plan', payload: { diet: '素食' }, group: '饮食禁忌' },
  { word: '忌辣', weight: 44, action: 'plan', payload: { diet: '忌辣' }, group: '饮食禁忌' },
  { word: '清真', weight: 44, action: 'plan', payload: { diet: '清真' }, group: '饮食禁忌' },

  // —— 营销平台 / 产品 / 客群 / 风格 ——
  { word: '小红书', weight: 78, action: 'marketing', payload: { platform: '小红书' }, group: '营销平台' },
  { word: '朋友圈', weight: 64, action: 'marketing', payload: { platform: '朋友圈' }, group: '营销平台' },
  { word: '抖音', weight: 70, action: 'marketing', payload: { platform: '抖音' }, group: '营销平台' },
  { word: 'OTA', weight: 56, action: 'marketing', payload: { platform: 'OTA' }, group: '营销平台' },
  { word: '公众号', weight: 58, action: 'marketing', payload: { platform: '公众号' }, group: '营销平台' },
  { word: '景区', weight: 60, action: 'marketing', payload: { product: '景区' }, group: '营销产品' },
  { word: '酒店民宿', weight: 60, action: 'marketing', payload: { product: '酒店' }, group: '营销产品' },
  { word: '餐饮', weight: 58, action: 'marketing', payload: { product: '餐饮' }, group: '营销产品' },
  { word: '文创创意', weight: 60, action: 'marketing', payload: { product: '文创' }, group: '营销产品' },
  { word: '活动策划', weight: 54, action: 'marketing', payload: { product: '活动' }, group: '营销产品' },
  { word: '种草', weight: 54, action: 'marketing', payload: { style: '种草' }, group: '文案风格' },
  { word: '促销', weight: 50, action: 'marketing', payload: { style: '促销' }, group: '文案风格' },
  { word: '文艺', weight: 48, action: 'marketing', payload: { style: '文艺' }, group: '文案风格' },

  // —— airi 侧服务（本地化）——
  { word: '机体记忆', weight: 80, action: 'panel', payload: { tab: 'memory' }, group: '本地服务', hint: '长期记忆：本机文件存储 + 混合检索' },
  { word: '记住这个', weight: 58, action: 'remember', group: '本地服务', hint: '把当前这句话存进长期记忆' },
  { word: '视觉理解', weight: 76, action: 'vision', group: '本地服务', hint: '用本机多模态模型看懂一张图' },
  { word: '拍照识景', weight: 66, action: 'vision', group: '本地服务', hint: '上传景点照片，让 AI 认一认' },
  { word: '语音播报', weight: 74, action: 'speak', group: '本地服务', hint: '用本机 Qwen TTS 把回答读出来' },
  { word: '声音设置', weight: 58, action: 'panel', payload: { tab: 'voice' }, group: '本地服务' },
  { word: '角色卡', weight: 82, action: 'panel', payload: { tab: 'cards' }, group: '本地服务', hint: '自定义虚拟人格：人设/音色/形象' },
  { word: '换表情', weight: 52, action: 'expression-cycle', group: '形象' },
  { word: '打招呼', weight: 56, action: 'greet', group: '形象' },
  { word: '本地模型', weight: 68, action: 'panel', payload: { tab: 'settings' }, group: '本地服务', hint: '全部推理都在本机 Ollama 上跑' },
];

/** 词云里的"行动词"由前端执行，这里只负责给出分组说明，便于前端渲染图例 */
const WORD_CLOUD_GROUPS = [
  { name: '核心功能', desc: '本项目的两大核心能力 + 两个演示入口' },
  { name: '目的地', desc: '本地样本库已覆盖的城市' },
  { name: '行程', desc: '方案的组成要素' },
  { name: '预算', desc: '预算档位' },
  { name: '同行人群', desc: '和谁一起去' },
  { name: '兴趣', desc: '兴趣偏好（可多选）' },
  { name: '饮食禁忌', desc: '忌口筛选' },
  { name: '营销平台', desc: '五大投放平台' },
  { name: '营销产品', desc: '文旅五大业态' },
  { name: '文案风格', desc: '文案语气' },
  { name: '本地服务', desc: 'airi 侧服务全部本地化' },
  { name: '形象', desc: 'Live2D 人物互动' },
];

// ===== 样本库 + 提示词组装 =====
const REF_MAP = {
  plan: ['destinations.md', 'hotels.md', 'dining.md'],
  marketing: ['marketing-playbook.md'],
  intake: [],
};

const OUT_RULES = {
  plan: [
    '【输出要求】你是文旅智能辅助助手，请严格按上面 Skill 规范与样本库数据生成结果。',
    '只输出 Markdown 正文：不要"好的""以下是"等客套话、不要解释、不要用代码块围栏包裹。',
    '',
    '【硬性约束】',
    '1. 推荐的所有景点、餐厅、住宿，必须逐字来自上面样本库表格中的「名称」列；不得改写名称、不得虚构、不得使用样本库以外的名称。',
    '2. 样本库中没有合适条目时，写「样本库暂无推荐」并说明建议补充哪类数据，禁止自行编造商家名称或价格。',
    '3. 每天六个字段（上午 / 午餐 / 下午 / 晚餐 / 住宿 / 交通贴士）都必须有实际内容，禁止用「无」「待定」等占位符敷衍。',
    '4. 「## 费用预估」表必须含「项目 | 档位 | 预估」三列，且"总计"必须等于各分项之和。',
    '5. 「## 行程总览」「## 费用预估」「## 替代方案 & 避坑提示」三个章节各只允许出现一次，严禁重复输出。',
    '6. 必须完整输出用户要求的每一天：请求 N 天就要有 Day 1 到 Day N 共 N 段，且「行程总览」表必须有 N 行数据。不得提前结束。',
    '7. 「## 行程总览」表必须逐行填写，不能只留表头。先写完总览表，再写 Day 1 ~ Day N 的明细。',
    '8. 每个字段的值只写名称本身（可跟一个括号补充说明），不要写成一整句话。',
    '   正确：`- 上午：西溪湿地（约 80 元，摇橹船）`；错误：`- 上午：深入西溪国家湿地公园内游玩`。',
  ].join('\n'),
  marketing: [
    '【输出要求】你是文旅智能辅助助手，请严格按上面 Skill 规范与各平台模板生成结果。',
    '只输出 Markdown 正文：不要"好的""以下是"等客套话、不要解释、不要用代码块围栏包裹。',
    '',
    '【硬性约束】',
    '1. 不得编造具体价格、折扣、评分、销量、获奖等无法核实的数据。',
    '   反面：`价格虽不便宜但物超所值，周末还有特别优惠`——价格和优惠都是编的。',
    '   正面：`人均以店内为准`。不知道就写"以现场为准"，这条优先于下面所有风格要求。',
    '2. 只能推荐上面样本库里出现过的商家与菜品。样本库里没有的名字一律不许出现。',
    '   反面：`知味三鲜`、`桂花酒`、`专属情侣套餐`——样本库里没有这几样，不要写。',
    '3. 必须输出 A、B 两个版本（理性卖点版 + 感性情绪版），每版都含：标题、正文、话题标签、配图建议、CTA。',
    '4. 配图建议要和目标客群对得上。给年轻情侣写文案时，不要建议"儿童在店内玩耍"这类图。',
    '5. 同一段落、同一小节标题只允许出现一次，严禁重复输出。',
    '',
    '【去 AI 味：这一版的重点，照着下面的正反例写】',
    '4. 下面左边是典型的机器写法，右边是改完的样子。**请按右边的风格写。**',
    '',
    '❌ 机器写法：',
    '  标题：【西湖边的情侣餐】在「知味观」留下浪漫足迹✨',
    '  正文：这里不仅有诱人的美食，还有满屏的小清新。想象一下，在湖光山色的映衬下，',
    '        两人共享这顿餐点时的温馨氛围吧。点击关注，开始属于你们的故事吧❤️',
    '',
    '✅ 改完：',
    '  标题：知味观下午两点去不用排队',
    '  正文：两个人点一份东坡肉、一份响铃、一碗片儿川，一百五十块出头。肉是提前炖好的，',
    '        上桌还在冒泡，配米饭刚好。中午人最多，我们两点到的，空了一半座位。',
    '        吃完往南走十分钟就是湖边，正好消食。',
    '',
    '【为什么这么改，这几条必须遵守】',
    '5. 删掉所有这类句子：「不仅有…还有…」「不仅…更…」「不是…而是…」「无论是…还是…都…」',
    '   「想象一下」「让我们一起」「快来…吧」「开始属于你们的故事」「你心动了吗」「留下…足迹」。',
    '6. 用具体的东西替换形容词。数字、时间、价格、走几分钟、点什么菜，写到句子里去。',
    '   不写「诱人的美食」，写「上桌还在冒泡」。',
    '7. 标题写一句大白话，不要对仗、不要文艺。「知味观下午两点去不用排队」这样就行。',
    '8. 写出缺点。人多要等位、地方不大、停车难找，都可以写。一条缺点都没有，读者反而不信。',
    '9. emoji 标题里不要放，正文里最多一个。感叹号最多一个，破折号一个都不要用。',
    '10. 写完在心里念一遍，如果平时跟朋友不会这么讲话，就改到会为止。',
    '',
    '注意：具体数字只能来自样本库或用户给的信息。不知道价格就写「价格以现场为准」，',
    '不要编一个数字出来。这条优先于上面所有风格要求。',
  ].join('\n'),
  intake: [
    '【输出要求】用户尚未提供任何需求信息，请按 SKILL.md「2.2 需求采集」的要求，一次性集中追问。',
    '输出格式：先用一句话说明你能做什么，然后逐个字段列出 2-5 个可点选的候选选项（Markdown 列表）。',
    '需要追问的字段：目的地、游玩天数、预算档位、同行人群、兴趣偏好（可多选）、饮食禁忌。',
    '不要生成行程方案，不要输出费用预估，不要使用代码块围栏。',
  ].join('\n'),
};

function ollamaOptions(type) {
  // marketing 给到 2560：要输出 A/B 两版、每版五个小节，2048 有时不够，
  // 实测出现过 B 版正文写到一半被截断。
  //
  // numCtx 这里必须和角色卡保持一致（都是 16384）！原来 marketing=8192、intake=4096，
  // 而 Ollama 是按 (模型, num_ctx) 维护推理进程的，值一变就重建进程重新加载 5GB 权重，
  // 实测每次多花 2.6~2.9 秒。详见 lib/ollama.js 里 CHAT_NUM_CTX 的说明。
  if (type === 'marketing') return { temperature: 0.85, numCtx: 16384, numPredict: 2560 };
  if (type === 'intake') return { temperature: 0.3, numCtx: 16384, numPredict: 700 };
  return { temperature: 0.4, numCtx: 16384, numPredict: 4096 };
}

function createWenlv({ skillDir, ollama }) {
  const refDir = path.join(skillDir, 'references');
  const auditor = createAuditor(refDir);
  const promptCache = new Map();

  const readRef = f => fs.readFileSync(path.join(refDir, f), 'utf8');
  const listCities = content => [...String(content).matchAll(/^##\s+(.+?)\s*$/gm)].map(m => m[1].trim());

  /** 从多城市样本库中切出目标城市那一节，避免全量注入挤爆上下文 */
  function sliceCitySection(content, city) {
    const target = String(city || '').trim();
    if (!target) return null;
    const lines = String(content).split('\n');
    let start = -1;
    let end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^##\s+(.+?)\s*$/);
      if (!m) continue;
      const name = m[1].trim();
      if (start === -1) { if (name === target) start = i; continue; }
      end = i;
      break;
    }
    if (start === -1) return null;
    return lines.slice(start, end).join('\n').trim();
  }

  function buildSystemPrompt(type = 'plan', city = '') {
    const cacheKey = `${type}|${city || ''}`;
    if (promptCache.has(cacheKey)) return promptCache.get(cacheKey);

    const skill = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const refs = (REF_MAP[type] || REF_MAP.plan).map((f) => {
      const raw = readRef(f);
      const cities = listCities(raw);
      if (type !== 'plan' || !cities.length) return `\n\n===== ${f} =====\n${raw}`;
      const sliced = city ? sliceCitySection(raw, city) : null;
      if (sliced) return `\n\n===== ${f} =====\n（以下为「${city}」的样本数据，其它城市的数据未注入）\n\n${sliced}`;
      return (
        `\n\n===== ${f} =====\n`
        + `（本地样本库当前**未覆盖**「${city || '未指定'}」；已覆盖：${cities.join('、')}。）\n`
        + '请按 SKILL.md「2.3 生成逻辑」第 1 条处理：退回通用文旅知识生成，'
        + '并在结果开头明确标注「本地样本库暂无该目的地，以下为通用建议，建议补充本地数据」。'
      );
    }).join('');

    const text = `${skill}\n\n${refs}\n\n${OUT_RULES[type] || OUT_RULES.plan}`;
    promptCache.set(cacheKey, text);
    return text;
  }

  function buildUserPrompt(type, params = {}) {
    if (type === 'plan') {
      const { city, days, budget, crowd, interests, diet } = params;
      return '请为我生成个性化「游玩·旅居·餐饮」一体化方案：\n'
        + `- 目的地：${city}\n- 游玩天数：${days} 天\n- 预算档位：${budget}\n`
        + `- 同行人群：${crowd}\n- 兴趣偏好：${(interests || []).join('、') || '不限'}\n- 饮食禁忌：${diet}`;
    }
    if (type === 'marketing') {
      const { product, platform, audience, style } = params;
      return `请为「${product}」生成「${platform}」平台的营销文案：\n`
        + `- 产品/主体：${product}\n- 目标平台：${platform}\n- 目标客群：${audience}\n- 文案风格：${style}\n`
        + '请输出 A/B 两个版本（理性卖点版 + 感性情绪版），各含：标题、正文、话题标签、配图建议、CTA。';
    }
    if (type === 'intake') {
      return '我还没有提供任何需求信息，请先按规范向我集中追问（每个字段都给出可点选的候选选项）。';
    }
    const err = new Error(`未知类型: ${type}`);
    err.code = 'BAD_INPUT';
    throw err;
  }

  function normalizeParams(type, params = {}) {
    if (type === 'marketing') {
      return {
        product: params.product || DEFAULTS.product,
        platform: params.platform || DEFAULTS.platform,
        audience: params.audience || DEFAULTS.audience,
        style: params.style || DEFAULTS.style,
      };
    }
    if (type === 'plan') {
      return {
        city: String(params.city || DEFAULTS.city).trim() || DEFAULTS.city,
        days: Math.min(Math.max(parseInt(params.days, 10) || DEFAULTS.days, 1), 7),
        budget: params.budget || DEFAULTS.budget,
        crowd: params.crowd || DEFAULTS.crowd,
        interests: Array.isArray(params.interests) && params.interests.length ? params.interests : DEFAULTS.interests,
        diet: params.diet || DEFAULTS.diet,
      };
    }
    return {};
  }

  /** 非流式生成（供 Agent 接口 / 需要整体质检的场景） */
  async function generate(type, rawParams, { model } = {}) {
    const params = normalizeParams(type, rawParams);
    const { chatModel } = await ollama.resolveModels();
    const useModel = model || chatModel;
    if (!useModel) throw Object.assign(new Error('本机没有可用的对话模型，请先 ollama pull qwen2.5:7b'), { code: 'NO_MODEL' });
    const opt = ollamaOptions(type);
    const { content } = await ollama.chat({
      model: useModel,
      temperature: opt.temperature,
      numCtx: opt.numCtx,
      numPredict: opt.numPredict,
      messages: [
        { role: 'system', content: buildSystemPrompt(type, params.city) },
        { role: 'user', content: buildUserPrompt(type, params) },
      ],
    });
    const warnings = auditor.audit(content, type, params);
    return { content, warnings, model: useModel, params };
  }

  /** 流式生成：逐段吐字，最后附上质检结果 */
  async function* generateStream(type, rawParams, { model } = {}) {
    const params = normalizeParams(type, rawParams);
    const { chatModel } = await ollama.resolveModels();
    const useModel = model || chatModel;
    if (!useModel) throw Object.assign(new Error('本机没有可用的对话模型，请先 ollama pull qwen2.5:7b'), { code: 'NO_MODEL' });
    const opt = ollamaOptions(type);
    let full = '';
    for await (const chunk of ollama.chatStream({
      model: useModel,
      temperature: opt.temperature,
      numCtx: opt.numCtx,
      numPredict: opt.numPredict,
      messages: [
        { role: 'system', content: buildSystemPrompt(type, params.city) },
        { role: 'user', content: buildUserPrompt(type, params) },
      ],
    })) {
      if (chunk.delta) { full += chunk.delta; yield { delta: chunk.delta }; }
      if (chunk.done) {
        full = chunk.content || full;
        yield { done: true, content: full, warnings: auditor.audit(full, type, params), model: useModel, params };
      }
    }
  }

  /** 词云 + 表单元数据：前端拉一次即可渲染全部交互入口 */
  function capabilities() {
    let cities = [];
    try {
      cities = [...new Set(REF_MAP.plan.flatMap(f => listCities(readRef(f))))];
    } catch { cities = ['杭州', '苏州', '成都', '丽江', '西安']; }
    return {
      options: OPTIONS,
      defaults: DEFAULTS,
      cities,
      wordCloud: WORD_CLOUD,
      wordCloudGroups: WORD_CLOUD_GROUPS,
      entityCount: auditor.entityCount,
      features: [
        { id: 'plan', name: '个性化方案规划', desc: '游玩·旅居·餐饮一体化方案', icon: '🗺️' },
        { id: 'marketing', name: '文旅营销素材生成', desc: '五大平台 · A/B 双版本', icon: '✍️' },
        { id: 'intake', name: '信息缺失集中追问', desc: '异常处理演示入口', icon: '🤔' },
        { id: 'audit', name: '输出质检', desc: '与本地样本库核对，不静默放行编造内容', icon: '🔍' },
      ],
    };
  }

  return { generate, generateStream, capabilities, buildSystemPrompt, buildUserPrompt, normalizeParams, auditor, OPTIONS, DEFAULTS, get refDir() { return refDir; } };
}

module.exports = { createWenlv, OPTIONS, DEFAULTS, WORD_CLOUD, WORD_CLOUD_GROUPS };
