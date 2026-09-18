/**
 * gpu.js —— 跨子系统的显存仲裁（8GB 卡上最要命的那个问题）
 *
 * ## 问题长什么样
 *
 * 本项目有**五个**地方要吃显存，而它们原本各自为政：
 *
 *   · Ollama      对话 / 视觉 / 向量（`keep_alive` 默认 30 分钟，长期占着）
 *   · Qwen TTS    语音合成（另一个进程，也在同一张卡上）
 *   · Whisper     听觉（Python 子进程）
 *   · TripoSR     图片转 3D（256³ 等值面，本身就很紧）
 *   · Depth       全景深度高度图（Python 子进程）
 *
 * 两个同时进来就爆显存。而**爆显存的表现极其难查**：报错会指向别处 ——
 * "模型没完全装进显存"、"被别的程序抢了算力"、CUDA out of memory 栈，
 * 甚至只是慢得离谱。用户看到的是"随机失败"，开发看到的是"本地明明跑通过"。
 *
 * ## 做法：一个进程内的读写锁
 *
 *   · **独占（exclusive）**：TTS / Whisper / TripoSR / 深度图。同一时刻只允许一个。
 *   · **共享（shared）**：Ollama 的对话 / 视觉 / 向量。它自己会管模型装载，
 *     我们只需要保证"独占任务在跑的时候它别来掺一脚"。
 *
 * 关键是**写者优先**：一旦有独占任务在排队，新来的共享请求要等，而不是插队。
 * 否则一个持续提问的界面会让"图片转 3D"永远排不上队（读者饿死写者）。
 *
 * ## Ollama 让位
 *
 * 光是排队还不够 —— 独占任务开工前，显存里可能还躺着 5GB 的对话模型。
 * 所以拿到独占租约后会先把常驻模型请出去（`keep_alive: 0`），干完再预热回来。
 * 两个细节值得说：
 *
 *   1. **卸载不是立刻生效。** Ollama 收到请求到真正释放显存有一个短暂窗口，
 *      紧接着就启动 Python 会撞上残留占用。所以卸完等一小会儿再放行。
 *   2. **预热要防抖。** 连着跑三个独占任务时，不能"卸-装-卸-装-卸-装"。
 *      所以只有**最后一个**独占任务释放后才安排预热，并且延迟一小段时间，
 *      等这段时间内没有新的独占任务进来再真的预热。
 *
 * 允许用 `gpu.exclusive = false` 整个关掉（显存充裕的机器不需要这套）。
 */

/** 独占任务的默认优先级。数字越大越优先。 */
const PRIORITY = {
  /** 用户在界面上点出来的（图片转 3D、动画生成）—— 点了就该尽快有反应 */
  user: 100,
  /** 音频：说话与听话，交互性最强 */
  audio: 60,
  /** 后台自动跑出来的（全景深度图）—— 晚几秒没人会注意到 */
  background: 10,
};

/** 卸载 Ollama 之后、启动吃显存任务之前的缓冲：给驱动一点时间真的把显存还回来 */
const VRAM_SETTLE_MS = Number(process.env.WENLV_VRAM_SETTLE_MS || 900);

/** 独占全部结束后，隔多久才预热。这期间若又有独占任务进来，就不预热了。 */
const WARMUP_DELAY_MS = Number(process.env.WENLV_WARMUP_DELAY_MS || 2500);

