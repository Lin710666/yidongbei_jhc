#!/usr/bin/env node
/**
 * 显存仲裁测试（跨子系统串行 + Ollama 让位）
 *
 * 运行：node test/gpu.js      （或 npm run test:gpu）
 *
 * 这个文件钉的是**锁的语义**，不是"能不能跑起来"。因为显存冲突这类 bug 的特点是：
 * 平时完全看不出来，只在两个任务刚好撞上的时候随机失败，而报错还指向别处
 * （CUDA out of memory、"模型没装进显存"、"语音服务 500"…）。
 *
 * 所以下面每一条都对应一种**会让人查半天**的错误实现：
 *   · 共享请求在独占任务期间偷偷跑掉（= 还是抢显存）
 *   · 独占排队时后到的高优先级任务被先到的低优先级挡住（= 用户点了没反应）
 *   · 共享请求放不出去（= 死锁，实测卡满过 120 秒）
 *   · Ollama 让位之后不预热（= 下次提问冷启动十几秒）
 *   · 连着跑独占任务时反复卸载/加载（= 每次都白等一个 settleMs）
 *   · 关掉仲裁时还有额外开销（= 帮倒忙）
 */

const { createGpu, PRIORITY } = require('../lib/gpu');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${extra !== undefined ? `  → ${extra}` : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 造一个可观测的假 Ollama */
function makeOllama() {
  let loaded = [{ name: 'qwen2.5:7b' }];
  const state = { evicted: [], preloaded: [], get loaded() { return loaded; } };
  return {
    ...state,
    api: {
      loaded: async () => loaded,
      unload: async (m) => { state.evicted.push(m); loaded = []; return { ok: true }; },
      preload: async (m) => { state.preloaded.push(m); loaded = [{ name: m }]; return { ok: true }; },
    },
  };
}

function makeGpu(ollama, gpuCfg = {}) {
  const prefs = { getConfig: () => ({ gpu: { exclusive: true, settleMs: 0, warmupDelayMs: 10, ...gpuCfg } }) };
  return createGpu({ ollama, prefs });
}

async function main() {
  console.log('显存仲裁测试\n');

  /* ================= A. 独占串行 ================= */
  console.log('A. 独占任务必须串行（同一时刻只有一个）');
  {
    let concurrent = 0;
    let maxConcurrent = 0;
    const g = makeGpu(makeOllama().api, { warmupDelayMs: 0 });
    const job = (n) => g.withExclusive({ name: n, priority: PRIORITY.user }, async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(25);
      concurrent--;
    });
    await Promise.all([job('A'), job('B'), job('C')]);
    check('三个独占任务的最大并发度是 1', maxConcurrent === 1, `实测 ${maxConcurrent}`);
    check('三个都跑完了（没有漏掉或被吞掉）', g.status().stats.exclusiveRuns === 3, JSON.stringify(g.status().stats));
    check('完成后锁已释放', g.status().exclusive === null);
  }

  /* ================= B. 共享请求被独占挡住 ================= */
  console.log('\nB. 独占进行中时，Ollama（共享）必须等');
  {
    const g = makeGpu(makeOllama().api, { warmupDelayMs: 0 });
    const order = [];
    const excl = g.withExclusive({ name: 'TripoSR', priority: PRIORITY.user }, async () => {
      order.push('excl:start');
      await sleep(60);
      order.push('excl:end');
    });
    await sleep(10);
    const shared = g.withShared({ name: '对话' }, async () => { order.push('shared:run'); });
    await sleep(10);
    check('独占持锁期间共享请求在排队', g.status().queued.shared === 1, JSON.stringify(g.status().queued));
    await Promise.all([excl, shared]);
    check('共享请求在独占结束**之后**才跑',
      order.indexOf('shared:run') > order.indexOf('excl:end'), order.join(' → '));
  }

  /* ================= C. 写者优先（防读者饿死写者） ================= */
  console.log('\nC. 有独占在排队时，新来的共享请求要让路');
  {
    const g = makeGpu(makeOllama().api, { warmupDelayMs: 0 });
    const order = [];
    // 先占住
    const first = g.withExclusive({ name: '第一', priority: PRIORITY.audio }, async () => {
      order.push('1:start'); await sleep(50); order.push('1:end');
    });
    await sleep(5);
    // 再排一个独占
    const second = g.withExclusive({ name: '第二', priority: PRIORITY.user }, async () => {
      order.push('2:start'); await sleep(5); order.push('2:end');
    });
    await sleep(5);
    // 这时来一个共享请求：它**不该**插到"第二"前面
    const shared = g.withShared({ name: '对话' }, async () => { order.push('shared'); });
    await Promise.all([first, second, shared]);
    check('共享请求没有插到已排队的独占前面',
      order.indexOf('shared') > order.indexOf('2:end'), order.join(' → '));
  }

  /* ================= D. 优先级插队 ================= */
  console.log('\nD. 高优先级独占要能插到低优先级前面');
  {
    const g = makeGpu(makeOllama().api, { warmupDelayMs: 0 });
    const order = [];
    const holder = g.withExclusive({ name: '占位', priority: PRIORITY.audio }, async () => {
      await sleep(60);
    });
    await sleep(5);
    // 低优先级先排队
    const low = g.withExclusive({ name: '深度图', priority: PRIORITY.background }, async () => {
      order.push('低:背景任务');
    });
    await sleep(5);
    // 高优先级后到
    const high = g.withExclusive({ name: '图片转3D', priority: PRIORITY.user }, async () => {
      order.push('高:用户点的');
    });
    check('排队时高优先级排到了低优先级前面',
      g.status().queued.exclusive.map(x => x.name).join(',') === '图片转3D,深度图',
      g.status().queued.exclusive.map(x => x.name).join(','));
    await Promise.all([holder, low, high]);
    check('实际执行顺序是高优先级先',
      order[0] === '高:用户点的', order.join(' → '));
    check('优先级常量是 user > audio > background',
      PRIORITY.user > PRIORITY.audio && PRIORITY.audio > PRIORITY.background,
      JSON.stringify(PRIORITY));
  }

  /* ================= E. Ollama 让位与预热 ================= */
  console.log('\nE. Ollama 让位 / 预热');
  {
    const o = makeOllama();
    const g = makeGpu(o.api, { warmupDelayMs: 10 });
    await g.withExclusive({ name: 'Whisper', priority: PRIORITY.audio }, async () => {});
    check('独占任务开工前把常驻模型请出去了', o.evicted.length === 1 && o.evicted[0] === 'qwen2.5:7b', JSON.stringify(o.evicted));
    check('让位状态记录在案', g.status().ollamaEvicted === true || o.preloaded.length > 0);

    await sleep(60);
    check('独占结束后把对话模型预热回来了', o.preloaded.length === 1, JSON.stringify(o.preloaded));
    check('预热只热最可能马上要用的那一个（不是全装回去）', o.preloaded.length === 1);
  }

  /* ================= F. 让位只做一次 + 预热防抖 ================= */
  console.log('\nF. 连着跑独占任务时不该反复卸载/加载');
  {
    const o = makeOllama();
    const g = makeGpu(o.api, { warmupDelayMs: 40 });
    await g.withExclusive({ name: 'A', priority: PRIORITY.user }, async () => {});
    await g.withExclusive({ name: 'B', priority: PRIORITY.user }, async () => {});
    await g.withExclusive({ name: 'C', priority: PRIORITY.user }, async () => {});
    check('三次独占只卸载了一次', o.evicted.length === 1, `卸载 ${o.evicted.length} 次`);
    await sleep(120);
    check('三次独占只预热了一次（中间那两次被防抖掉了）', o.preloaded.length === 1, `预热 ${o.preloaded.length} 次`);
  }

  /* ================= G. 关掉仲裁 ================= */
  console.log('\nG. 关掉仲裁时应当完全零开销');
  {
    const o = makeOllama();
    const g = makeGpu(o.api, { exclusive: false });
    const t0 = Date.now();
    await g.withExclusive({ name: 'x', priority: PRIORITY.user }, async () => {});
    const dt = Date.now() - t0;
    check('关掉后独占不排队、直接跑', dt < 50, `${dt}ms`);
    check('关掉后连让位都不做（否则是帮倒忙）', o.evicted.length === 0, JSON.stringify(o.evicted));
    check('status 如实反映"未启用"', g.status().enabled === false);
  }

  /* ================= H. 等待超时要报可操作的错 ================= */
  console.log('\nH. 排队等太久要报错，而不是无限等');
  {
    const g = makeGpu(makeOllama().api, { waitTimeoutMs: 5000, warmupDelayMs: 0 });
    // 占住 200ms，让后面的请求超时（这里把上限临时压低来验）
    const holder = g.withExclusive({ name: '长任务', priority: PRIORITY.user }, async () => { await sleep(300); });
    await sleep(10);
    let err = null;
    try {
      await g.acquireExclusive({ name: '等不到的', priority: PRIORITY.user, timeoutMs: 60 });
    } catch (e) { err = e; }
    check('排队超时抛出错误', !!err);
    check('错误码是 GPU_BUSY', err && err.code === 'GPU_BUSY', err && err.code);
    check('错误信息点名了当前占用者与下一步怎么办',
      !!err && /长任务/.test(err.message) && /设置/.test(err.message),
      err && err.message.replace(/\n/g, ' ').slice(0, 120));
    await holder;
  }

  /* ================= I. 真实接入：本地走闸门，外部不走 ================= */
  console.log('\nI. 接线：本地 Ollama 走共享闸门，外部 API 不排队');
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'inference.js'), 'utf8');
    check('inference.js 的本地分支包了 withShared',
      /localShared\(/.test(src) && /localSharedStream\(/.test(src));
    // 外部分支必须在 localShared 之外
    const chatBlock = src.slice(src.indexOf('providers.routes(\'chat\')'), src.indexOf("return localShared('对话'"));
    check('外部分支不经过显存闸门（外部调用不占本机显存，排队纯属添堵）',
      chatBlock.length > 0 && !/withShared|localShared/.test(chatBlock));

    const srv = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
    for (const [name, re] of [
      ['gpu 传给 inference', /createInference\(\{ ollama, providers, gpu \}\)/],
      ['gpu 传给 img23d', /createImg23D\(\{ dir: DATA_DIR, gpu \}\)/],
      ['gpu 传给 depth', /createDepth\(\{ dir: DATA_DIR, gpu \}\)/],
      ['gpu 传给 stt', /createSTT\(\{ dir: DATA_DIR, prefs, gpu \}\)/],
      ['gpu 传给 tts', /createTTS\(\{ cacheDir: TTS_CACHE, gpu \}\)/],
    ]) check(`server.js 里 ${name}`, re.test(srv));
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试自身出错：', e);
  process.exitCode = 1;
});
