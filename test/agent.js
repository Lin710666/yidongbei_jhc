#!/usr/bin/env node
/**
 * 联网协议与工具循环测试
 *
 * 运行：node test/agent.js      （或 npm run test:agent）
 *
 * 为什么这些用例要用"假的 inference"而不是打真模型：
 *   ① 工具循环的关键正确性（轮数封顶、重复调用去重、过程文字不能混进答案、
 *      两家协议的工具消息格式）全都是**我们的代码**决定的，跟模型聪不聪明无关。
 *      用脚本化的假模型能把每条分支精确摆出来，还能跑得飞快。
 *   ② 真模型 + 真外网的结果不稳定（搜索结果会变），没法当回归基线。
 *   真机联调我已经单独做过（搜索 → 抓正文 → 作答），这里只钉住代码行为。
 *
 * 覆盖：
 *   A. SSRF 防护与 HTML 转文本（纯函数，无网络）
 *   B. 工具参数校验与错误回传（不网络请求的失败路径）
 *   C. Agent 循环：单轮 / 多轮 / 轮数封顶 / 去重 / 过程文字隔离
 *   D. 工具消息的协议差异（Ollama 对象参数 vs OpenAI JSON 字符串 + tool_call_id）
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const web = require('../lib/web');
const tools = require('../lib/tools');
const { runAgent } = require('../lib/agent');
const ollama = require('../lib/ollama');
const providersLib = require('../lib/providers');
const { createInference } = require('../lib/inference');

let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${extra !== undefined ? `  → ${extra}` : ''}`); }
}

/* ==========================================================================
 * 假的 inference：按脚本一轮一轮地"回话"
 * ========================================================================*/
function makeFakeInference(script, { external = false } = {}) {
  let i = 0;
  const calls = [];
  return {
    calls,
    buildToolRound: (o) => buildToolRoundByMode(external, o),
    async *chatStream(opts) {
      calls.push(opts);
      const step = script[Math.min(i, script.length - 1)];
      i++;
      if (step.deltas) for (const d of step.deltas) yield { delta: d };
      yield { done: true, content: step.content || '', toolCalls: step.toolCalls || null };
    },
  };
}

/** 与 lib/inference.js 内部实现同构的一份，用于在测试里明确断言两种协议的形状 */
function buildToolRoundByMode(external, { content, toolCalls, results }) {
  const msgs = [];
  if (external) {
    msgs.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map((tc, i) => ({
        id: tc.id || `call_x_${i}`,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments || {}) },
      })),
    });
    for (let i = 0; i < results.length; i++) {
      msgs.push({ role: 'tool', tool_call_id: toolCalls[i].id || `call_x_${i}`, content: results[i].forModel });
    }
    return msgs;
  }
  msgs.push({
    role: 'assistant',
    content: content || '',
    tool_calls: toolCalls.map(tc => ({ function: { name: tc.name, arguments: tc.arguments || {} } })),
  });
  for (const r of results) msgs.push({ role: 'tool', content: r.forModel });
  return msgs;
}

