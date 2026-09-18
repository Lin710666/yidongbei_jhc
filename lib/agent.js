/**
 * agent.js —— 工具调用循环（让模型真的能"上网查完再回答"）
 *
 * 一次完整的联网问答长这样：
 *
 *   用户提问 → 模型决定调 web_search("杭州西湖 门票")
 *            → 我们执行搜索，把结果作为 tool 消息喂回去
 *            → 模型看到结果，可能再调 web_fetch 读某个页面
 *            → 直到它不再调工具，直接给出答案（这一轮的正文才是答案）
 *
 * 三件事必须在这里兜住，否则模型会把整件事搞砸：
 *
 *   1. **步数封顶。** 模型陷入"再查一次"的循环是常见故障。除了 maxSteps，
 *      还对"用同样的参数调同一个工具"做去重 —— 遇到就回一句"这个调用刚刚做过了"
 *      让它换个思路，而不是把同样的请求再发一遍浪费几十秒。
 *
 *   2. **区分"过程"和"答案"。** 模型调工具前可能先吐几句判断（"我需要先查一下…"），
 *      那不是答案。所以要按轮隔离：带工具调用的那一轮，正文归入"步骤说明"；
 *      只有不再调工具的那一轮，正文才是给用户看的答案。
 *      为此会发一个 round_discard 事件，让界面把已经流出去的过程文字收进步骤里，
 *      而不是让它留在答案区里冒充结论。
 *
 *   3. **工具失败不能让整轮崩掉。** 失败会被包成一条"工具输出"回给模型
 *      （见 lib/tools.js），模型有机会换关键词重试。
 */

const { TOOL_SCHEMAS, runTool } = require('./tools');

const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS || 4);

/** 同一轮里最多并行执行几个工具调用（模型偶尔会一次返回好几个） */
const MAX_CALLS_PER_ROUND = 4;

function mkError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * 跑一轮工具循环。
 *
 * @param {object}   o
 * @param {object}   o.inference   路由层（lib/inference.js）
 * @param {Array}    o.messages    初始 messages（含 system 与用户消息）
 * @param {string}   o.model       模型名
 * @param {Array}    [o.tools]     工具 schema，默认全部；传 [] 表示禁用联网
 * @param {number}   [o.maxSteps]
 * @param {object}   [o.isAllowed] 可选：按工具名二次过滤（例如只允许搜索、不允许抓取）
 * @param {object}   [o.toolContext] 透传给工具实现的上下文。目前用于 avatar_action ——
 *   前端上报的"这只模型有哪些动作/表情"只有在浏览器里才知道，服务端拿它校验名字。
 *
 * @returns {AsyncGenerator} 事件流，详见文件头与各 yield 处的注释
 */
