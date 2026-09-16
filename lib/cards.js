/**
 * cards.js —— AI 角色卡（虚拟人格自定义）
 *
 * 保留并强化原项目"虚拟人格自定义"的能力：人设、开场白、说话风格、音色、模型参数、
 * Live2D 形象（模型/缩放/表情/动作）、记忆开关，全部做成可视化的角色卡。
 *
 * 兼容性：
 *   · 原生格式 —— 本项目 data/cards.json 里的完整字段
 *   · SillyTavern chara_card_v2 —— 可导入外部角色卡（description / personality / first_mes …）
 *   导入后统一落到原生格式，导出时默认导出本项目原生格式（信息不丢）。
 *
 * 所有角色卡都存在本机文件里，不上传、不联网。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CHAT_NUM_CTX } = require('./ollama');

/** 与前端保持一致的"人设 → 系统提示词"组装规则 */
function composeSystemPrompt(card, { memoryText = '', extraContext = '' } = {}) {
  const c = card || {};
  const lines = [];

  lines.push(`你是「${c.name || 'AIRI'}」，一个运行在用户本机上的中文 AI 虚拟助手。`);
  if (c.tagline) lines.push(`你的一句话定位：${c.tagline}`);
  lines.push('');
  lines.push('【人设】');
  lines.push(c.persona || '你是一位专业、亲切的文旅智能助手。');
  if (c.speakingStyle) {
    lines.push('');
    lines.push('【说话风格】');
    lines.push(c.speakingStyle);
  }
  lines.push('');
  lines.push('【通用规则】');
  lines.push('1. 全程使用简体中文回答。');
  lines.push('2. 你在对话里说的话会被语音合成朗读出来，所以要口语化、句子别太长，不要输出 Markdown 表格、代码块、井号标题和表情符号堆砌。');
  lines.push('3. 不确定的事情就说不确定，不要编造事实、价格、评分、销量等无法核实的数据。');
  lines.push('4. 回答长度控制在 3 句话以内；用户明确要求详细展开时才展开。');
  if (c.memory && c.memory.enabled) {
    lines.push('5. 下面「长期记忆」里是你们之前聊过的内容，可以用自然的方式引用，但不要机械复述。');
  }
  if (extraContext) {
    lines.push('');
    lines.push('【当前可用能力】');
    lines.push(extraContext);
  }
  if (c.memory && c.memory.enabled && memoryText) {
    lines.push('');
    lines.push('【长期记忆（来自本机记忆库的召回结果）】');
    lines.push(memoryText);
  }
  return lines.join('\n');
}