async function collect(gen) {
  const out = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/* ========================================================================*/

async function partA() {
  console.log('\nA. SSRF 防护与 HTML 转文本');

  const blocked = ['127.0.0.1', '10.0.0.1', '172.16.5.5', '192.168.0.1', '169.254.169.254', '100.64.1.1', '0.0.0.0', '::1', 'fe80::1', 'fd12::1', '::ffff:127.0.0.1'];
  const allowed = ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111'];
  check('内网/回环/元数据地址全部拦截', blocked.every(a => web.isPrivateAddress(a)), blocked.filter(a => !web.isPrivateAddress(a)).join(','));
  check('公网地址放行（含 172.32 这类边界）', allowed.every(a => !web.isPrivateAddress(a)), allowed.filter(a => web.isPrivateAddress(a)).join(','));

  // 非公网协议与端口
  for (const [url, code] of [
    ['file:///C:/Windows/win.ini', 'BAD_URL'],
    ['ftp://example.com/x', 'BAD_URL'],
    ['http://127.0.0.1:8000/', 'BLOCKED_PRIVATE'],
    ['http://localhost:9876/', 'BLOCKED_PRIVATE'],
    ['http://example.com:8080/', 'BLOCKED_PORT'],
  ]) {
    let got = null;
    try { await web.assertPublicUrl(url); } catch (e) { got = e.code; }
    check(`拒绝 ${url}`, got === code, `实际 ${got}`);
  }

  // 诊断顺序：内网 + 非标端口同时命中时，应报"内网"而不是"端口"
  let orderCode = null;
  try { await web.assertPublicUrl('http://127.0.0.1:9999/'); } catch (e) { orderCode = e.code; }
  check('内网与非标端口同时命中时，报的是更根本的"内网"', orderCode === 'BLOCKED_PRIVATE', orderCode);

  // HTML → 文本
  const html = '<html><head><title>T</title><style>a{}</style></head><body>'
    + '<script>var x=1;</script><h1>标题</h1><p>第一段&amp;实体</p><ul><li>甲</li><li>乙</li></ul>'
    + '<!-- 注释 --><div>尾</div></body></html>';
  const text = web.htmlToText(html);
  check('去掉 script/style/注释', !text.includes('var x') && !text.includes('a{}') && !text.includes('注释'));
  check('保留正文并按块换行', text.includes('标题') && text.includes('第一段&实体') && text.includes('尾'));
  check('列表项转成 - 前缀', text.includes('- 甲'));
  check('标题标签本身不残留', !/<[a-z]/i.test(text), text.slice(0, 80));

  // &nbsp; 刻意解码成**普通空格**而不是 \u00a0：
  // 正文最终是喂给模型的，普通空格更稳（nbsp 在不少分词器里是独立 token），
  // 且 htmlToText 的空白折叠本来也会把 \u00a0 收成普通空格，两处口径一致。
  check('实体解码（命名实体）', web.decodeEntities('&lt;a&gt;&amp;&nbsp;&quot;') === '<a>& "',
    JSON.stringify(web.decodeEntities('&lt;a&gt;&amp;&nbsp;&quot;')));
  check('实体解码（数字实体）', web.decodeEntities('&#65;&#x42;') === 'AB');
  check('无法识别的实体原样保留', web.decodeEntities('&zzz;') === '&zzz;');
  check('超长正文被截断并标注', web.htmlToText('x'.repeat(500), { maxChars: 100 }).includes('已截断'));
}

async function partB() {
  console.log('\nB. 工具参数校验与错误回传');

  const r1 = await tools.runTool('no_such_tool', {});
  check('未知工具被明确拒绝并列出可用工具', r1.ok === false && r1.forModel.includes('web_search'), r1.forModel.slice(0, 80));

  const r2 = await tools.runTool('web_search', {});
  check('缺 query 时返回可读错误而不是抛异常', r2.ok === false && r2.forModel.includes('query'), r2.forModel.slice(0, 60));

  const r3 = await tools.runTool('web_fetch', { url: '' });
  check('空 URL 被拒', r3.ok === false && r3.forModel.includes('url'));

  const r4 = await tools.runTool('web_search', '{这不是 JSON');
  check('参数不是合法 JSON 时给出提示', r4.ok === false && r4.forModel.includes('JSON'), r4.forModel.slice(0, 60));

  // 关键：工具失败必须变成"给模型看的文本"，绝不能抛异常
  let threw = false;
  try { await tools.runTool('web_fetch', { url: 'file:///etc/passwd' }); } catch { threw = true; }
  check('工具内部错误不向外抛（否则会打断整轮对话）', threw === false);

  const r5 = await tools.runTool('web_fetch', { url: 'http://127.0.0.1:8000/x' });
  check('SSRF 拦截被转成给模型的说明', r5.ok === false && r5.forModel.includes('内网'), r5.forModel.slice(0, 100));

  check('工具 schema 结构合法（OpenAI function 形状）',
    tools.TOOL_SCHEMAS.every(t => t.type === 'function' && t.function.name && t.function.description && t.function.parameters));
  check('三个工具都在清单里',
    ['web_search', 'web_fetch', 'find_panorama'].every(n => tools.TOOL_NAMES.includes(n)));
}

async function partC() {
  console.log('\nC. Agent 循环');

  // --- 单轮：没有工具调用，正文即答案 ---
  {
    const inf = makeFakeInference([{ deltas: ['你', '好'], content: '你好' }]);
    const evs = await collect(runAgent({ inference: inf, messages: [{ role: 'user', content: 'hi' }], model: 'm' }));
    const done = evs.find(e => e.type === 'done');
    check('单轮：直接产出答案', done && done.content === '你好', done && done.content);
    check('单轮：没有工具事件', !evs.some(e => e.type === 'tool_start'));
    check('单轮：delta 事件被转发（打字机效果）', evs.filter(e => e.type === 'delta').length === 2);
  }

  // --- 多轮：过程文字必须被隔离，不能混进答案 ---
  {
    const inf = makeFakeInference([
      { deltas: ['我先查', '一下。'], content: '我先查一下。', toolCalls: [{ id: 'c1', name: 'web_fetch', arguments: { url: 'http://127.0.0.1:1/' } }] },
      { deltas: ['答案是', '42'], content: '答案是42' },
    ]);
    const evs = await collect(runAgent({ inference: inf, messages: [], model: 'm' }));
    const done = evs.find(e => e.type === 'done');
    check('多轮：最终答案只含最后一轮的正文', done && done.content === '答案是42', done && done.content);
    check('多轮：过程文字被 round_discard 收回', evs.some(e => e.type === 'round_discard' && e.text.includes('我先查')));
    check('多轮：工具执行了并产生 tool_start / tool_result',
      evs.some(e => e.type === 'tool_start') && evs.some(e => e.type === 'tool_result'));
    check('多轮：答案里不含过程文字', done && !done.content.includes('我先查'));
    check('多轮：steps 记录了执行轨迹', done && done.steps.length === 1 && done.steps[0].tool === 'web_fetch');
  }

  // --- 重复调用去重 ---
  {
    const sameArgs = { url: 'http://127.0.0.1:1/' };
    const inf = makeFakeInference([
      { content: '', toolCalls: [{ id: 'a', name: 'web_fetch', arguments: sameArgs }] },
      { content: '', toolCalls: [{ id: 'b', name: 'web_fetch', arguments: sameArgs }] },
      { content: '结束' },
    ]);
    const evs = await collect(runAgent({ inference: inf, messages: [], model: 'm' }));
    const results = evs.filter(e => e.type === 'tool_result');
    check('重复调用同一工具同参数时不再真的执行', results.length === 1, `实际执行 ${results.length} 次`);
    const done = evs.find(e => e.type === 'done');
    check('去重后仍能走到最终答案', done && done.content === '结束');
  }

  // --- 轮数封顶 ---
  {
    let counter = 0;
    const inf = makeFakeInference([{ content: '', toolCalls: [{ name: 'web_fetch', arguments: {} }] }]);
    // 每轮参数都不同，绕开去重，逼它跑到上限
    inf.chatStream = async function* () {
      counter++;
      yield { done: true, content: '', toolCalls: [{ name: 'web_fetch', arguments: { url: `http://127.0.0.1:1/${counter}` } }] };
    };
    let err = null;
    try { await collect(runAgent({ inference: inf, messages: [], model: 'm', maxSteps: 3 })); } catch (e) { err = e; }
    check('轮数用尽时明确报错而不是无限循环', err && err.code === 'AGENT_STEP_LIMIT', err && err.code);
    check('轮数用尽时把已执行的调用列出来', err && err.message.includes('web_fetch'));
    check('确实只跑了 maxSteps 轮', counter === 3, `实际 ${counter}`);
  }

  // --- 工具白名单过滤 ---
  {
    const inf = makeFakeInference([{ content: 'ok' }]);
    await collect(runAgent({
      inference: inf, messages: [], model: 'm',
      isAllowed: n => n !== 'web_fetch',
    }));
    const sentTools = (inf.calls[0].tools || []).map(t => t.function.name);
    check('isAllowed 能裁掉不允许的工具', !sentTools.includes('web_fetch') && sentTools.includes('web_search'), sentTools.join(','));
  }

  // --- 全部工具都被裁掉时不应传 tools 字段 ---
  {
    const inf = makeFakeInference([{ content: 'ok' }]);
    await collect(runAgent({ inference: inf, messages: [], model: 'm', tools: [], }));
    check('没有任何工具时不往请求里塞 tools 字段', inf.calls[0].tools === undefined);
  }

  // --- 模型调完工具却不给结论 ---
  {
    const inf = makeFakeInference([
      { content: '', toolCalls: [{ name: 'web_fetch', arguments: { url: 'http://127.0.0.1:1/' } }] },
      { content: '' },
    ]);
    let err = null;
    try { await collect(runAgent({ inference: inf, messages: [], model: 'm' })); } catch (e) { err = e; }
    check('模型没给结论时报 EMPTY 且不返回空答案', err && err.code === 'EMPTY', err && err.code);
  }
}

async function partD() {
  console.log('\nD. 工具消息的协议差异');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-agent-proto-'));
  try {
    const toolCalls = [{ id: 'call_1', name: 'web_search', arguments: { query: '杭州' } }];
    const results = [{ forModel: '搜索结果文本' }];

    // 本地（Ollama）：arguments 是对象；tool 消息不带 tool_call_id
    const local = createInference({
      ollama: { async resolveModels() { return { chat: 'x' }; }, async status() { return {}; } },
      providers: providersLib.createProviders({ dir: path.join(dir, 'local') }),
    });
    const lm = local.buildToolRound({ content: '想一下', toolCalls, results });
    check('本地：assistant.tool_calls[].function.arguments 是对象',
      lm[0].tool_calls[0].function.arguments && typeof lm[0].tool_calls[0].function.arguments === 'object');
    check('本地：assistant 带 tool_calls 而不是 tool_call_id', lm[0].tool_calls[0].type === undefined);
    check('本地：tool 消息只有 role 与 content',
      lm[1].role === 'tool' && lm[1].tool_call_id === undefined && lm[1].content === '搜索结果文本');

    // 外部（OpenAI 兼容）：arguments 必须是 JSON 字符串；tool 消息必须回填 tool_call_id
    const extStore = providersLib.createProviders({ dir: path.join(dir, 'ext') });
    extStore.update({
      mode: 'external',
      external: { presetId: 'custom', baseUrl: 'https://api.example.com/v1', apiKey: 'k', chatModel: 'm' },
    });
    const ext = createInference({
      ollama: { async resolveModels() { return { chat: 'x' }; }, async status() { return {}; } },
      providers: extStore,
    });
    const em = ext.buildToolRound({ content: '想一下', toolCalls, results });
    check('外部：assistant.tool_calls[].function.arguments 是 JSON 字符串',
      typeof em[0].tool_calls[0].function.arguments === 'string', typeof em[0].tool_calls[0].function.arguments);
    check('外部：JSON 字符串能被解析回原参数',
      JSON.parse(em[0].tool_calls[0].function.arguments).query === '杭州');
    check('外部：tool_calls 带 type=function 与 id',
      em[0].tool_calls[0].type === 'function' && em[0].tool_calls[0].id === 'call_1');
    check('外部：tool 消息回填了 tool_call_id',
      em[1].role === 'tool' && em[1].tool_call_id === 'call_1');
    check('外部：没有 id 时会补一个，避免协议要求缺失',
      (() => {
        const m = ext.buildToolRound({ content: '', toolCalls: [{ name: 'web_search', arguments: {} }], results: [{ forModel: 'x' }] });
        return Boolean(m[0].tool_calls[0].id) && m[1].tool_call_id === m[0].tool_calls[0].id;
      })());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  console.log('联网协议与工具循环测试');

  // 工具调用解析的规范化（ollama.js 与 providers.js 必须同口径）
  const norm = ollama.normalizeToolCalls;
  check('normalizeToolCalls：对象参数原样保留',
    norm([{ function: { name: 'a', arguments: { x: 1 } } }])[0].arguments.x === 1);
  check('normalizeToolCalls：JSON 字符串参数被解析',
    norm([{ function: { name: 'a', arguments: '{"x":2}' } }])[0].arguments.x === 2);
  check('normalizeToolCalls：坏 JSON 退化为空对象而不是抛错',
    norm([{ function: { name: 'a', arguments: '{bad' } }])[0].arguments && Object.keys(norm([{ function: { name: 'a', arguments: '{bad' } }])[0].arguments).length === 0);
  check('normalizeToolCalls：空数组返回 null', norm([]) === null);
  check('normalizeToolCalls：没有函数名的条目被丢弃',
    norm([{ function: { arguments: {} } }]) === null);

  await partA();
  await partB();
  await partC();
  await partD();

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试自身出错：', e);
  process.exitCode = 1;
});