function createGpu({ ollama, prefs, log = console } = {}) {
  // ---- 读写锁状态 ----
  let exclusive = null;          // 当前独占持有者 { name, priority, since }
  let sharedCount = 0;           // 当前共享占用数
  const sharedWaiters = [];      // 等共享的（FIFO 即可）
  const exclWaiters = [];        // 等独占的（按优先级，同级 FIFO）

  // ---- Ollama 让位状态 ----
  let evictedModels = [];        // 被我们请出去的模型名，用于之后预热
  let ollamaEvicted = false;     // 当前是否处于"已让位"状态，避免重复卸载
  let warmupTimer = null;
  let lastWarmup = null;         // { at, models, ok }

  const stats = {
    exclusiveRuns: 0, sharedRuns: 0,
    totalWaitMs: 0, maxWaitMs: 0,
    evictions: 0, warmups: 0,
  };

  function enabled() {
    const cfg = (prefs && prefs.getConfig && prefs.getConfig().gpu) || {};
    return cfg.exclusive !== false;      // 默认开
  }

  function cfgOf() {
    return (prefs && prefs.getConfig && prefs.getConfig().gpu) || {};
  }

  /** 独占任务等太久就该报错，而不是让用户对着转圈等下去 */
  function waitLimitMs() {
    return Math.max(5000, Number(cfgOf().waitTimeoutMs) || 180000);
  }

  function mkErr(message, code) {
    const e = new Error(message);
    e.code = code;
    return e;
  }

  /* ======================================================================
   * 读写锁
   * ====================================================================*/

  /** 现在能不能直接放行一个共享请求（Ollama） */
  function sharedCanPass() {
    // 有独占持有者，或者有独占在排队 —— 都要等。后者是"写者优先"，防读者饿死写者。
    return !exclusive && exclWaiters.length === 0;
  }

  function drain() {
    // 1) 先放独占：写者优先
    if (!exclusive && sharedCount === 0 && exclWaiters.length) {
      const w = exclWaiters.shift();
      if (w.timer) clearTimeout(w.timer);
      exclusive = { name: w.name, priority: w.priority, since: Date.now() };
      // 计数必须在这里也加一次：排队后被放行的任务同样"跑了一次"。
      // 只在快速路径加的话，统计会漏掉所有排过队的任务（测试当场抓到过）。
      stats.exclusiveRuns++;
      const waitMs = Date.now() - w.enqueuedAt;
      stats.totalWaitMs += waitMs;
      if (waitMs > stats.maxWaitMs) stats.maxWaitMs = waitMs;
      w.resolve(makeExclusiveLease(w.name, waitMs));
      return;
    }
    // 2) 没有独占在等，就把**所有**共享请求一次放出去。
    //
    // 这里曾经写成"再要求 sharedWaiters 为空才放"，于是等待队列里的共享请求
    // 永远等不到人去唤醒它 —— 直接死锁（实测卡满 120 秒）。判据只能是
    // "有没有独占挡着"，不能把"有人在等"也当成不能放行的理由。
    if (!sharedCanPass()) return;
    while (sharedWaiters.length) {
      const w = sharedWaiters.shift();
      if (w.timer) clearTimeout(w.timer);
      sharedCount++;
      stats.sharedRuns++;
      w.resolve(makeSharedLease(w.name, Date.now() - w.enqueuedAt));
    }
  }

  function makeExclusiveLease(name, waitedMs) {
    let done = false;
    return {
      kind: 'exclusive',
      name,
      waitedMs,
      get released() { return done; },
      release() {
        if (done) return;
        done = true;
        exclusive = null;
        // 独占全部结束 → 安排预热（防抖）
        if (!exclusive && sharedCount === 0) scheduleWarmup();
        drain();
      },
    };
  }

  function makeSharedLease(name, waitedMs) {
    let done = false;
    return {
      kind: 'shared',
      name,
      waitedMs,
      get released() { return done; },
      release() {
        if (done) return;
        done = true;
        sharedCount = Math.max(0, sharedCount - 1);
        drain();
      },
    };
  }

  /**
   * 拿一个独占租约。**调用方必须 release**，推荐直接用 withExclusive()。
   */
  function acquireExclusive({ name = 'task', priority = PRIORITY.background, timeoutMs } = {}) {
    if (!enabled()) {
      // 关掉仲裁时也要给一个"形状一样"的租约，调用方不用写两套分支
      exclusive = { name, priority, since: Date.now() };
      stats.exclusiveRuns++;
      return Promise.resolve(makeExclusiveLease(name, 0));
    }
    // 无人在用、也没人在等 → 直接给
    if (!exclusive && sharedCount === 0 && exclWaiters.length === 0) {
      exclusive = { name, priority, since: Date.now() };
      stats.exclusiveRuns++;
      return Promise.resolve(makeExclusiveLease(name, 0));
    }

    const limit = timeoutMs || waitLimitMs();
    return new Promise((resolve, reject) => {
      const w = { name, priority, enqueuedAt: Date.now(), resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = exclWaiters.indexOf(w);
        if (i >= 0) exclWaiters.splice(i, 1);
        const holder = exclusive ? `「${exclusive.name}」` : '另一个任务';
        reject(mkErr(
          `等待显存超时（已等 ${Math.round(limit / 1000)} 秒）。当前 ${holder} 还在占用显卡。\n`
          + '可以稍后重试，或把「设置 → 显存仲裁」里的等待上限调大、或直接关掉仲裁（显存充裕时）。',
          'GPU_BUSY',
        ));
      }, limit);
      exclWaiters.push(w);
      // 按优先级排序；同级保持先来先到
      exclWaiters.sort((a, b) => (b.priority - a.priority) || (a.enqueuedAt - b.enqueuedAt));
      drain();
    });
  }

  /** 拿一个共享租约（Ollama 用） */
  function acquireShared({ name = 'ollama', timeoutMs } = {}) {
    if (!enabled()) {
      stats.sharedRuns++;
      return Promise.resolve(makeSharedLease(name, 0));
    }
    if (sharedCanPass()) {
      sharedCount++;
      stats.sharedRuns++;
      return Promise.resolve(makeSharedLease(name, 0));
    }
    const limit = timeoutMs || waitLimitMs();
    return new Promise((resolve, reject) => {
      const w = { name, enqueuedAt: Date.now(), resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        const i = sharedWaiters.indexOf(w);
        if (i >= 0) sharedWaiters.splice(i, 1);
        reject(mkErr(
          `等待显存超时（已等 ${Math.round(limit / 1000)} 秒）。正在执行「${exclusive ? exclusive.name : '独占任务'}」，`
          + '它需要独占显卡。请稍后重试。',
          'GPU_BUSY',
        ));
      }, limit);
      sharedWaiters.push(w);
      drain();
    });
  }

  /**
   * 在独占保护下跑一段活。
   *
   * 顺序很讲究：先拿租约 → 请 Ollama 让位 → 等显存真正还回来 → 干活 → 释放。
   * 把"让位"放在租约**之内**，才能保证让位期间没有新的共享请求插进来把模型又装回去。
   */
  async function withExclusive(opts, fn) {
    const o = typeof opts === 'string' ? { name: opts } : (opts || {});
    const lease = await acquireExclusive(o);
    try {
      // 关掉仲裁时连"让位"也不做 —— 否则用户关掉它只是想省开销，
      // 结果每次独占任务前还是白等一个 settleMs，属于帮倒忙。
      if (enabled() && o.yieldOllama !== false) await yieldOllama();
      return await fn(lease);
    } finally {
      lease.release();
    }
  }

  /** 在共享保护下跑一段活（Ollama 调用走这条） */
  async function withShared(opts, fn) {
    const o = typeof opts === 'string' ? { name: opts } : (opts || {});
    const lease = await acquireShared(o);
    try {
      return await fn(lease);
    } finally {
      lease.release();
    }
  }

  /* ======================================================================
   * Ollama 显存让位 / 预热
   * ====================================================================*/

  /**
   * 把常驻显存的 Ollama 模型请出去。
   *
   * 已经让过位就不重复问一遍（连着跑独占任务时 Ollama 本来就空着）。
   * 探测不到就什么也不做 —— 不该因为"问不到"而拦住业务。
   */
  async function yieldOllama() {
    if (!ollama || !ollama.loaded) return { ok: true, skipped: 'no-ollama' };
    if (ollamaEvicted) return { ok: true, skipped: 'already' };

    let list = [];
    try { list = await ollama.loaded(); } catch { list = []; }
    if (!list.length) { ollamaEvicted = true; return { ok: true, skipped: 'nothing-loaded' }; }

    const names = list.map(m => m.name).filter(Boolean);
    for (const n of names) {
      try { await ollama.unload(n); } catch { /* 单个卸不掉不影响其余的 */ }
    }
    evictedModels = names;
    ollamaEvicted = true;
    stats.evictions++;

    // 卸载是异步生效的：不给缓冲就启动 Python，多半还是撞上残留占用
    const settle = Math.max(0, Number(cfgOf().settleMs != null ? cfgOf().settleMs : VRAM_SETTLE_MS));
    if (settle) await new Promise(r => setTimeout(r, settle));
    return { ok: true, evicted: names, settleMs: settle };
  }

  /** 安排一次预热；期间若又来了独占任务就取消（防抖） */
  function scheduleWarmup() {
    if (!ollama || !ollama.preload) return;
    if (!ollamaEvicted) return;
    const cfg = cfgOf();
    if (cfg.warmup === false) { ollamaEvicted = false; evictedModels = []; return; }

    if (warmupTimer) clearTimeout(warmupTimer);
    warmupTimer = setTimeout(async () => {
      warmupTimer = null;
      // 延迟期间又进了独占任务 → 这次不预热，等它结束再说
      if (exclusive || exclWaiters.length) return;
      const models = evictedModels.slice();
      ollamaEvicted = false;
      evictedModels = [];
      if (!models.length) return;

      // 只预热"最可能马上要用"的那个：通常就是对话模型（列表第一项）。
      // 全预热回去等于自己把显存又占满，"让位"就白做了。
      const target = models[0];
      try {
        const r = await ollama.preload(target);
        lastWarmup = { at: Date.now(), model: target, ok: !!(r && r.ok) };
        if (r && r.ok) stats.warmups++;
      } catch { /* 预热失败不影响功能，下次提问就是冷启动而已 */ }
    }, Math.max(0, Number(cfg.warmupDelayMs != null ? cfg.warmupDelayMs : WARMUP_DELAY_MS)));
    if (warmupTimer.unref) warmupTimer.unref();
  }

  /** 强制立刻预热（比如用户刚问完一个问题） */
  async function warmupNow(model) {
    if (!ollama || !ollama.preload) return { ok: false, error: 'no-ollama' };
    const list = evictedModels.slice();
    const target = model || list[0];
    ollamaEvicted = false;
    evictedModels = [];
    if (!target) return { ok: false, error: '没有可预热的模型' };
    const r = await ollama.preload(target);
    lastWarmup = { at: Date.now(), model: target, ok: !!(r && r.ok) };
    if (r && r.ok) stats.warmups++;
    return r;
  }

  /**
   * 「本地优先」的显存侧那一半：确认本地模型**这一轮完全用不上**时，把显存让出来。
   *
   * 场景：用户在「设置 → 模型接入」里把对话、视觉、向量**三个都**切到了外部 API。
   * 这时本机 Ollama 一个模型都不会被用到，而它还按 keep_alive（30 分钟）躺在显存里
   * 占着 5GB —— 白占。请出去之后，TTS / Whisper / TripoSR 的可用显存立刻宽松很多。
   *
   * 判据刻意是"三个都外部"，而不是"对话是外部"：
   * 绝大多数外部供应商只有对话接口，视觉与向量仍然走本地。
   * 只看对话就卸载，会把记忆检索（向量）当场打回冷启动，越"优化"越慢。
   *
   * 与 yieldOllama 的区别：这条**不安排预热** —— 本地都不用，预热回去毫无意义。
   */
  async function releaseLocalIfUnused({ allExternal = false, reason = '' } = {}) {
    if (!enabled()) return { ok: true, skipped: 'arbiter-off' };
    if (!ollama || !ollama.loaded) return { ok: true, skipped: 'no-ollama' };
    if (!allExternal) return { ok: true, skipped: 'still-need-local' };

    let list = [];
    try { list = await ollama.loaded(); } catch { list = []; }
    if (!list.length) { ollamaEvicted = true; return { ok: true, skipped: 'nothing-loaded' }; }

    const names = list.map(m => m.name).filter(Boolean);
    for (const n of names) {
      try { await ollama.unload(n); } catch { /* 单个卸不掉不影响其余 */ }
    }
    // 记成"已让位"，但**清空待预热列表** —— 上面那条不预热的决定就落在这里
    ollamaEvicted = true;
    evictedModels = [];
    stats.evictions++;
    stats.localReleasedForExternal = (stats.localReleasedForExternal || 0) + 1;
    return { ok: true, released: names, reason };
  }

  /* ======================================================================
   * 状态（给 /api/status 与设置面板）
   * ======================================================================*/

  function status() {
    return {
      enabled: enabled(),
      // 现在谁占着卡
      exclusive: exclusive ? { name: exclusive.name, priority: exclusive.priority, heldMs: Date.now() - exclusive.since } : null,
      shared: sharedCount,
      queued: { exclusive: exclWaiters.map(w => ({ name: w.name, priority: w.priority, waitedMs: Date.now() - w.enqueuedAt })), shared: sharedWaiters.length },
      ollamaEvicted,
      evictedModels: evictedModels.slice(),
      lastWarmup,
      stats: { ...stats },
      priorities: PRIORITY,
      waitTimeoutMs: waitLimitMs(),
    };
  }

  /** 给测试用：等所有队列静默下来 */
  function _idle() {
    return new Promise(resolve => {
      const t = setInterval(() => {
        if (!exclusive && sharedCount === 0 && !exclWaiters.length && !sharedWaiters.length) {
          clearInterval(t);
          resolve(true);
        }
      }, 5);
      if (t.unref) t.unref();
    });
  }

  return {
    PRIORITY,
    acquireExclusive,
    acquireShared,
    withExclusive,
    withShared,
    yieldOllama,
    releaseLocalIfUnused,
    warmupNow,
    status,
    enabled,
    _idle,
  };
}

module.exports = { createGpu, PRIORITY, VRAM_SETTLE_MS, WARMUP_DELAY_MS };