const BUILTIN_CARDS = [
  {
    id: 'builtin-wenlv-guide',
    builtin: true,
    name: '小文',
    avatar: '🏔️',
    accent: '#7dd3fc',
    tagline: '浙江文旅向导，陪你玩得明白、玩得值',
    persona:
      '你是「小文」，一位土生土长的浙江文旅向导，对杭州、苏州、成都、丽江、西安等目的地的景区、'
      + '酒店民宿、餐厅小吃了如指掌。你说话像朋友聊天，先给结论再给理由，会主动提醒避坑和天气备选方案。'
      + '你手上有一套本地样本库，推荐景点餐厅时优先引用样本库里真实存在的条目，绝不凭空编造商家名字和价格。',
    speakingStyle: '亲切、口语化，像地陪在耳边说话；会用「咱们」「推荐你」这类词；不用书面语和官腔。',
    greeting: '你好呀，我是小文。想去哪儿玩？告诉我目的地和天数，我帮你把行程、住宿、吃饭一次安排好。',
    voice: { presetId: 'wenlv-guide-female', mode: 'custom-voice', instruct: '用温柔亲切的年轻女声说话，语速稍慢、吐字清晰，语气自然不夸张，像在给游客做景点讲解。', language: 'Chinese' },
    model: { chat: null, temperature: 0.7, numCtx: 16384, numPredict: 1024 },
    live2d: { model: 'nahida', scale: 1, x: 0, y: 0, expression: '', idleMotion: true },
    memory: { enabled: true, topK: 5 },
    vision: { enabled: true },
    tags: ['文旅', '向导', '默认'],
  },
  {
    id: 'builtin-planner',
    builtin: true,
    name: '阿杭',
    avatar: '🗺️',
    accent: '#a78bfa',
    tagline: '行程规划师，专治「选择困难」',
    persona:
      '你是「阿杭」，一位行程规划师。你擅长把模糊的需求拆成可执行的逐日安排，'
      + '会主动追问缺失的关键信息（目的地、天数、预算、同行人群、兴趣、饮食禁忌），'
      + '并且一次把问题问完，不让用户反复来回。你输出的行程必须有总览、逐日明细、费用预估和替代方案。',
    speakingStyle: '条理清晰、干练，喜欢用「第一件事」「另外」来分点，但仍然是口语不是念稿。',
    greeting: '我是阿杭。把目的地、天数、预算、和谁一起去告诉我，缺的我一次问完，然后给你一份能直接照着走的行程。',
    voice: { presetId: 'wenlv-guide-male', mode: 'custom-voice', instruct: '用沉稳温和的男声说话，中低音，语速中等，像博物馆讲解员一样从容。', language: 'Chinese' },
    model: { chat: null, temperature: 0.5, numCtx: 16384, numPredict: 2048 },
    live2d: { model: 'nahida', scale: 1, x: 0, y: 0, expression: '', idleMotion: true },
    memory: { enabled: true, topK: 5 },
    vision: { enabled: true },
    tags: ['文旅', '规划'],
  },
  {
    id: 'builtin-marketer',
    builtin: true,
    name: '小柚',
    avatar: '✨',
    accent: '#f472b6',
    tagline: '文旅营销文案官，负责把人种草',
    persona:
      '你是「小柚」，文旅营销文案官。你熟悉小红书、朋友圈、抖音、OTA、公众号五个平台的写法差异，'
      + '能把景区、酒店、餐饮、文创产品的卖点翻译成有画面感的种草文案。'
      + '你每次都给 A/B 两个不同角度的版本，并且绝不编造价格、折扣、评分、销量这些无法核实的数据。',
    speakingStyle: '轻快、有感染力，偶尔带一点点俏皮，但落到正文时立刻变得具体、有细节。',
    greeting: '我是小柚～把要推的产品、发哪个平台、给谁看告诉我，我给你两版可以直接发的文案。',
    voice: { presetId: 'wenlv-sweet', mode: 'voice-design', instruct: '体现元气活泼的少女音，音调偏高、语调起伏明显，语速偏快，带一点俏皮的笑意。', language: 'Chinese' },
    model: { chat: null, temperature: 0.85, numCtx: 16384, numPredict: 2048 },
    live2d: { model: 'nahida', scale: 1, x: 0, y: 0, expression: '', idleMotion: true },
    memory: { enabled: true, topK: 4 },
    vision: { enabled: true },
    tags: ['文旅', '营销'],
  },
];

/** 把 SillyTavern v2 角色卡转成本项目原生格式 */
function fromSillyTavern(raw) {
  const d = (raw && raw.data) || raw || {};
  const name = d.name || d.char_name || '导入的角色';
  return {
    name,
    avatar: '🎭',
    accent: '#a78bfa',
    tagline: d.creator_notes ? String(d.creator_notes).slice(0, 60) : '从外部角色卡导入',
    persona: [d.description, d.personality, d.scenario].filter(Boolean).join('\n\n') || '（导入的角色卡没有人设描述）',
    speakingStyle: d.mes_example ? `参考以下对话示例的语气：\n${String(d.mes_example).slice(0, 800)}` : '',
    greeting: d.first_mes || '',
    tags: ['导入'],
  };
}

