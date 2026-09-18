#!/usr/bin/env node
/**
 * 外部 API 接入测试（出向 + 入向）
 *
 * 运行：node test/providers.js      （或 npm run test:providers）
 *
 * 为什么要单独一个测试文件：
 *   smoke.js 只打真服务、只覆盖既有接口；而这次新增的东西里，
 *   最容易悄悄坏掉的是**协议细节**和**鉴权边界** —— 比如 SSE 的 [DONE] 有没有处理、
 *   Authorization 头错了会不会仍然放行。这些用真实云厂商 API 测既慢又不稳定
 *   （还要花配额），所以这里主体用**进程内的假 OpenAI 兼容端点**来测。
 *
 * 覆盖：
 *   A. 纯函数与配置持久化（baseUrl 规范化、密钥打码、配置读写与损坏回退）
 *   B. OpenAI 兼容客户端（模型列表 / 对话 / 流式 / 向量 / 视觉 / 错误码翻译）
 *   C. 路由层（本地 ⇄ 外部分流、向量视觉独立开关、Ollama 挂了外部仍可用）
 *   D. 入向配置与鉴权（默认关闭、令牌校验、能力勾选）
 *   E. 端到端（临时起一份真服务，打 /v1/* 与别名路径）
 *
 * 全程使用独立临时数据目录，不碰正式的 data/providers.json 与 data/openapi.json。
 */

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-providers-'));
const PORT = Number(process.env.PROVIDERS_TEST_PORT || 8124);
const HOST = '127.0.0.1';

let pass = 0;
let fail = 0;
let skip = 0;