async function* runAgent({
  inference,
  messages,
  model,
  tools = TOOL_SCHEMAS,
  maxSteps = MAX_STEPS,
  temperature = 0.4,
  numPredict = 2048,
  numCtx,
  timeout,
  isAllowed,
  toolContext,
}) {
  const activeTools = (Array.isArray(tools) ? tools : []).filter(t => {
    const name = t && t.function && t.function.name;
    return name && (!isAllowed || isAllowed(name));
  });

  const convo = messages.slice();
  const steps = [];              // 供界面与调试使用的执行记录
  const toolData = {};           // 结构化结果（例如全景候选）交给上层
  const seenCalls = new Set();   // 去重：见过 "工具名+参数" 就不再重复执行
  let lastRoundText = '';        // 最后一轮的正文，步数用尽时拿它当答案（有总比没有好）

  for (let round = 1; round <= maxSteps; round++) {
    yield { type: 'round', round, maxSteps };

    let roundText = '';
    let roundTools = null;

    for await (const chunk of inference.chatStream({
      model,
      messages: convo,
      temperature,
      numPredict,
      numCtx,
      timeout,
      tools: activeTools.length ? activeTools : undefined,
    })) {
      if (chunk.delta) {
        // 先照常流出去：绝大多数提问只有一轮，等全部生成完再显示会毁掉打字机效果
        roundText += chunk.delta;
        yield { type: 'delta', text: chunk.delta };
      }
      if (chunk.done) {
        roundText = chunk.content || roundText;
        roundTools = chunk.toolCalls || null;
      }
    }

    // ---- 没有工具调用：这一轮的正文就是最终答案 ----
    if (!roundTools || !roundTools.length) {
      // 只把**这一轮**的文字当答案。
      // 之前写成"每轮都累加进 totalText"，结果中间轮的过场话（"让我再查一下…"）
      // 会被拼到最终答案前面，用户看到的结论开头是一句没头没尾的自言自语。
      const answer = roundText.trim();
      if (!answer) {
        // 模型没给出任何正文（少见，但确实会发生）。这时别返回空字符串让界面一脸茫然，
        // 如实把工具执行情况交代清楚，用户至少知道发生了什么。
        throw mkError(
          '模型调用完工具后没有给出任何结论。\n'
          + `已执行的调用：\n${steps.map(s => `  · ${s.tool}(${JSON.stringify(s.args).slice(0, 80)}) → ${s.summary}`).join('\n') || '  （无）'}\n`
          + '可以换个问法，或把问题拆得更具体一些。',
          'EMPTY',
        );
      }
      yield { type: 'done', content: answer, model, steps, toolData, rounds: round };
      return;
    }

    // ---- 有工具调用：把刚才流出去的那段正文收回来（它是过程，不是答案）----
    if (roundText.trim()) {
      yield { type: 'round_discard', text: roundText };
    }
    lastRoundText = roundText;

    const calls = roundTools.slice(0, MAX_CALLS_PER_ROUND);
    const results = [];

    for (let i = 0; i < calls.length; i++) {
      const tc = calls[i];
      const name = tc.name;
      const args = tc.arguments || {};

      // 同一个调用重复出现：不重复执行，直接告诉模型"做过了"
      const key = `${name}:${JSON.stringify(args)}`;
      let result;
      if (seenCalls.has(key)) {
        result = {
          ok: false,
          name,
          forModel: `提示：你刚刚已经用完全相同的参数调用过 ${name} 了，结果在上一条工具消息里。请基于已有结果作答，或换一组参数再试。`,
          summary: '重复调用已跳过',
          data: null,
        };
      } else {
        seenCalls.add(key);
        yield { type: 'tool_start', name, args, index: i };
        const t0 = Date.now();
        result = await runTool(name, args, toolContext);
        result.ms = Date.now() - t0;
        result.args = args;
        yield {
          type: 'tool_result',
          name,
          ok: result.ok,
          summary: result.summary,
          data: result.data,
          ms: result.ms,
          args,
        };
      }

      if (result.ok && result.data) toolData[name] = result.data;
      steps.push({ tool: name, args, ok: result.ok, summary: result.summary, ms: result.ms });
      results.push(result);
    }

    // 把这一轮织进对话，继续下一轮
    const roundMessages = inference.buildToolRound({
      content: roundText,
      toolCalls: calls,
      results,
    });
    for (const m of roundMessages) convo.push(m);
  }

  // 步数用尽还没给出最终答案：把最后一轮的文字（如果有）当答案，否则如实报错
  if (lastRoundText.trim()) {
    yield { type: 'done', content: lastRoundText.trim(), model, steps, toolData, rounds: maxSteps, hitStepLimit: true };
    return;
  }
  throw mkError(
    `模型连续调用了 ${maxSteps} 轮工具仍未给出结论，已停止（避免无限循环）。\n`
    + `已执行的调用：\n${steps.map(s => `  · ${s.tool}(${JSON.stringify(s.args).slice(0, 80)}) → ${s.summary}`).join('\n') || '  （无）'}\n`
    + '可以把问题问得更具体一些，或调大 AGENT_MAX_STEPS。',
    'AGENT_STEP_LIMIT',
  );
}

module.exports = { runAgent, MAX_STEPS, MAX_CALLS_PER_ROUND };
