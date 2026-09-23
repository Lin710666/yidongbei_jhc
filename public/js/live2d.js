/* ============================================================================
 * live2d.js —— Live2D 舞台（PixiJS + pixi-live2d-display/cubism4）
 *
 * 目标：把原项目"网页表单"里没有的、airi 最有辨识度的部分 —— 会呼吸、会眨眼、
 * 会看着你的鼠标、说话时嘴会动的虚拟人物 —— 保留并做扎实。
 *
 * 能力：
 *   · 载入 model3.json（本地 /models/<id>/，离线可用）
 *   · 自动眨眼 / 呼吸：引擎自带（model3.json 的 EyeBlink 组 + physics3.json）
 *   · 视线跟随鼠标
 *   · 说话嘴型同步：读 TTS 音频的实时音量驱动 LipSync 参数（ParamMouthOpenY）
 *   · 表情切换（读 model3.json 的 Expressions 列表）
 *   · 自适应缩放 / 位移，窗口变化自动重排
 *   · 加载失败时给出可操作的提示，而不是空白舞台
 * ==========================================================================*/
(function () {
  'use strict';

  const { $ } = window.U;

  class Live2DStage {
    constructor(canvas) {
      this.canvas = canvas;
      this.app = null;
      this.model = null;
      this.modelId = null;
      this.baseScale = 1;
      this.userScale = 1;
      this.userX = 0;
      this.userY = 0;
      this.mouthOpen = 0;
      this.targetMouthOpen = 0;
      this.analyser = null;
      this.audioCtx = null;
      this.audioSource = null;
      this.audioEl = null;
      // 文本驱动口型（没有音频可放时用，见 talkTo / tick 里的分支）
      this.talking = false;
      this.talkText = '';
      this.talkIndex = 0;
      this.talkAcc = 0;
      this.lastTick = 0;
      this.rafId = null;
      this.resizeRaf = 0;
      this.ro = null;
      this.lastDpr = 0;
      this.ready = false;
      this.onReadyCb = null;
      this.onErrorCb = null;
      /* 视角跟随（鼠标/手指移到哪，人物头与眼看向哪）。
       *
       * 为什么要做成可关的开关：库的 `updateFocus()` 是**叠加**写
       * ParamAngleX/Y/Z 的，幅度不小。多数模型这么用没问题，但对
       * 用「九轴经纬网面部变形器」的模型（比如自建的 hanfu），
       * 大幅角度会把面部网格撕开 —— 表现就是**人物一被鼠标扫过就崩坏**。
       * 这类模型只能关掉跟随。
       *
       * 默认 true：保持大屏触屏上"人物是活的"这个既有体验不变，
       * 只对需要关的模型单独设 false（见 app.js 里的 useFocus 判断）。 */
      this.focusFollow = true;
      this._pointHandler = null;
      this.onTapCb = null;
      this.expressions = [];
      this.motions = [];

      // 口型参数名。**不能写死 ParamMouthOpenY**：实测不同模型的命名风格完全不同，
      // Live2D 官方示例用 ParamMouthOpenY，从 VTube Studio 导入的那批用
      // ParamMouthOpen 或全大写的 PARAM_MOUTH_OPEN_Y。指到不存在的参数上不会报错，
      // 只是嘴永远不动 —— 属于"看起来装好了、其实没生效"的隐性故障。
      this.lipSyncParam = null;
      // 该模型真实存在的全部参数 id（从 cdi3.json 读），用来做能力探测
      this.paramIds = new Set();
      // 规范化后的常用参数 id 映射：{ angleX: 'ParamAngleX' | null, ... }
      this.p = {};

      // 程序化待机（呼吸 / 微摆 / 视线游移 / 定时抽小动作），见 startIdle()
      this.idle = {
        on: false, raf: 0, t0: 0,
        phase: Math.random() * 6.28,
        nextMotionAt: 0, motionEveryMs: 14000,
        gazeX: 0, gazeY: 0, gazeAt: 0, nextGazeAt: 0,
        speaking: false,
      };
      this.placard = null;
      this.scenery = null;
    }

    /** 检查运行时是否就绪：三个脚本缺一不可 */
    static runtimeAvailable() {
      if (typeof window.PIXI === 'undefined') return '未加载 PixiJS（public/vendor/pixi.min.js）';
      if (typeof window.PIXI.live2d === 'undefined') return '未加载 pixi-live2d-display（public/vendor/pixi-live2d-display-cubism4.min.js）';
      if (typeof window.Live2DCubismCore === 'undefined') return '未加载 Live2D Cubism Core（public/vendor/live2dcubismcore.min.js）';
      return null;
    }

    async init() {
      const problem = Live2DStage.runtimeAvailable();
      if (problem) throw new Error(problem);

      const host = this.canvas.parentElement;
      const rect = host.getBoundingClientRect();
      const width = Math.max(1, Math.floor(rect.width));
      const height = Math.max(1, Math.floor(rect.height));

      this.app = new window.PIXI.Application({
        view: this.canvas,
        width,
        height,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        // preserveDrawingBuffer 便于"截图当前帧"这类扩展能力
        preserveDrawingBuffer: true,
      });

      // 指针移动 → 视线跟随（把屏幕坐标换算成模型坐标系的 -1..1）
      //
      // ★ 用 pointermove 而不是 mousemove。
      //
      // 本项目面向**展厅大屏**（有 kiosk 模式），而大屏基本都是触屏：
      // 只监听 mousemove 的话，手指在屏幕上划、人物眼睛一动不动 ——
      // 观感上就是"这个形象是死的"。实测 stage3d.js 与 lake.js 本来就收
      // pointerdown / pointermove，只有 Live2D 这一条漏了，三条舞台行为不一致。
      //
      // pointermove 在鼠标下也会触发，所以不需要再留 mousemove：
      // 两个都留会让同一个移动被处理两次（focus 有平滑插值，重复调用只是浪费）。
      const onPoint = (e) => {
        this.markPointer();
        if (!this.model) return;
        // 关掉跟随时仍然记一笔 pointer 时间戳（上面那句已经做了），
        // 这样程序化待机的"视线游移"也会让位给用户的手势，不会自己乱瞟。
        if (!this.focusFollow) return;
        const r = host.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 2 - 1;
        const y = ((e.clientY - r.top) / r.height) * 2 - 1;
        this.model.focus(x, y);
      };
      this._pointHandler = onPoint;
      host.addEventListener('pointermove', onPoint, { passive: true });
      // 触屏手指抬起后用 pointerleave 收不到（触摸不会"离开"），
      // 所以额外在 pointerup / pointercancel 上把视线收回正前方。
      host.addEventListener('pointerleave', () => { if (this.model) this.model.focus(0, 0); });
      for (const ev of ['pointerup', 'pointercancel']) {
        host.addEventListener(ev, () => { if (this.model) this.model.focus(0, 0); }, { passive: true });
      }

      // 点击人物 → 交给上层做互动
      this.app.stage.interactive = true;
      this.app.stage.hitArea = new window.PIXI.Rectangle(0, 0, width, height);
      this.app.stage.on('pointertap', () => { if (this.onTapCb) this.onTapCb(); });

      window.addEventListener('resize', () => this.scheduleResize());
      // 光靠 window.resize 不够：舞台尺寸会因为侧栏、全屏词云、字体加载等原因变，
      // 这些不一定触发 window 的 resize。ResizeObserver 盯着舞台本体最稳。
      if (typeof window.ResizeObserver === 'function') {
        this.ro = new window.ResizeObserver(() => this.scheduleResize());
        this.ro.observe(host);
      }
      this.lastDpr = Math.min(window.devicePixelRatio || 1, 2);
      this.loop();
      this.ready = true;
    }

    /** 一帧内触发多次也只重排一次，避免拖动窗口时反复重算 */
    scheduleResize() {
      if (this.resizeRaf) return;
      this.resizeRaf = requestAnimationFrame(() => {
        this.resizeRaf = 0;
        this.resize();
      });
    }

    /** 载入模型。url 形如 /models/nahida/Nahida.model3.json */
    async load(url, { label, focusFollow } = {}) {
      if (!this.app) await this.init();

      // 视角跟随可由调用方按模型关掉（见构造函数里 focusFollow 的说明）。
      // 用 `=== false` 判断是为了让"不传"保持原行为（跟随）。
      if (focusFollow === false) this.focusFollow = false;
      else if (focusFollow === true) this.focusFollow = true;
      if (!this.focusFollow && this.model && typeof this.model.focus === 'function') {
        // 关掉时把目光复位，避免上一次跟随留下的偏头卡在那里
        try { this.model.focus(0, 0); } catch { /* 忽略 */ }
      }

      // pixi-live2d-display 需要显式告诉它 ticker 用哪一个，否则动作不会自动播
      if (window.PIXI.live2d && window.PIXI.live2d.Live2DModel) {
        try {
          window.PIXI.live2d.Live2DModel.registerTicker(window.PIXI.Ticker);
        } catch { /* 已注册过 */ }
      }

      if (this.model) {
        this.app.stage.removeChild(this.model);
        this.model.destroy();
        this.model = null;
      }
      // 旧模型的 internalModel 已经销毁，挂在它上面的待机钩子一并失效。
      // 不清掉这个引用的话，新模型永远挂不上钩子（_attachIdleHook 会以为已挂过）。
      this._idleHook = null;

      let model;
      try {
        model = await window.PIXI.live2d.Live2DModel.from(url, { autoInteract: false, idleMotionGroup: 'Idle' });
      } catch (e) {
        throw new Error(`Live2D 模型加载失败：${e && e.message ? e.message : e}\n模型地址：${url}\n请确认文件存在且未损坏。`);
      }

      this.model = model;
      this.modelId = label || url;
      this.app.stage.addChild(model);
      this.resize();

      // 记录可用表情，供设置面板与"换表情"使用
      this.expressions = [];
      const settings = model.internalModel && model.internalModel.settings;
      if (settings && settings.expressions) {
        this.expressions = settings.expressions.map((e, i) => e.Name || e.name || `expression-${i}`);
      }

      // 记录可用动作：pixi-live2d-display 的 motionManager.definitions 形如
      //   { Idle: [{File:'idle.motion3.json', ...}, ...], TapBody: [...] }
      // 之前只把它当"随机抽一组"用，界面与模型都不知道到底有哪些动作可播。
      this.motions = [];
      try {
        const mm = model.internalModel && model.internalModel.motionManager;
        const defs = (mm && mm.definitions) || {};
        for (const [group, list] of Object.entries(defs)) {
          (list || []).forEach((d, i) => {
            // 动作名优先取 FileName，没有就从 File 路径推（去掉目录与 .motion3.json）
            const file = String((d && (d.File || d.file)) || '');
            const name = (d && (d.FileName || d.name))
              || file.split('/').pop().replace(/\.motion3\.json$/i, '')
              || `${group}-${i}`;
            this.motions.push({ group, index: i, name, file, sound: (d && (d.Sound || d.sound)) || null });
          });
        }
      } catch { /* 枚举失败不该挡住加载 —— 只是"换动作"面板会空着 */ }

      // 保险起见过一次"默认表情"，避免上一只模型的表情残留
      try { model.internalModel.motionManager.expressionManager?.resetExpression(); } catch { /* 忽略 */ }

      // 探测这只模型真实具备哪些参数（口型、呼吸、视线…），后面的待机与口型全靠它
      await this.discoverParams(url, settings);

      // 换模型后钩子要重新挂到新模型上；之前开着待机就继续保持开着
      this._idleHook = null;
      if (this.idle.wanted) this._attachIdleHook();

      // 背景与牌子是挂在舞台上的，不受换模型影响，但位置要跟着新模型重算
      this._renderScenery();
      this._layoutPlacard();

      if (this.onReadyCb) {
        this.onReadyCb({
          url,
          label: this.modelId,
          expressions: this.expressions,
          motions: this.motions,
          motionGroups: [...new Set(this.motions.map(m => m.group))],
          lipSyncParam: this.lipSyncParam,
        });
      }
      return model;
    }

    /**
     * 探测模型真实存在的参数 id。
     *
     * 为什么要费这个劲：Live2D 的参数名没有强制规范，同一个"头部左右转"在不同模型里
     * 可能是 `ParamAngleX`、`PARAM_ANGLE_X` 甚至别的写法。按官方示例的名字硬写，
     * 在其它模型上就是**静默失效** —— 不报错、不警告，只是那个效果永远不出现。
     * 所以这里读 model3.json 的 Groups 拿到口型参数，再读同目录的 cdi3.json
     * 拿到完整参数清单，之后再决定要驱动哪些参数。
     */
    async discoverParams(url, settings) {
      this.lipSyncParam = null;
      this.paramIds = new Set();
      this.p = {};

      // 1) 口型：优先信 model3.json 里声明的 LipSync 组（那是模型作者的本意）
      try {
        const groups = (settings && (settings.groups || settings.Groups)) || [];
        for (const g of groups) {
          const gname = String(g.Name || g.name || '');
          if (/lipsync/i.test(gname)) {
            const ids = (g.Ids || g.ids || []).map(String);
            if (!ids.length) continue;
            // ★ 不要盲目取 ids[0]。
            //
            // Live2D 官方示例模型（以及大量商用模型）声明的 LipSync 组是：
            //     ["ParamMouthForm", "ParamMouthOpenY"]
            // 前者是**嘴型**（嘴角弧度，笑/不笑的形状），
            // 后者才是**张嘴幅度** —— 频谱该往后者写。
            //
            // 取 ids[0] 的后果非常隐蔽：不报错、参数也确实在变、画面也在动，
            // 只是"说话时不张嘴，而是嘴角在扭"。实测本机两个国风模型
            // 都踩中了（`lipSyncParam` 被解析成 ParamMouthForm）。
            // 所以这里优先挑名字里带 MouthOpen 的那个。
            const openOne = ids.find(x => /mouthopen/i.test(x));
            this.lipSyncParam = openOne || ids[0];
          }
        }
      } catch { /* 忽略 */ }

      // 2) 完整参数清单：cdi3.json 与 model3.json 同目录、同名
      try {
        const cdiUrl = url.replace(/\.model3\.json(\?.*)?$/i, '.cdi3.json');
        if (cdiUrl !== url) {
          const resp = await fetch(cdiUrl);
          if (resp.ok) {
            const j = await resp.json();
            for (const p of (j.Parameters || [])) {
              if (p && p.Id) this.paramIds.add(String(p.Id));
            }
          }
        }
      } catch { /* 没有 cdi3.json 的模型不少见，不是错误 */ }

      // 3) 规范化映射：每种语义给出候选名，取第一个真实存在的
      const pick = (...cands) => cands.find(c => this.paramIds.size === 0 || this.paramIds.has(c)) || null;
      this.p = {
        angleX: pick('ParamAngleX', 'PARAM_ANGLE_X'),
        angleY: pick('ParamAngleY', 'PARAM_ANGLE_Y'),
        angleZ: pick('ParamAngleZ', 'PARAM_ANGLE_Z'),
        bodyAngleX: pick('ParamBodyAngleX', 'PARAM_BODY_ANGLE_X'),
        bodyAngleZ: pick('ParamBodyAngleZ', 'PARAM_BODY_ANGLE_Z'),
        eyeBallX: pick('ParamEyeBallX', 'PARAM_EYE_BALL_X'),
        eyeBallY: pick('ParamEyeBallY', 'PARAM_EYE_BALL_Y'),
        breath: pick('ParamBreath', 'PARAM_BREATH'),
        mouthOpen: this.lipSyncParam || pick('ParamMouthOpenY', 'PARAM_MOUTH_OPEN_Y', 'ParamMouthOpen', 'PARAM_MOUTH_OPEN'),
      };
      // 即便没有 cdi3.json，口型组声明的参数名也应当被信任
      if (this.lipSyncParam) this.p.mouthOpen = this.lipSyncParam;

      // 没有任何参数信息时留个可用的兜底，否则待机会整段失效
      this.paramsKnown = this.paramIds.size > 0;
      return this.p;
    }

    /**
     * 播放指定动作。
     *
     * 三种用法（②③④ 都要靠它）：
     *   playMotion()                     —— 保持旧行为：随机抽一组随机播一个
     *   playMotion('TapBody', 2)         —— 按「组 + 序号」精确播
     *   playMotion('xxx')                —— 只给组名，在该组内随机
     *
     * 旧实现只会"随机抽一组"，于是"让模型决定做什么动作"这件事根本无从实现 ——
     * 大模型说"挥挥手"，前端也没法指定播哪一个。
     */
    async playMotion(group, index) {
      if (!this.model) return false;
      try {
        const mm = this.model.internalModel.motionManager;
        const defs = (mm && mm.definitions) || {};
        const groups = Object.keys(defs);
        if (!groups.length) return false;

        let g = group;
        let idx = index;

        if (!g) {
          g = groups[Math.floor(Math.random() * groups.length)];
        } else if (!defs[g]) {
          // 组名不存在时退化到随机，而不是静默什么都不做
          g = groups[Math.floor(Math.random() * groups.length)];
        }

        const list = defs[g] || [];
        if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) {
          idx = Math.floor(Math.random() * Math.max(1, list.length));
        }

        this.lastMotion = { group: g, index: idx };
        // 第三个参数是优先级：FORCE 才能立刻打断正在播的动作，
        // 否则"点一下没反应"（因为 Idle 正在播、新动作被排队等它结束）
        const P = window.PIXI.live2d.MotionPriority;
        await this.model.motion(g, idx, P ? P.FORCE : undefined);
        return this.lastMotion;
      } catch { return false; }
    }

    /**
     * 按名字播动作（大小写不敏感，允许省略 .motion3.json）。
     * 给大模型用最顺手：它看到的是 "wave" 这种名字，不是 (组, 序号)。
     */
    async playMotionByName(name) {
      const want = String(name || '').trim().toLowerCase().replace(/\.motion3\.json$/, '');
      if (!want) return false;
      const hit = (this.motions || []).find(m => m.name.toLowerCase() === want)
        || (this.motions || []).find(m => m.name.toLowerCase().includes(want))
        || (this.motions || []).find(m => m.group.toLowerCase() === want);
      if (!hit) return false;
      return this.playMotion(hit.group, hit.index);
    }

    /** 模型自带哪些动作，供界面与大模型挑选 */
    listMotions() {
      return (this.motions || []).map(m => ({ ...m }));
    }

    /* ======================================================================
     * ③ 程序化待机
     *
     * 为什么不能只靠模型自带的 Idle 动作：Idle 是**一段定时循环的动画**，两次
     * 播放之间参数完全静止，看上去像卡住了。而从 VTS 导入的那批模型里，
     * akari 只有 1 个 Idle、hijiki 只有 1 个，间隔还很长。
     *
     * 两个实现上的硬约束（都是读打包代码确认过的）：
     *
     *   1. 只能在 `beforeModelUpdate` 钩子里写参数。放在 `afterMotionUpdate`
     *      会被紧接着的 `saveParameters()` 当成新的基准值存下来，于是每帧叠加、
     *      一路顶到参数上限（表现为模型越待机越歪，最后定住不动）。
     *   2. 必须用 `addParameterValueById`（**叠加**）而不是 `set`。库自己的
     *      `updateFocus()` 正是用叠加把"看向鼠标"写进 ParamAngleX 这些参数的，
     *      用 set 会把鼠标跟随整个抹掉。
     *
     * 代价：`physics.evaluate()` 在我们的钩子之前跑，所以衣服/头发不会跟着
     * 微摆一起甩。这是为了让上面的第 1 条成立而接受的取舍。
     * ====================================================================*/

    /** 鼠标刚动过就记一笔：视线让给鼠标，别再自己乱瞟 */
    markPointer() { this.idle.lastPointerAt = Date.now(); }

    startIdle(opts = {}) {
      const d = this.idle;
      d.wanted = true;
      d.opts = opts;
      this._attachIdleHook();
      if (d.raf) return;                       // 已经在跑，只更新配置

      d.on = true;
      d.t0 = performance.now();
      d.lastPointerAt = Date.now();
      d.nextGazeAt = performance.now();
      d.nextMotionAt = performance.now() + (opts.firstMotionMs != null ? opts.firstMotionMs : 6000);
      d.motionEveryMs = Math.max(4000, Number(opts.motionEveryMs) || 14000);
      d.sway = opts.sway !== false;
      d.saccade = opts.saccade !== false;
      d.intervalMotion = opts.intervalMotion !== false;
      d.breathFallback = opts.breathFallback !== false;

      const tick = () => {
        if (!d.on) return;
        d.raf = requestAnimationFrame(tick);
        const now = performance.now();

        // 「待机时的动作」：隔一阵自己抽一个小动作，而不是永远播同一个 Idle
        if (d.intervalMotion && now >= d.nextMotionAt) {
          d.nextMotionAt = now + d.motionEveryMs * (0.7 + Math.random() * 0.6);
          if (!d.speaking) this.playMotion('TapBody');
        }

        // 自主视线：鼠标静止 2.5 秒以上才接管，否则会和"看着你"打架。
        // 借用库自己的 model.focus() 而不是直接写眼珠参数 —— 它内部有平滑插值，
        // 而且换成鼠标时是平滑过渡过去的，不会"啪"地跳一下。
        if (d.saccade && now >= d.nextGazeAt) {
          d.nextGazeAt = now + 1800 + Math.random() * 3200;
          const pointerIdle = Date.now() - (d.lastPointerAt || 0) > 2500;
          if (pointerIdle && !d.speaking) {
            d.gazeX = (Math.random() * 2 - 1) * 0.55;
            d.gazeY = (Math.random() * 2 - 1) * 0.35;
            try { this.model && this.model.focus(d.gazeX, d.gazeY); } catch { /* 忽略 */ }
          }
        }
      };
      d.raf = requestAnimationFrame(tick);
    }

    /** 把参数驱动挂到模型的更新钩子上。换模型后必须重新挂。 */
    _attachIdleHook() {
      const im = this.model && this.model.internalModel;
      if (!im || this._idleHook) return;
      this._idleHook = () => this._idleStep();
      try { im.on('beforeModelUpdate', this._idleHook); } catch { this._idleHook = null; }
    }

    /** 每帧叠加一点微摆（和鼠标跟随共存，见上面注释第 2 条） */
    _idleStep() {
      const d = this.idle;
      const im = this.model && this.model.internalModel;
      const core = im && im.coreModel;
      if (!core) return;
      const t = (performance.now() - d.t0) / 1000;
      const add = (id, v) => {
        if (!id) return;
        try { core.addParameterValueById(id, v); } catch { /* 该模型没有该参数 */ }
      };

      if (d.sway) {
        add(this.p.angleZ, Math.sin(t * 0.55 + d.phase) * 2.6);            // 头部轻微侧倾
        add(this.p.bodyAngleZ, Math.sin(t * 0.42 + d.phase * 1.7) * 2.2);  // 重心左右微移
        add(this.p.bodyAngleX, Math.sin(t * 0.33 + d.phase) * 1.6);        // 身体前后微晃
      }

      // 呼吸兜底：库只驱动它自己创建的 breath 对象（认 ParamBreath），
      // 个别模型没配自然运动，这里补上，免得胸口完全静止
      if (d.breathFallback && this.p.breath && !im.breath) {
        add(this.p.breath, (0.5 + 0.5 * Math.sin(t * 1.5)) * 0.8);
      }
    }

    stopIdle() {
      const d = this.idle;
      d.wanted = false;
      d.on = false;
      if (d.raf) { cancelAnimationFrame(d.raf); d.raf = 0; }
      const im = this.model && this.model.internalModel;
      if (im && this._idleHook) {
        try { im.off('beforeModelUpdate', this._idleHook); } catch { /* 忽略 */ }
      }
      this._idleHook = null;
    }

    idleRunning() { return !!this.idle.on; }

    /* ======================================================================
     * ④ 导航模式：风景背景 + 手里的牌子
     * ====================================================================*/

    /**
     * 设置舞台背景风景图。
     *
     * @param {null|{kind:'procedural', spot?:string, city?:string}|{kind:'url', url:string}} src
     *
     * 三种来源（对应设置面板上的三档）：
     *   · 内置程序化 —— 现画一张，不依赖任何素材、离线可用
     *   · 自备图片   —— 用户放进 data/scenery/ 的图，走 url
     *   · 联网搜索   —— 搜到的图下载后同样走 url
     * 后两者在渲染上没区别，所以这里只分"程序化"和"给个地址"两种。
     */
    async setScenery(src) {
      if (!this.app) return false;
      this.scenery = src || null;
      this._renderScenery();
      return true;
    }

    /** 背景要垫在最底下，模型和牌子都在它上面 */
    _ensureScenerySprite() {
      if (!this.app) return null;
      if (!this._scenerySprite) {
        this._scenerySprite = new window.PIXI.Sprite(window.PIXI.Texture.EMPTY);
        this._scenerySprite.zIndex = -10;
        this.app.stage.sortableChildren = true;
        this.app.stage.addChildAt(this._scenerySprite, 0);
      }
      return this._scenerySprite;
    }

    _renderScenery() {
      const sp = this._ensureScenerySprite();
      if (!sp) return;
      const src = this.scenery;
      if (!src) { sp.visible = false; return; }
      sp.visible = true;

      const host = this.canvas.parentElement;
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));

      if (src.kind === 'url') {
        if (this._sceneryUrl !== src.url) {
          this._sceneryUrl = src.url;
          const tex = window.PIXI.Texture.from(src.url);
          sp.texture = tex;
          if (tex.baseTexture && !tex.baseTexture.valid) {
            tex.baseTexture.once('loaded', () => { try { this._coverScenery(sp, w, h); } catch { /* 忽略 */ } });
            tex.baseTexture.once('error', () => {
              // 图挂了就退回程序化背景 —— 留一块纯色比留个破图好看
              console.warn('[live2d] 风景图加载失败，退回程序化背景：', src.url);
              this.scenery = { kind: 'procedural', spot: src.spot, city: src.city };
              this._renderScenery();
            });
          }
        }
        this._coverScenery(sp, w, h);
        return;
      }
      this._sceneryUrl = null;
      this._drawProceduralScenery(sp, w, h, src);
    }

    /** 铺满容器并居中裁剪（等比放大到盖住，避免拉伸变形） */
    _coverScenery(sp, w, h) {
      const tex = sp.texture;
      if (!tex || !tex.width || !tex.height) return;
      const s = Math.max(w / tex.width, h / tex.height);
      sp.scale.set(s);
      sp.position.set((w - tex.width * s) / 2, (h - tex.height * s) / 2);
      sp.alpha = 0.9;
    }

    /**
     * 现画一张风景背景。
     *
     * 绘制本身在 nav-visuals.js（3D 舞台也要用同一份），这里只负责把画好的
     * canvas 变成 Pixi 纹理并铺满舞台。
     */
    _drawProceduralScenery(sp, w, h, src) {
      const NV = window.WenlvNavVisuals;
      if (!NV) return;
      const cv = NV.drawScenery(src && src.spot, src && src.city, w, h);

      const tex = window.PIXI.Texture.from(cv);
      if (this._sceneryTex && this._sceneryTex !== tex) { try { this._sceneryTex.destroy(true); } catch { /* 忽略 */ } }
      this._sceneryTex = tex;
      sp.texture = tex;
      sp.scale.set(1);
      sp.position.set(0, 0);
      sp.alpha = 1;
    }

    /**
     * 举牌：模型手里举一块写着字的木牌。
     *
     * 牌子是**用代码画出来的**，不是从 VTube Studio 的 Items 里拿的 ——
     * 那批道具 PNG 是第三方作者的作品（文件名里带着作者署名），
     * 拷进项目里用不合适。程序化画一块木牌则完全没有这个问题。
     */
    setPlacard(text, opts = {}) {
      if (!this.app) return false;
      this._removePlacard();
      const label = String(text || '').trim();
      if (!label) return false;

      const NV = window.WenlvNavVisuals;
      if (!NV) return false;
      const cv = NV.drawPlacard(label, opts);

      const sprite = new window.PIXI.Sprite(window.PIXI.Texture.from(cv));
      sprite.zIndex = 5;
      sprite.anchor.set(0.5, 0.26);   // 锚点落在牌面中心略偏上，缩放时牌面保持在原位
      this.app.stage.sortableChildren = true;
      this.app.stage.addChild(sprite);

      this.placard = { container: sprite, canvas: cv, text: label, w: 300, h: 170, pole: 130 };
      this._layoutPlacard();
      return true;
    }

    clearPlacard() { this._removePlacard(); }

    /**
     * 牌子的摆放：贴在模型头部的斜上方偏右。
     *
     * 位置跟着模型的**实际渲染范围**走，而不是写死屏幕比例 —— 不同形象
     * 有的高有的矮、有的宽有的窄，写死的话不是挡住脸就是飘到画外去。
     */
    _layoutPlacard() {
      if (!this.placard || !this.app) return;
      const host = this.canvas.parentElement;
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));

      let mw = w * 0.4;
      let mh = h * 0.8;
      let cx = w / 2;
      let topY = h * 0.1;
      try {
        const b = this.model.getBounds();
        if (b && b.width) { mw = b.width; mh = b.height; cx = b.x + b.width / 2; topY = b.y; }
      } catch { /* 取不到就用兜底值 */ }

      const sp = this.placard.container;
      // 牌面宽度取模型宽度的 0.7 倍，并限制在合理区间，避免小模型扛大牌
      const targetW = Math.max(130, Math.min(w * 0.4, mw * 0.7));
      sp.scale.set(targetW / this.placard.w);
      // 放在头部右侧偏上，略微倾斜，像被举着
      sp.position.set(cx + mw * 0.44, topY + mh * 0.14);
      sp.rotation = 0.07;
    }

    _removePlacard() {
      if (this.placard && this.app) {
        try {
          this.app.stage.removeChild(this.placard.container);
          // 连纹理一起销毁：牌子是每次现画的 canvas，不销毁就是每次开导航泄一张纹理
          this.placard.container.destroy({ children: true, texture: true, baseTexture: true });
        } catch { /* 忽略 */ }
      }
      this.placard = null;
    }

    /** 按容器尺寸把模型摆正：底部对齐、水平居中，再叠加用户的手动缩放/位移 */
    resize() {
      if (!this.app) return;
      const host = this.canvas.parentElement;
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));

      // 浏览器缩放（Ctrl + 滚轮 / Ctrl 加号）会改 devicePixelRatio。
      // 不跟着更新 resolution 的话，画布后备区还是老分辨率，放大后整只就发虚。
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.lastDpr = dpr;
      if (this.app.renderer.resolution !== dpr) this.app.renderer.resolution = dpr;

      this.app.renderer.resize(w, h);
      if (this.app.stage.hitArea) this.app.stage.hitArea = new window.PIXI.Rectangle(0, 0, w, h);

      // 背景与牌子要在"没有模型"时也能摆好，所以放在 model 检查之前
      if (this.scenery) this._renderScenery();
      this._layoutPlacard();

      if (!this.model) return;

      this.baseScale = this.fitScale(w, h);
      this.applyTransform();
    }

    /**
     * 算出"把模型塞进容器"该用的缩放：高度占容器约 86%，宽度不超过约 92%。
     *
     * 这里必须用**未被缩放**的模型尺寸，不能用 `model.width/height` ——
     * 在 pixi-live2d-display 里它们已经把当前 scale 乘进去了，
     * 拿它们算会变成自引用：新 scale = K / 旧 scale（K 才是期望值）。
     * 后果就是每 resize 一次漂一次，窗口拉大拉小几个来回之后，
     * 角色要么胀满整屏、要么缩成一小点 —— 也就是"界面放大后角色位置和大小不对劲"。
     * `getLocalBounds()` 与 `internalModel.width/height` 都是与 scale 无关的，用它们。
     */
    fitScale(w, h) {
      const m = this.model;
      let mw = 0;
      let mh = 0;
      try {
        const lb = m.getLocalBounds();
        mw = lb.width;
        mh = lb.height;
      } catch { /* 个别模型取不到就退回下面的兜底 */ }
      if (!mw || !mh) {
        const im = m.internalModel;
        mw = (im && im.width) || 0;
        mh = (im && im.height) || 0;
      }
      if (!mw || !mh) return this.baseScale || 1;
      return Math.min((h * 0.86) / mh, (w * 0.92) / mw);
    }

    applyTransform() {
      if (!this.model) return;
      const host = this.canvas.parentElement;
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const h = Math.max(1, Math.round(rect.height));
      const s = this.baseScale * this.userScale;
      this.model.scale.set(s);
      this.model.anchor.set(0.5, 1);           // 以"脚底中心"为锚点
      this.model.position.set(
        w / 2 + (this.userX / 100) * w * 0.5,
        h * 0.99 + (this.userY / 100) * h * 0.5,
      );
    }

    setScale(v) { this.userScale = Math.max(0.2, Math.min(3, v)); this.applyTransform(); }
    setPosition(x, y) { this.userX = x; this.userY = y; this.applyTransform(); }

    /** 表情：优先按名称，失败则按序号 */
    async setExpression(name) {
      if (!this.model) return false;
      const em = this.model.internalModel.motionManager.expressionManager;
      if (!em || !em.definitions) return false;
      const idx = em.definitions.findIndex(d => (d.Name || d.name) === name);
      if (idx < 0) return false;
      try { await this.model.expression(idx); return true; } catch { return false; }
    }

    /** 每帧：把目标嘴型平滑逼近（避免音量抖动导致嘴抽搐） */
    loop() {
      const step = () => {
        this.rafId = requestAnimationFrame(step);

        // 浏览器缩放会改 devicePixelRatio。window.resize 在个别路径上不一定来
        // （比如换到另一块不同 DPI 的显示器），每帧比一次最省心，成本就是一次比较。
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        if (dpr !== this.lastDpr) this.scheduleResize();

        if (this.analyser) {
          const buf = new Uint8Array(this.analyser.frequencyBinCount);
          this.analyser.getByteFrequencyData(buf);
          // 只取人声主要能量区间，低频噪声别去带嘴
          let sum = 0;
          const from = 2;
          const to = Math.min(buf.length, 48);
          for (let i = from; i < to; i++) sum += buf[i];
          const avg = sum / ((to - from) * 255);
          this.targetMouthOpen = Math.min(1, avg * 2.4);
        } else if (this.talking) {
          // ---- 文本驱动的"假口型"（没有音频时的退路）----
          //
          // 为什么需要它：字幕是一边生成一边往屏幕上吐的，而 TTS 要等整段文字
          // 生成完才开始合成（几秒到几十秒）。这段时间里如果嘴不动，
          // 看起来就是"它在念稿但没张嘴"。
          //
          // 节奏跟着字幕走：约 180ms 一个字，标点与空白闭嘴，
          // 其余按字符码给一个有起伏的开口量（不是随机张嘴，同一个字每次一样）。
          // 真音频一旦就绪，speak() 会把 analyser 接上，上面那个分支自动接管。
          const now = performance.now();
          const dt = this.lastTick ? Math.min(0.1, (now - this.lastTick) / 1000) : 0;
          this.lastTick = now;
          this.talkAcc += dt;

          const CH_SECONDS = 0.18;
          const len = this.talkText.length;
          // ★ 别让"攒下的时间"一次烧完。
          //
          // 文本是**流式**来的：两段字幕之间可能隔几百毫秒，这段时间里
          // talkAcc 一直在涨。等到新字进来，`while` 会一口气把它们全"读完"
          // —— 表现就是"新的一段到了，嘴反而不动"（实测翻车的就是这里）。
          // 把额度封顶到一个字的量，嘴就始终跟着最近到的字走。
          if (this.talkAcc > CH_SECONDS) this.talkAcc = CH_SECONDS;
          // 读到头了就停在末尾（保持闭嘴）—— 等 feedTalking 送来更多字再继续
          while (this.talkAcc >= CH_SECONDS && this.talkIndex < len) {
            this.talkAcc -= CH_SECONDS;
            this.talkIndex++;
          }
          const ch = this.talkIndex < len ? this.talkText[this.talkIndex] : '';
          if (!ch || /[\s。，、！？；：…—,\.!\?;:"'（）()《》「」【】]/.test(ch)) {
            this.targetMouthOpen = 0;
          } else {
            const h = ch.charCodeAt(0);
            this.targetMouthOpen = 0.25 + ((h * 37) % 60) / 100;   // 0.25 ~ 0.85
          }
        } else {
          this.lastTick = 0;
          this.targetMouthOpen = 0;
        }
        this.mouthOpen += (this.targetMouthOpen - this.mouthOpen) * 0.35;
        // 用探测到的参数名，而不是写死的 ParamMouthOpenY（原因见 discoverParams 注释）
        const mouthParam = this.p && this.p.mouthOpen;
        try {
          const core = this.model && this.model.internalModel && this.model.internalModel.coreModel;
          if (core && mouthParam) {
            core.setParameterValueById(mouthParam, this.mouthOpen > 0.001 ? this.mouthOpen : 0);
          }
        } catch { /* 该模型没有该参数就跳过 */ }
      };
      step();
    }

    /**
     * 文本驱动口型：开始/追加说话内容（**不播放音频**）。
     *
     * 谁会调它：外壳在把回复**流式打印到字幕**的时候。这条路径上没有音频 ——
     * TTS 是等整段文字生成完才合成的。所以这段时间用文本驱动嘴型，
     * 等真的开始放音频，`speak()` 接上分析器后会自然接管（见 tick 里的分支顺序）。
     *
     * 传整段也行（幂等：内容一样就不重来），传增量也行 —— 内部就记一个下标，
     * 按约 180ms 一个字往前推。
     */
    talkTo(text) {
      const s = String(text == null ? '' : text);
      if (!s) { this.stopTalking(); return; }
      // 内容变了但前面没变（流式追加）→ 只把尾巴接上，不要从头重念
      if (!this.talking || !s.startsWith(this.talkText.slice(0, this.talkIndex))) {
        this.talkIndex = 0;
        this.talkAcc = 0;
      }
      this.talkText = s;
      if (this.talkIndex > s.length) this.talkIndex = s.length;
      this.talking = true;
      // 说话期间不插入待机小动作、也不自主瞟视（和 speak() 同样的理由：
      // 否则嘴在动、身体却在换姿势，看着别扭）
      if (this.idle) this.idle.speaking = true;
    }

    /** 停止文本驱动口型（字幕吐完了 / 要开始放真音频了） */
    stopTalking() {
      this.talking = false;
      this.talkText = '';
      this.talkIndex = 0;
      this.talkAcc = 0;
      if (this.idle) this.idle.speaking = false;
    }

    /**
     * 播放音频并同步嘴型。
     * 用 WebAudio 的 AnalyserNode 取实时音量，而不是假装"随机张嘴"——
     * 这样嘴型和声音是真的对上的。
     */
    async speak(url, audioEl) {
      if (!url) return;
      if (!this.audioCtx) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      }
      if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();

      audioEl.src = url;
      audioEl.crossOrigin = 'anonymous';
      // 说话期间不插入待机小动作，也不做自主瞟视 —— 否则嘴在动、身体却在抽冷子换姿势
      this.idle.speaking = true;

      try {
        if (this.audioSource) { try { this.audioSource.disconnect(); } catch { /* 忽略 */ } }
        this.audioSource = this.audioCtx.createMediaElementSource(audioEl);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.7;
        this.audioSource.connect(this.analyser);
        this.analyser.connect(this.audioCtx.destination);
      } catch (e) {
        // 同一个 <audio> 只能被 createMediaElementSource 绑定一次；
        // 重复绑定时退化为"不驱动嘴型但正常出声"，不让整条链路挂掉
        console.warn('[live2d] 音频分析绑定失败，嘴型同步关闭：', e.message);
        this.analyser = null;
      }

      await new Promise((resolve, reject) => {
        const onEnd = () => { cleanup(); this.targetMouthOpen = 0; this.idle.speaking = false; resolve(); };
        const onErr = (e) => { cleanup(); this.idle.speaking = false; reject(e); };
        const cleanup = () => {
          audioEl.removeEventListener('ended', onEnd);
          audioEl.removeEventListener('error', onErr);
        };
        audioEl.addEventListener('ended', onEnd);
        audioEl.addEventListener('error', onErr);
        audioEl.play().catch(onErr);
      });
    }

    stopSpeaking(audioEl) {
      try { audioEl.pause(); } catch { /* 忽略 */ }
      this.targetMouthOpen = 0;
      this.mouthOpen = 0;
      this.idle.speaking = false;
    }

    destroy() {
      this.stopIdle();
      this._removePlacard();
      if (this._sceneryTex) { try { this._sceneryTex.destroy(true); } catch { /* 忽略 */ } }
      this._sceneryTex = null;
      this._scenerySprite = null;
      if (this.rafId) cancelAnimationFrame(this.rafId);
      if (this.resizeRaf) cancelAnimationFrame(this.resizeRaf);
      if (this.ro) { try { this.ro.disconnect(); } catch { /* 忽略 */ } }
      if (this.model) { try { this.model.destroy(); } catch { /* 忽略 */ } }
      if (this.app) { try { this.app.destroy(false, { children: true }); } catch { /* 忽略 */ } }
      this.ready = false;
    }
  }

  window.Live2DStage = Live2DStage;
})();