function createCards({ dir, file = 'cards.json' }) {
  const filePath = path.join(dir, file);
  fs.mkdirSync(dir, { recursive: true });

  let state = { version: 1, activeId: BUILTIN_CARDS[0].id, cards: [] };

  function load() {
    try {
      if (fs.existsSync(filePath)) {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (Array.isArray(raw.cards) && raw.cards.length) state = raw;
      }
    } catch (e) {
      console.error('[cards] 角色卡文件损坏，已备份并恢复内置角色卡：', e.message);
      try { fs.copyFileSync(filePath, path.join(dir, 'cards.corrupt.json')); } catch { /* 忽略 */ }
    }
    // 保证内置角色卡始终存在（用户删掉了也会补回来），且不覆盖用户对它们的修改
    for (const b of BUILTIN_CARDS) {
      if (!state.cards.some(c => c.id === b.id)) state.cards.unshift(JSON.parse(JSON.stringify(b)));
    }
    if (!state.cards.some(c => c.id === state.activeId)) state.activeId = state.cards[0].id;

    // 存档迁移：历史版本的 numCtx 是散的（小文/小柚 8192、阿杭 16384）。
    // Ollama 是按 (模型, num_ctx) 维护推理进程的，值一变就把进程杀掉重新加载 5GB 权重，
    // 实测换一次角色卡要多等 2.6~2.9 秒，用户体感就是「打字聊天很慢」。
    // 现在全项目统一成 CHAT_NUM_CTX，老存档在这里一次性对齐并落盘。
    // 用 != 而不是 !==：老 JSON 里可能存成字符串 "8192"。
    const legacy = state.cards.filter(c => c.model && c.model.numCtx != CHAT_NUM_CTX);
    if (legacy.length) {
      for (const c of legacy) c.model.numCtx = CHAT_NUM_CTX;
      console.log(`[cards] 已把 ${legacy.length} 张角色卡的 numCtx 统一为 ${CHAT_NUM_CTX}（不这么做，换角色卡时 Ollama 会重新加载整个模型）`);
      persist();
    }
  }
  load();

  function persist() {
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (e) {
      console.error('[cards] 写入失败：', e.message);
    }
  }

  /** 缺字段补齐，避免前端拿到 undefined 而崩 */
  function normalize(input, base = {}) {
    const c = { ...base, ...input };
    return {
      id: c.id || crypto.randomUUID(),
      builtin: Boolean(c.builtin),
      name: String(c.name || '未命名角色').slice(0, 40),
      avatar: c.avatar || '🙂',
      accent: /^#[0-9a-f]{6}$/i.test(c.accent || '') ? c.accent : '#a78bfa',
      tagline: String(c.tagline || '').slice(0, 80),
      persona: String(c.persona || '').slice(0, 8000),
      speakingStyle: String(c.speakingStyle || '').slice(0, 2000),
      greeting: String(c.greeting || '').slice(0, 1000),
      voice: {
        presetId: (c.voice && c.voice.presetId) || 'wenlv-guide-female',
        mode: (c.voice && c.voice.mode) || 'custom-voice',
        instruct: String((c.voice && c.voice.instruct) || '').slice(0, 500),
        speaker: (c.voice && c.voice.speaker) || null,
        language: (c.voice && c.voice.language) || 'Chinese',
        // 「我的音色」：指向 data/voice-refs/ 里的一条参考音频。
        // 注意这张白名单漏一个字段就是"存了但读不到"—— 之前就是漏了它，
        // 导致界面选了自定义音色、合成时却拿不到参考音频。
        refVoiceId: (c.voice && c.voice.refVoiceId) || null,
      },
      model: {
        chat: (c.model && c.model.chat) || null,
        temperature: Number.isFinite(+(c.model && c.model.temperature)) ? +(c.model.temperature) : 0.7,
        numCtx: +(c.model && c.model.numCtx) || 16384,
        numPredict: +(c.model && c.model.numPredict) || 1024,
      },
      live2d: {
        model: (c.live2d && c.live2d.model) || 'nahida',
        scale: Number.isFinite(+(c.live2d && c.live2d.scale)) ? +(c.live2d.scale) : 1,
        x: +(c.live2d && c.live2d.x) || 0,
        y: +(c.live2d && c.live2d.y) || 0,
        expression: (c.live2d && c.live2d.expression) || '',
        idleMotion: !(c.live2d && c.live2d.idleMotion === false),
      },
      memory: {
        enabled: !(c.memory && c.memory.enabled === false),
        topK: +(c.memory && c.memory.topK) || 5,
      },
      vision: { enabled: !(c.vision && c.vision.enabled === false) },
      tags: Array.isArray(c.tags) ? c.tags.slice(0, 10) : [],
      createdAt: c.createdAt || Date.now(),
      updatedAt: Date.now(),
    };
  }

  const list = () => state.cards.map(c => ({ ...c }));
  const get = id => state.cards.find(c => c.id === id) || null;
  const active = () => get(state.activeId) || state.cards[0];

  function create(input = {}) {
    const card = normalize({ ...input, builtin: false });
    state.cards.push(card);
    persist();
    return card;
  }

  function update(id, patch = {}) {
    const idx = state.cards.findIndex(c => c.id === id);
    if (idx < 0) return null;
    // 内置角色卡允许改内容，但不允许改 id / builtin 标记，否则会破坏"内置始终存在"的保证
    const merged = normalize({ ...patch, id, builtin: state.cards[idx].builtin }, state.cards[idx]);
    state.cards[idx] = merged;
    persist();
    return merged;
  }

  function remove(id) {
    const card = get(id);
    if (!card) return { ok: false, error: '角色卡不存在' };
    if (card.builtin) return { ok: false, error: '内置角色卡不可删除，可以复制一份再改' };
    state.cards = state.cards.filter(c => c.id !== id);
    if (state.activeId === id) state.activeId = state.cards[0] ? state.cards[0].id : null;
    persist();
    return { ok: true };
  }

  function duplicate(id) {
    const card = get(id);
    if (!card) return null;
    const copy = normalize({ ...JSON.parse(JSON.stringify(card)), id: undefined, builtin: false, name: `${card.name} 副本`, tags: [...(card.tags || []), '副本'] });
    state.cards.push(copy);
    persist();
    return copy;
  }

  function setActive(id) {
    if (!get(id)) return { ok: false, error: '角色卡不存在' };
    state.activeId = id;
    persist();
    return { ok: true, activeId: id };
  }

  /** 导入：原生格式或 SillyTavern v2 都吃 */
  function importCard(raw) {
    let payload = raw;
    if (typeof raw === 'string') {
      try { payload = JSON.parse(raw); } catch { return { ok: false, error: '不是合法的 JSON' }; }
    }
    if (!payload || typeof payload !== 'object') return { ok: false, error: '角色卡内容为空' };
    const isST = payload.spec === 'chara_card_v2' || payload.spec === 'chara_card_v3' || payload.data;
    const partial = isST ? fromSillyTavern(payload) : payload;
    const card = create({ ...partial, builtin: false });
    return { ok: true, card };
  }

  function exportCard(id) {
    const card = get(id);
    if (!card) return null;
    return {
      spec: 'airi-wenlv-card-v1',
      exportedAt: new Date().toISOString(),
      data: JSON.parse(JSON.stringify({ ...card, id: undefined, builtin: undefined })),
    };
  }

  function exportAll() {
    return { spec: 'airi-wenlv-cards-v1', exportedAt: new Date().toISOString(), cards: state.cards.map(c => ({ ...c, id: undefined, builtin: undefined })) };
  }

  return { list, get, active, create, update, remove, duplicate, setActive, importCard, exportCard, exportAll, composeSystemPrompt, BUILTIN_CARDS, get activeId() { return state.activeId; }, get path() { return filePath; } };
}

module.exports = { createCards, composeSystemPrompt, BUILTIN_CARDS, fromSillyTavern };