function check(name, ok, extra) {
  if (ok) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}${extra ? `  → ${extra}` : ''}`);
  }
}

function skipped(name, why) {
  skip++;
  console.log(`  - ${name}（跳过：${why}）`);
}

const providersLib = require('../lib/providers');
const { createInference } = require('../lib/inference');
const { createOpenAPI } = require('../lib/openapi');

/*
 * 思考链标记必须用码点拼出来，不能直接写成字面量。
 *
 * 原因：任何能"看懂"思考块的编辑器、格式化器或代理层，都可能把源码里字面的
 * 开标记当成结构标签处理掉，结果就是文件里只剩 `think>` 而少了一个尖括号 ——
 * 测出来的东西跟真实模型输出根本不是一回事，而且这种损坏不会报错，只会让
 * 断言莫名其妙地失败。（这次就是这么踩到的：生产代码没问题，是测试样本先坏了。）
 *
 * 拼出来之后，无论中间经过多少层文本处理都不会被改写。
 */
const LT = String.fromCharCode(60);            // <
const GT = String.fromCharCode(62);            // >
const SLASH = String.fromCharCode(47);         // /
const VBAR = String.fromCharCode(0xFF5C);      // ｜ 全角竖线
const USEP = String.fromCharCode(0x2581);      // ▁ 下横线
const THINK_OPEN = LT + 'think' + GT;
const THINK_CLOSE_ASCII = LT + SLASH + 'think' + GT;
// qwen3 在 Ollama 上实际吐的结束标记
const THINK_CLOSE_QWEN = LT + VBAR + 'end' + USEP + 'of' + USEP + 'thinking' + VBAR + GT;

/* ==========================================================================
 * 进程内的假 OpenAI 兼容端点
 *
 * 只实现我们真正会用到的那几个路径，并在行为上模拟真实的坑：
 *   · /models 返回 {data:[{id}]}
 *   · /chat/completions 非流式返回 choices[0].message.content
 *   · 流式必须先来一个只有 role 的 chunk，再逐字来 delta，最后 [DONE]
 *   · 密钥不对要返回 401，路径不对返回 404，限流返回 429
 * 这样测出来的才是"我们的解析逻辑对不对"，而不是"这台机器网络通不通"。
 * ========================================================================*/
function startFakeOpenAI() {
  const seen = { chatBodies: [], authHeaders: [], paths: [] };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      seen.paths.push(req.url);
      seen.authHeaders.push(req.headers.authorization || '');

      const send = (code, obj) => {
        const b = JSON.stringify(obj);
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(b);
      };

      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* 忽略 */ }
      const model = String(body.model || '');
      const auth = String(req.headers.authorization || '');

      // 用"模型名"来触发各种边界行为，而不是自定义请求字段 ——
      // 生产代码只会转发标准字段，用魔法字段测出来的东西不真实。
      if (model === 'fake-needs-key' && auth !== 'Bearer good-key') {
        return send(401, { error: { message: 'Invalid API key provided.' } });
      }
      if (model === 'fake-rate-limit') {
        return send(429, { error: { message: 'rate limit exceeded' } });
      }
      if (model === 'fake-server-error') {
        return send(503, { error: { message: 'overloaded' } });
      }

      if (req.method === 'GET' && req.url.endsWith('/models')) {
        return send(200, { object: 'list', data: [{ id: 'fake-chat' }, { id: 'fake-embed' }] });
      }

      if (req.url.endsWith('/chat/completions')) {
        seen.chatBodies.push(body);

        // 思考块：验证 stripThinking 在外部通路同样生效。
        // 结束标记用 qwen3 实际会吐的那一种（全角竖线），这正是老代码漏掉的那个。
        const text = model === 'fake-thinking'
          ? THINK_OPEN + '内部推理' + THINK_CLOSE_QWEN + '真正的回答'
          : '这是假端点的回答';

        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          const frame = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
          frame({ choices: [{ delta: { role: 'assistant', content: '' }, index: 0 }] });
          if (model === 'fake-thinking') {
            // 开标记和结束标记故意分在两帧里，验证跨 chunk 的状态机
            frame({ choices: [{ delta: { content: THINK_OPEN + '内部推理' }, index: 0 }] });
            frame({ choices: [{ delta: { content: THINK_CLOSE_QWEN + '真正的回答' }, index: 0 }] });
          } else {
            // 故意拆成多帧，验证跨 chunk 拼接
            for (const piece of ['这是', '假端点', '的回答']) {
              frame({ choices: [{ delta: { content: piece }, index: 0 }] });
            }
          }
          frame({ choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] });
          res.write('data: [DONE]\n\n');
          return res.end();
        }

        return send(200, {
          id: 'chatcmpl-fake',
          object: 'chat.completion',
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        });
      }

      if (req.url.endsWith('/embeddings')) {
        const list = Array.isArray(body.input) ? body.input : [body.input];
        return send(200, {
          object: 'list',
          model: body.model,
          data: list.map((_, i) => ({ object: 'embedding', index: i, embedding: [i, i + 1, i + 2] })),
        });
      }

      return send(404, { error: { message: `unknown path ${req.url}` } });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, seen, baseUrl: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
    });
  });
}

/** 假的 ollama 客户端，用来验证路由层的分流逻辑 */
function fakeOllama({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async resolveModels() {
      if (fail) throw Object.assign(new Error('无法连接本地 Ollama'), { code: 'NO_OLLAMA' });
      return { models: [{ name: 'local-chat' }], chat: 'local-chat', vision: 'local-vision', embed: 'local-embed', chatModel: 'local-chat', visionModel: 'local-vision', embedModel: 'local-embed' };
    },
    async chat(opts) { calls.push(['chat', opts.model]); return { content: `本地回答(${opts.model})`, model: opts.model }; },
    async *chatStream(opts) { calls.push(['chatStream', opts.model]); yield { delta: '本地' }; yield { done: true, content: '本地流式回答', model: opts.model }; },
    async embed(opts) { calls.push(['embed', opts.model]); return [[9, 9, 9]]; },
    async vision(opts) { calls.push(['vision', opts.model]); return { content: '本地视觉结果', model: opts.model }; },
    async status() { return { running: !fail, ready: !fail, chatModel: fail ? null : 'local-chat', visionModel: fail ? null : 'local-vision', embedModel: fail ? null : 'local-embed' }; },
  };
}

/* ========================================================================*/

async function partA() {
  console.log('\nA. 纯函数与配置持久化');

  check('baseUrl 去掉结尾斜杠',
    providersLib.normalizeBaseUrl('https://api.deepseek.com/v1/') === 'https://api.deepseek.com/v1');
  check('误填的完整端点会被截回根路径',
    providersLib.normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions') === 'https://api.deepseek.com/v1',
    providersLib.normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions'));
  check('/embeddings 结尾也会被截回',
    providersLib.normalizeBaseUrl('https://x.cn/v1/embeddings') === 'https://x.cn/v1');
  check('joinUrl 不多不少一个斜杠',
    providersLib.joinUrl('https://x.cn/v1/', '/chat/completions') === 'https://x.cn/v1/chat/completions');

  check('密钥打码只露头尾', providersLib.maskKey('sk-1234567890abcdef') === 'sk-1****cdef', providersLib.maskKey('sk-1234567890abcdef'));
  check('过短的密钥整体打码', providersLib.maskKey('short') === '****');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-cfg-'));
  const p = providersLib.createProviders({ dir });
  check('默认是本地模式（不会悄悄出网）', p.isExternal() === false);
  check('默认预设是 deepseek 且自带 baseUrl', p.publicConfig().external.baseUrl.includes('deepseek'));

  p.update({ external: { apiKey: 'sk-secret-value' } });
  check('保存后 hasApiKey 为真', p.publicConfig().external.hasApiKey === true);
  check('回传给前端的密钥是打码的', p.publicConfig().external.apiKeyMasked.includes('****'));

  // 关键回归点：前端拿不到明文，所以"只改模型名"不能把密钥清掉
  p.update({ external: { chatModel: 'deepseek-reasoner' } });
  check('只改模型名不会清掉已存的密钥', p.getConfig().external.apiKey === 'sk-secret-value');
  check('模型名确实改掉了', p.getConfig().external.chatModel === 'deepseek-reasoner');

  p.update({ external: { apiKey: '' } });
  check('传空密钥视为"不改"', p.getConfig().external.apiKey === 'sk-secret-value');

  p.update({ clearApiKey: true });
  check('明确要求清除时才真的清掉', p.getConfig().external.apiKey === '');

  p.update({ external: { presetId: 'zhipu' } });
  check('切换预设会带出该家的 baseUrl', p.getConfig().external.baseUrl.includes('bigmodel.cn'), p.getConfig().external.baseUrl);
  check('切换预设会带出该家的默认模型', p.getConfig().external.chatModel === 'glm-4-plus');

  p.update({ mode: 'external' });
  check('mode=external 且填了 baseUrl 时 isExternal 为真', p.isExternal() === true);

  // 配置文件损坏时必须能起来，且回退到"不出网"
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-cfg2-'));
  fs.writeFileSync(path.join(dir2, 'providers.json'), '{ this is not json', 'utf8');
  const p2 = providersLib.createProviders({ dir: dir2 });
  check('配置损坏时回退为本地模式而不是崩掉', p2.isExternal() === false);
  check('损坏的配置被备份了下来', fs.existsSync(path.join(dir2, 'providers.json.corrupt')));

  // stripThinking：两种结束标记都必须认。
  // 这是一处修过的真 bug —— 原实现只认 </think>，而 qwen3 在 Ollama 上吐的是全角竖线那一种，
  // 于是"流式干净、非流式糊思维链"。钉住它，别再退回去。
  const { stripThinking } = require('../lib/ollama');
  check('剥掉 qwen3 全角结束标记的思考块',
    stripThinking(THINK_OPEN + '推理' + THINK_CLOSE_QWEN + '正文') === '正文',
    stripThinking(THINK_OPEN + '推理' + THINK_CLOSE_QWEN + '正文'));
  check('剥掉 ASCII 结束标记的思考块',
    stripThinking(THINK_OPEN + '推理' + THINK_CLOSE_ASCII + '正文') === '正文',
    stripThinking(THINK_OPEN + '推理' + THINK_CLOSE_ASCII + '正文'));
  check('未闭合的思考块整段丢弃（正文在前的也能删）',
    stripThinking('正文' + THINK_OPEN + '没闭合的思维链') === '正文',
    stripThinking('正文' + THINK_OPEN + '没闭合的思维链'));
  check('没有思考块时原样返回', stripThinking('正常回答') === '正常回答');

  // 错误翻译
  check('401 被翻译成密钥问题的提示',
    providersLib.explainHttpError(401, '{"error":{"message":"bad key"}}').code === 'AUTH_ERROR');
  check('404 的提示里会提到"不要带 /chat/completions"',
    providersLib.explainHttpError(404, '{}', { baseUrl: 'https://x/v1' }).message.includes('/chat/completions'));
  check('429 被识别为限流', providersLib.explainHttpError(429, '{}').code === 'RATE_LIMIT');
  check('5xx 被识别为上游故障', providersLib.explainHttpError(503, '{}').code === 'UPSTREAM_ERROR');
  check('401 的提示原文被带进 message',
    providersLib.explainHttpError(401, '{"error":{"message":"Invalid API key provided."}}').message.includes('Invalid API key provided'));
}

async function partB(fake) {
  console.log('\nB. OpenAI 兼容客户端');

  const models = await providersLib.listModels({ baseUrl: fake.baseUrl, apiKey: 'k' });
  check('拉取模型列表', models.length === 2 && models.includes('fake-chat'), JSON.stringify(models));

  const r = await providersLib.chat({
    baseUrl: fake.baseUrl, apiKey: 'k', model: 'fake-chat',
    messages: [{ role: 'user', content: 'hi' }],
  });
  check('非流式对话拿到内容', r.content === '这是假端点的回答', r.content);
  check('返回里带 usage 透传', r.usage && r.usage.total_tokens === 3);

  // 思考块剥离
  const rt = await providersLib.chat({
    baseUrl: fake.baseUrl, apiKey: 'k', model: 'fake-thinking',
    messages: [{ role: 'user', content: 'hi' }],
  });
  check('非流式会剥掉思考块', rt.content === '真正的回答', rt.content);

  // 流式
  let streamed = '';
  let doneContent = '';
  let deltaCount = 0;
  for await (const c of providersLib.chatStream({
    baseUrl: fake.baseUrl, apiKey: 'k', model: 'fake-chat',
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    if (c.delta) { streamed += c.delta; deltaCount++; }
    if (c.done) doneContent = c.content;
  }
  check('流式：分帧内容被正确拼接', streamed === '这是假端点的回答', streamed);
  check('流式：拿到多帧而不是一坨', deltaCount >= 3, `帧数=${deltaCount}`);
  check('流式：done 事件带完整内容', doneContent === '这是假端点的回答', doneContent);

  // 流式 + 思考块
  let streamedThink = '';
  for await (const c of providersLib.chatStream({
    baseUrl: fake.baseUrl, apiKey: 'k', model: 'fake-thinking',
    messages: [{ role: 'user', content: 'hi' }],
  })) {
    if (c.delta) streamedThink += c.delta;
    if (c.done) streamedThink = c.content || streamedThink;
  }
  check('流式也会剥掉跨帧的思考块', streamedThink === '真正的回答', streamedThink);

  // 向量
  const vecs = await providersLib.embed({
    baseUrl: fake.baseUrl, apiKey: 'k', model: 'fake-embed', input: ['a', 'b'],
  });
  check('向量化返回两条且维度正确', vecs.length === 2 && vecs[1].length === 3, JSON.stringify(vecs));

  // 视觉：重点验证报文形状（OpenAI 用 image_url，不是 Ollama 的 images 字段）
  await providersLib.vision({
    baseUrl: fake.baseUrl, apiKey: 'k', model: 'fake-chat',
    prompt: '看图', imagesBase64: ['QUJD'],
  });
  const vbody = fake.seen.chatBodies[fake.seen.chatBodies.length - 1];
  const part = (vbody.messages[0].content || []).find(x => x.type === 'image_url');
  check('视觉请求用的是 OpenAI 的 image_url 形状', Boolean(part));
  check('视觉图片被补成 data URL', Boolean(part && part.image_url.url.startsWith('data:image/jpeg;base64,')));

  // 错误翻译（对着假端点真的发请求）
  let e401 = null;
  try {
    await providersLib.chat({
      baseUrl: fake.baseUrl, apiKey: 'bad-key', model: 'fake-needs-key',
      messages: [{ role: 'user', content: 'hi' }],
    });
  } catch (e) { e401 = e; }
  check('错误的密钥被翻译成 AUTH_ERROR', e401 && e401.code === 'AUTH_ERROR', e401 && e401.code);

  let e429 = null;
  try {
    await providersLib.chat({
      baseUrl: fake.baseUrl, apiKey: 'k', model: 'fake-rate-limit',
      messages: [{ role: 'user', content: 'hi' }],
    });
  } catch (e) { e429 = e; }
  check('限流被翻译成 RATE_LIMIT', e429 && e429.code === 'RATE_LIMIT', e429 && e429.code);

  let eConn = null;
  try {
    await providersLib.listModels({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', timeout: 3000 });
  } catch (e) { eConn = e; }
  check('连不上时给出 NO_ENDPOINT 而不是原始 fetch 报错',
    eConn && eConn.code === 'NO_ENDPOINT' && eConn.message.includes('Base URL 写错'), eConn && eConn.code);

  // 三级校验
  const okReport = await providersLib.verify({ baseUrl: fake.baseUrl, apiKey: 'k', model: 'fake-chat' });
  check('verify：三级都过时 ok=true', okReport.ok === true, JSON.stringify(okReport.steps.map(s => s.ok)));
  check('verify：返回三步（连接/模型名/对话探针）', okReport.steps.length === 3, `步数=${okReport.steps.length}`);

  const skipReport = await providersLib.verify({ baseUrl: fake.baseUrl, apiKey: 'k', model: 'fake-chat', skipChat: true });
  check('verify：skipChat 时只跑两步', skipReport.steps.length === 2, `步数=${skipReport.steps.length}`);

  const badReport = await providersLib.verify({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', timeout: 3000 });
  check('verify：连不上时 ok=false 且不继续往下跑', badReport.ok === false && badReport.steps.length === 1);
}

async function partC(fake) {
  console.log('\nC. 路由层（本地 ⇄ 外部）');

  // --- 本地模式：应完全走 ollama ---
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-inf-'));
  let store = providersLib.createProviders({ dir });
  let local = fakeOllama();
  let inf = createInference({ ollama: local, providers: store });

  const rm1 = await inf.resolveModels();
  check('本地模式：resolveModels 报 local 来源', rm1.source.chat === 'local');
  const c1 = await inf.chat({ model: 'local-chat', messages: [] });
  check('本地模式：chat 走 ollama', c1.source === 'local' && local.calls.some(x => x[0] === 'chat'));

  // --- 外部模式 ---
  store.update({ mode: 'external', external: { presetId: 'custom', baseUrl: fake.baseUrl, apiKey: 'k', chatModel: 'fake-chat' } });
  const rm2 = await inf.resolveModels();
  check('外部模式：resolveModels 报 external 来源', rm2.source.chat === 'external', JSON.stringify(rm2.source));
  check('外部模式：生效模型名是外部配置的那个', rm2.chatModel === 'fake-chat', rm2.chatModel);

  const c2 = await inf.chat({ model: 'local-chat', messages: [{ role: 'user', content: 'hi' }] });
  check('外部模式：chat 走外部通路', c2.source === 'external', c2.source);
  check('外部模式：忽略调用方传来的本地模型名（否则会 404）', c2.content === '这是假端点的回答' && c2.model === 'fake-chat', JSON.stringify(c2.content));

  // 流式也必须走外部
  let got = '';
  for await (const ch of inf.chatStream({ model: 'local-chat', messages: [{ role: 'user', content: 'hi' }] })) {
    if (ch.delta) got += ch.delta;
  }
  check('外部模式：chatStream 也走外部且能拼出内容', got === '这是假端点的回答', got);

  // --- 视觉/向量默认仍走本地（绝大多数外部厂商没有这两个接口）---
  check('外部模式：视觉默认仍走本地', (await inf.resolveModels()).source.vision === 'local');
  const e1 = await inf.embed({ model: 'local-embed', input: ['x'] });
  check('外部模式：向量默认仍走本地', e1[0][0] === 9 && local.calls.some(x => x[0] === 'embed'));

  // 打开向量外部后应切过去
  store.update({ useFor: { embed: true }, external: { embedModel: 'fake-embed' } });
  check('勾选后向量切到外部', (await inf.resolveModels()).source.embed === 'external');
  const e2 = await inf.embed({ model: 'local-embed', input: ['x'] });
  check('向量确实发到了外部端点', e2[0].length === 3 && e2[0][0] === 0, JSON.stringify(e2));

  // 勾了"视觉走外部"却没填模型名：应当安全回落本地，同时把"没填完"报出来。
  // 关键是**不能静默** —— 否则用户以为在用外部视觉，实际在用本地。
  store.update({ useFor: { vision: true }, external: { visionModel: '' } });
  const rmVis = await inf.resolveModels();
  check('勾了外部视觉但没填模型名时安全回落到本地', rmVis.source.vision === 'local', rmVis.source.vision);
  check('同时把"配置没填完"如实报出来（不静默降级）', rmVis.misconfigured.vision === true, JSON.stringify(rmVis.misconfigured));
  const vres = await inf.vision({ model: 'local-vision', imagesBase64: ['x'] });
  check('回落路径下视觉仍然可用', vres.content === '本地视觉结果', vres.content);

  // 补上模型名后应立刻切到外部，并且不再报"没填完"
  store.update({ external: { visionModel: 'fake-chat' } });
  const rmVis2 = await inf.resolveModels();
  check('填上视觉模型名后切到外部', rmVis2.source.vision === 'external', rmVis2.source.vision);
  check('填完之后不再报"没填完"', rmVis2.misconfigured.vision === false);
  const vres2 = await inf.vision({ model: 'local-vision', imagesBase64: ['x'] });
  check('切到外部后视觉走外部通路', vres2.source === 'external', vres2.source);

  // --- Ollama 整个挂掉，但外部可用：不该抛 NO_OLLAMA ---
  const deadLocal = fakeOllama({ fail: true });
  const inf2 = createInference({ ollama: deadLocal, providers: store });
  store.update({ useFor: { vision: false, embed: false } });
  const rm3 = await inf2.resolveModels();
  check('Ollama 挂了但外部可用时 resolveModels 不抛错', rm3.chatModel === 'fake-chat', rm3.chatModel);
  check('同时把本地的错误记下来供界面显示', Boolean(rm3.localError));

  const st = await inf2.status();
  check('status.ready 以"路由后有没有模型"为准', st.ready === true);
  check('status 如实区分 localReady 与 externalReady', st.localReady === false && st.externalReady === true, JSON.stringify({ l: st.localReady, e: st.externalReady }));
}

async function partD() {
  console.log('\nD. 入向配置与鉴权');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-oa-'));
  const oa = createOpenAPI({ dir });

  check('默认关闭', oa.publicConfig().enabled === false);
  check('关闭时 authorize 直接拒绝', oa.authorize({ headers: {} }).ok === false);
  check('关闭时拒绝原因指向设置项', oa.authorize({ headers: {} }).code === 'FORBIDDEN');
  check('关闭时任何能力都不放行', oa.allows('chat') === false);

  const withToken = oa.update({ enabled: true, regenerateToken: true });
  const token = withToken.tokenPlain;
  check('开启并生成令牌', typeof token === 'string' && token.startsWith('wl-'), token);
  check('令牌只回传打码版', oa.publicConfig().tokenMasked.includes('****'));
  check('回传体里的 tokenMasked 与明文不同', oa.publicConfig().tokenMasked !== token);

  check('无令牌被拒', oa.authorize({ headers: {} }).code === 'UNAUTHORIZED');
  check('错误令牌被拒', oa.authorize({ headers: { authorization: 'Bearer wrong' } }).code === 'UNAUTHORIZED');
  check('格式不对（缺 Bearer）也被拒', oa.authorize({ headers: { authorization: token } }).code === 'UNAUTHORIZED');
  check('正确令牌放行', oa.authorize({ headers: { authorization: `Bearer ${token}` } }).ok === true);

  check('默认勾选了对话', oa.allows('chat') === true);
  check('默认没有勾选记忆（个人数据，要用户自己开）', oa.allows('memory') === false);
  check('默认没有勾选语音', oa.allows('speech') === false);

  oa.update({ expose: { memory: true } });
  check('勾选后记忆才放行', oa.allows('memory') === true);

  oa.update({ enabled: false });
  check('关掉总开关后，已勾选的能力也一律不放行', oa.allows('memory') === false);

  // requireToken=false 时是明确的"谁都能进"，必须由用户显式选择
  oa.update({ enabled: true, requireToken: false });
  check('显式关掉令牌校验后才无需令牌', oa.authorize({ headers: {} }).ok === true);
}

async function partE() {
  console.log(`\nE. 端到端（临时服务 ${PORT} 端口）`);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST, DATA_DIR: TEST_DATA },
    stdio: 'ignore',
  });
  let alive = true;
  child.on('exit', () => (alive = false));

  const request = (method, reqPath, body, headers = {}) => new Promise((resolve, reject) => {
    const h = { ...headers };
    if (body) h['Content-Type'] = 'application/json';
    const req = http.request({ host: HOST, port: PORT, path: reqPath, method, headers: h }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });

  const j = r => { try { return JSON.parse(r.body); } catch { return {}; } };

  try {
    const deadline = Date.now() + 15000;
    let ready = false;
    while (Date.now() < deadline) {
      try { if ((await request('GET', '/api/status')).status === 200) { ready = true; break; } } catch { /* 等 */ }
      await new Promise(r => setTimeout(r, 250));
    }
    if (!ready) { check('临时服务就绪', false, '15 秒内没起来'); return; }

    // 管理端
    const pv = await request('GET', '/api/providers');
    check('GET /api/providers 返回预设表', pv.status === 200 && Array.isArray(j(pv).presets) && j(pv).presets.length >= 10,
      `预设数=${(j(pv).presets || []).length}`);
    check('预设表里含自定义端点这一项', (j(pv).presets || []).some(x => x.id === 'custom'));
    check('预设里不含任何明文密钥字段', !pv.body.includes('apiKey"') || !/"apiKey"\s*:\s*"[^"]+"/.test(pv.body), pv.body.slice(0, 120));

    const st = await request('GET', '/api/status');
    check('/api/status 带上外部接入状态', Boolean(j(st).ollama && j(st).ollama.external));
    check('/api/status 带上对外开放状态', Boolean(j(st).openapi));
    check('默认状态下 external.active 为 false', j(st).ollama.external.active === false);

    // 入向：未开启
    const m0 = await request('GET', '/v1/models');
    check('未开启时 /v1/models 返回 403', m0.status === 403, `实际 ${m0.status}`);

    // 开启
    const on = await request('PUT', '/api/openapi', JSON.stringify({ enabled: true, regenerateToken: true }));
    const token = j(on).tokenPlain;
    check('开启后拿到令牌', typeof token === 'string' && token.length > 10);

    check('开启后无令牌仍 401', (await request('GET', '/v1/models')).status === 401);
    check('错误令牌 401', (await request('GET', '/v1/models', null, { Authorization: 'Bearer nope' })).status === 401);

    const m1 = await request('GET', '/v1/models', null, { Authorization: `Bearer ${token}` });
    const mj = j(m1);
    check('正确令牌可列模型（200）', m1.status === 200, `实际 ${m1.status}`);
    check('模型列表里含虚拟模型 wenlv-assistant', (mj.data || []).some(x => x.id === 'wenlv-assistant'));
    check('模型条目是 OpenAI 的 {id,object,owned_by} 形状',
      (mj.data || []).every(x => x.object === 'model' && typeof x.id === 'string' && x.owned_by));

    // 能力勾选边界：记忆默认没开
    const mem = await request('GET', '/memory', null, { Authorization: `Bearer ${token}` });
    check('未勾选的能力走别名会被 403', mem.status === 403, `实际 ${mem.status}`);
    check('拒绝原因提示去设置里勾选', j(mem).error.includes('对外开放'));

    // 别名：勾选后 /wenlv/* 应通到 /api/wenlv/*
    const wl = await request('POST', '/wenlv/generate', JSON.stringify({ type: '不存在的类型' }), { Authorization: `Bearer ${token}` });
    check('别名 /wenlv/* 确实被转发到了内部路由（拿到参数校验错误而不是 404）',
      wl.status === 400 && j(wl).code === 'BAD_INPUT', `实际 ${wl.status} ${wl.body.slice(0, 80)}`);

    // 入向对话：有本地模型时才做真实生成
    const hasModel = Boolean(j(st).ollama && j(st).ollama.chatModel);
    if (hasModel) {
      const chat = await request('POST', '/v1/chat/completions',
        JSON.stringify({ model: 'wenlv-assistant', messages: [{ role: 'user', content: '只回答两个字：可以' }], stream: false }),
        { Authorization: `Bearer ${token}` });
      const cj = j(chat);
      check('入向非流式对话返回 200', chat.status === 200, `实际 ${chat.status} ${chat.body.slice(0, 120)}`);
      check('返回体是 OpenAI 的 chat.completion 形状',
        cj.object === 'chat.completion' && Array.isArray(cj.choices) && cj.choices[0].message.role === 'assistant');
      check('模型确实产出了内容（不是空壳）',
        Boolean(cj.choices && cj.choices[0].message.content && cj.choices[0].message.content.length > 0),
        JSON.stringify(cj.choices && cj.choices[0].message.content));

      const sbody = JSON.stringify({ model: 'wenlv-assistant', messages: [{ role: 'user', content: '只回答两个字：可以' }], stream: true });
      const sc = await request('POST', '/v1/chat/completions', sbody, { Authorization: `Bearer ${token}` });
      check('入向流式返回 text/event-stream', String(sc.headers['content-type'] || '').includes('text/event-stream'));
      const lines = sc.body.split('\n').filter(l => l.startsWith('data: '));
      check('流式最后以 [DONE] 收尾', lines[lines.length - 1].trim() === 'data: [DONE]', lines[lines.length - 1]);
      let concat = '';
      let sawFinish = false;
      for (const l of lines) {
        const payload = l.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const o = JSON.parse(payload);
          if (o.choices && o.choices[0]) {
            if (o.choices[0].delta && o.choices[0].delta.content) concat += o.choices[0].delta.content;
            if (o.choices[0].finish_reason) sawFinish = true;
          }
        } catch { /* 忽略 */ }
      }
      check('流式 chunk 能拼出内容', concat.length > 0, `拼出 ${concat.length} 字`);
      check('流式带 finish_reason', sawFinish);
    } else {
      skipped('入向真实对话', '本机没有可用的对话模型');
    }

    // 服务没被打崩
    check('跑完这些之后服务仍然存活', alive && (await request('GET', '/api/status')).status === 200);
  } finally {
    try { child.kill(); } catch { /* 忽略 */ }
  }
}

/**
 * F. 前端接线一致性（静态检查，不需要浏览器）
 *
 * 为什么需要：这个项目是零框架的原生 DOM，`$('#foo')` 找不到元素时**不会报错**，
 * 只是那行逻辑永远不执行 —— 界面上看起来一切正常，功能却是死的。
 * 所以给这个功能新加的控件值得用一次静态交叉检查钉住。
 */
function partF() {
  console.log('\nF. 前端接线一致性');

  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');

  const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const usedIds = new Set([...js.matchAll(/\$\$?\(\s*'#([A-Za-z0-9_-]+)/g)].map(m => m[1]));

  const dangling = [...usedIds].filter(id => !htmlIds.has(id));
  check('app.js 里没有指向不存在元素的 id 选择器', dangling.length === 0, dangling.join(', '));

  // 新加的控件必须都接上了线（写了 UI 却忘了绑事件是最容易漏的一类）
  const newIds = [...htmlIds].filter(id => /^(provider|openapi|web|geo|pano|i23d|blender)-|^fold-(provider|openapi|web|geo|pano|i23d|blender)|^btn-web$/.test(id));
  const unwired = newIds.filter(id => !usedIds.has(id));
  check('新增的各功能控件都已接线', unwired.length === 0, unwired.join(', '));
  check('新增控件数量符合预期（≥80）', newIds.length >= 80, `实际 ${newIds.length}`);

  // 首页必须真的带上入口，否则用户找不到这个功能
  check('设置页里有「模型接入」入口', html.includes('fold-provider') && html.includes('模型接入'));
  check('设置页里有「对外开放」入口', html.includes('fold-openapi') && html.includes('对外开放'));
  check('设置页里有「联网」入口', html.includes('fold-web') && html.includes('联网'));
  check('设置页里有「位置」入口', html.includes('fold-geo') && html.includes('位置'));
  check('设置页里有「景区全景」入口', html.includes('fold-pano') && html.includes('景区全景'));
  check('设置页里有「图片转 3D」入口', html.includes('fold-i23d') && html.includes('图片转 3D'));
  check('设置页里有「Blender 动画」入口', html.includes('fold-blender') && html.includes('Blender 动画'));
  check('输入区有联网开关按钮', html.includes('id="btn-web"'));
  check('舞台上有位置 HUD', html.includes('id="geo-hud"') && html.includes('id="geo-arrow"'));
  check('舞台上有全景模式提示', html.includes('id="pano-stage-hint"'));
}

async function main() {
  console.log('外部 API 接入测试（出向 + 入向）');
  console.log(`临时数据目录：${TEST_DATA}`);

  const fake = await startFakeOpenAI();
  try {
    await partA();
    await partB(fake);
    await partC(fake);
    await partD();
    await partE();
    partF();
  } finally {
    fake.close();
    try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过` : ''}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试自身出错：', e);
  process.exitCode = 1;
});
