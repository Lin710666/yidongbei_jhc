/* ============================================================================
 * lake.js —— 西湖主题：动态风景 + 「西湖船娘」虚拟形象
 *
 * ## 为什么是"画"出来的，而不是找一个西湖主题的 Live2D/VRM 模型
 *
 * 直接用现成的西湖主题角色模型最省事，但有两个绕不过去的问题：
 *
 *   1. **授权。** 能搜到的国风角色模型绝大多数是画师/建模师的作品，
 *      明确禁止商用或未标明授权。本项目是要拿去做对外宣传的，
 *      用一个授权不明的角色站台，风险远大于省下的美术成本。
 *   2. **拿不到。** 本机能访问的镜像里没有西湖主题的角色模型；
 *      VRoid Hub 这类站点需要登录，Wikimedia 那条路在这台机器上直接不通。
 *
 * 所以这里选择**用代码画一个**：原创的「西湖船娘」——汉服、发髻簪花、执油纸伞，
 * 配色取自西湖的青绿山水。好处是零授权风险、零外部素材、任意分辨率都不糊
 * （矢量绘制，不是位图缩放），并且能跟着参数做呼吸、眨眼、口型与动作。
 *
 * ## 它和另外两套舞台的关系
 *
 * 本项目原有 Live2D 与 3D 两套渲染器，各自实现同一组方法
 * （init/load/setExpression/playMotion/speak/resize/destroy…），
 * app.js 通过 activeStage() 盲调。本文件是**第三套**，接口完全对齐，
 * 所以它能像另外两套一样被选中、设置缩放位置、举牌、被大模型指挥做动作。
 *
 * 如果用户自己有西湖主题的 Live2D 或 VRM 模型，走原有的「更换形象 / 上传模型」
 * 换过去即可 —— 这套只是**默认**形象，不是唯一选择。
 * ==========================================================================*/
(function () {
  'use strict';

  /**
   * 江南古风配色：青花 + 月白 + 烟青，取江南水乡的那种"淡"。
   *
   * 为什么不是大红色：一提"古风"很容易往喜庆的红金上走，但那更像节庆或宫廷。
   * 江南的词是"烟雨"、是"青花瓷"、是"月白"，所以主色是低饱和的青与白，
   * 只留极少的暖色（皮肤、唇、簪花）提神。
   */
  const C = {
    // —— 风景 ——
    skyTop: '#1d3a4d', skyMid: '#3f6f86', skyLow: '#9fc4cf',
    farHill: '#5b7f8e', midHill: '#42606d', nearHill: '#2c4450',
    water: '#20404d', waterLight: '#7fb3bd',
    // —— 上襦：月白到浅青 ——
    robeHi: '#f2f7fa', robeMid: '#dbe8ee', lining: '#fbfdfe',
    // —— 长裙：烟青／水绿（保留旧键名，风景与牌子还在用）——
    skirtTop: '#5c9d95', skirtMid: '#3f7d78', skirtDeep: '#26565a',
    robe: '#3f7d78', robeDeep: '#26565a', robeLight: '#5c9d95',
    // —— 衣缘：青花蓝 ——
    trim: '#35618f', trimDeep: '#23456a',
    // —— 披帛：藕荷偏青的薄纱 ——
    shawl: '#a8ccd6', shawlHi: '#e0eef2',
    jade: '#7fc8a9',
    // —— 人物 ——
    skin: '#f8e2d0', skinShade: '#e8c4a9',
    hair: '#1b1e26', hairHi: '#39415a',
    lip: '#c9645f', blush: 'rgba(216,124,116,0.28)',
    flower: '#d2555f', pearl: '#f4f1ea',
    // —— 道具 ——
    umbrella: '#e8eef2', umbrellaRib: '#35618f',
    paper: '#f4efe4', ink: '#26313a',
  };

  /** 人物的逻辑高度（脚底 0 → 发髻顶）。用来反算缩放，见 LakeAvatar.resize() */
  const FIGURE_H = 345;

  /** 缓动 */
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ==========================================================================
   * 一、西湖风景（动态）
   *
   * 两类用途：
   *   · 没有视频素材时的内置兜底背景（"内置程序化"档）
   *   · 导航模式下按景点切换的风景（与 nav-visuals.js 那套并存，这里是西湖专用）
   *
   * 画的是西湖的**意象**而不是写实：远山三层、雷峰塔剪影、断桥、柳枝、
   * 水面波光、薄雾。用名字做种子，所以"西湖"每次都一样、换个名字就换一套天色。
   * ========================================================================*/

  function seedOf(str) {
    let s = 0;
    const t = String(str || '西湖');
    for (let i = 0; i < t.length; i++) s = (s * 31 + t.charCodeAt(i)) >>> 0;
    return s;
  }
  function makeRnd(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  /**
   * 画一帧西湖风景。
   * @param {CanvasRenderingContext2D} g
   * @param {number} w @param {number} h
   * @param {number} t 秒（驱动水面波光与柳枝）
   * @param {string} key 景点名（做种子）
   */
  function drawLakeScene(g, w, h, t, key) {
    const seed = seedOf(key);
    const rnd = makeRnd(seed);
    const horizon = h * 0.62;

    // ---- 天空：黄昏偏青的西湖暮色 ----
    const sky = g.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, C.skyTop);
    sky.addColorStop(0.55, C.skyMid);
    sky.addColorStop(1, C.skyLow);
    g.fillStyle = sky;
    g.fillRect(0, 0, w, horizon + 2);

    // 落日光晕
    const sunX = w * (0.62 + rnd() * 0.2);
    const sunY = horizon - h * (0.06 + rnd() * 0.06);
    const halo = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, h * 0.42);
    halo.addColorStop(0, 'rgba(255,232,190,0.75)');
    halo.addColorStop(0.3, 'rgba(255,205,150,0.22)');
    halo.addColorStop(1, 'rgba(255,200,140,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, w, horizon + 2);
    g.beginPath();
    g.arc(sunX, sunY, h * 0.032, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,246,220,0.9)';
    g.fill();

    // ---- 远山三层 ----
    const layers = [
      { base: horizon - h * 0.13, amp: h * 0.075, color: C.farHill, alpha: 0.55, peaks: 5 },
      { base: horizon - h * 0.075, amp: h * 0.05, color: C.midHill, alpha: 0.75, peaks: 7 },
      { base: horizon - h * 0.03, amp: h * 0.03, color: C.nearHill, alpha: 0.92, peaks: 9 },
    ];
    for (let li = 0; li < layers.length; li++) {
      const L = layers[li];
      g.beginPath();
      g.moveTo(0, horizon);
      g.lineTo(0, L.base);
      for (let i = 0; i <= L.peaks; i++) {
        const x = (w / L.peaks) * i;
        const y = L.base - Math.abs(Math.sin(i * 1.9 + li * 2.7 + seed * 0.0007)) * L.amp;
        g.lineTo(x, y);
      }
      g.lineTo(w, horizon);
      g.closePath();
      g.globalAlpha = L.alpha;
      g.fillStyle = L.color;
      g.fill();
      g.globalAlpha = 1;
    }

    // ---- 雷峰塔剪影（在第二层山脊上）----
    const towerX = w * 0.19;
    const towerBase = horizon - h * 0.085;
    g.fillStyle = 'rgba(28,44,54,0.85)';
    const tw = h * 0.019;
    for (let i = 0; i < 5; i++) {
      const lvlW = tw * (1 - i * 0.13);
      const lvlH = h * 0.017;
      const y = towerBase - (i + 1) * lvlH;
      g.fillRect(towerX - lvlW / 2, y, lvlW, lvlH * 0.72);
      // 塔檐
      g.fillRect(towerX - lvlW / 2 - tw * 0.11, y + lvlH * 0.5, lvlW + tw * 0.22, lvlH * 0.16);
    }
    // 塔尖
    g.beginPath();
    g.moveTo(towerX, towerBase - 5 * h * 0.017 - h * 0.016);
    g.lineTo(towerX - tw * 0.13, towerBase - 5 * h * 0.017);
    g.lineTo(towerX + tw * 0.13, towerBase - 5 * h * 0.017);
    g.closePath();
    g.fill();

    // ---- 水面 ----
    const water = g.createLinearGradient(0, horizon, 0, h);
    water.addColorStop(0, C.water);
    water.addColorStop(1, '#101f27');
    g.fillStyle = water;
    g.fillRect(0, horizon, w, h - horizon);

    // 水面波光：横向细线，位置随时间缓慢流动
    const rows = 30;
    for (let i = 0; i < rows; i++) {
      const p = i / rows;
      const y = horizon + (h - horizon) * p;
      const phase = Math.sin(t * 0.7 + i * 0.55) * 0.5 + 0.5;
      const rw = w * (0.05 + phase * 0.32 + p * 0.18);
      g.fillStyle = `rgba(190,225,230,${(0.14 - p * 0.10) * (0.5 + phase * 0.5)})`;
      g.fillRect(sunX - rw / 2, y, rw, Math.max(1, h * 0.0022));
    }
    // 山影倒映
    g.globalAlpha = 0.16;
    g.fillStyle = C.nearHill;
    g.fillRect(0, horizon, w, h * 0.03);
    g.globalAlpha = 1;

    // ---- 断桥（右侧，带拱洞）----
    const bx = w * 0.74;
    const by = horizon + h * 0.012;
    const bw = w * 0.24;
    g.fillStyle = 'rgba(226,232,230,0.72)';
    g.beginPath();
    g.moveTo(bx, by);
    g.quadraticCurveTo(bx + bw * 0.5, by - h * 0.035, bx + bw, by);
    g.lineTo(bx + bw, by + h * 0.014) ;
    g.quadraticCurveTo(bx + bw * 0.5, by - h * 0.019, bx, by + h * 0.014);
    g.closePath();
    g.fill();
    // 桥拱洞
    g.fillStyle = 'rgba(16,31,39,0.75)';
    g.beginPath();
    g.ellipse(bx + bw * 0.5, by + h * 0.008, bw * 0.10, h * 0.017, 0, Math.PI, 0);
    g.fill();

    // ---- 柳枝（左上垂下，随风摆）----
    const sway = Math.sin(t * 0.9) * h * 0.006;
    g.strokeStyle = 'rgba(120,160,120,0.85)';
    g.lineWidth = Math.max(1, h * 0.0022);
    for (let i = 0; i < 7; i++) {
      const x0 = w * (0.02 + i * 0.035);
      const len = h * (0.18 + (i % 3) * 0.07);
      g.beginPath();
      g.moveTo(x0, -h * 0.01);
      g.quadraticCurveTo(x0 + sway * (1 + i * 0.15), len * 0.6, x0 + sway * 2.2, len);
      g.stroke();
    }
    // 柳叶
    g.fillStyle = 'rgba(150,190,140,0.8)';
    for (let i = 0; i < 16; i++) {
      const x0 = w * (0.02 + (i % 7) * 0.035) + sway * 1.6;
      const y0 = h * (0.05 + (i % 5) * 0.045);
      g.beginPath();
      g.ellipse(x0, y0, h * 0.004, h * 0.012, sway * 0.06, 0, Math.PI * 2);
      g.fill();
    }

    // ---- 薄雾：让远山与水面的交界柔和一些 ----
    const mist = g.createLinearGradient(0, horizon - h * 0.09, 0, horizon + h * 0.05);
    mist.addColorStop(0, 'rgba(200,222,226,0)');
    mist.addColorStop(0.5, 'rgba(200,222,226,0.20)');
    mist.addColorStop(1, 'rgba(200,222,226,0)');
    g.fillStyle = mist;
    g.fillRect(0, horizon - h * 0.09, w, h * 0.14);

    // ---- 暗角：人物与文字都要压在它上面才读得清 ----
    const vig = g.createRadialGradient(w / 2, h * 0.5, Math.min(w, h) * 0.28, w / 2, h * 0.5, Math.max(w, h) * 0.76);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.52)');
    g.fillStyle = vig;
    g.fillRect(0, 0, w, h);
  }

  /* ==========================================================================
   * 二、西湖船娘形象
   *
   * 参数化绘制：所有姿态都由一组参数决定，动作就是"在一段时间内把参数推到目标值"。
   * 这样加动作不用加绘制代码，也能让口型/视线/呼吸各自独立地叠加。
   * ========================================================================*/

  const DEFAULT_POSE = {
    breath: 0,        // -1..1 呼吸相位
    bodySway: 0,      // 身体左右微摆（度）
    headTilt: 0,      // 头部侧倾（度）
    headNod: 0,       // 点头（度）
    eyeOpen: 1,       // 0..1
    eyeX: 0, eyeY: 0, // 视线偏移 -1..1
    mouthOpen: 0,     // 0..1
    armL: 0, armR: 0, // 手臂抬起角度（度）
    umbrella: 0,      // 伞的旋转（度）
    blush: 0,         // 0..1
    turn: 0,          // 转身（-1..1），用于"回眸"
  };

  class LakeAvatar {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.modelId = '西湖船娘';
      this.ready = false;
      this.w = 0; this.h = 0; this.dpr = 1;
      this.pose = { ...DEFAULT_POSE };
      this.target = { ...DEFAULT_POSE };
      this._motion = null;
      this._raf = 0;
      this._t0 = performance.now();
      this.userScale = 1; this.userX = 0; this.userY = 0;
      this.onReadyCb = null;
      this.onErrorCb = null;
      this.onTapCb = null;
      this.analyser = null; this.audioCtx = null; this.audioSource = null;
      this.audioEl = null;
      this.idle = { on: false, wanted: false, phase: Math.random() * 6.28, nextGaze: 0, gazeX: 0, gazeY: 0, lastPointerAt: Date.now(), speaking: false, nextMotionAt: 0, motionEveryMs: 14000 };
      this.placard = null;
      this.scenery = null;
      this.expressions = ['平静', '微笑', '凝望', '欣喜'];
      this._expr = '平静';
      this.motions = [
        { group: 'Greet', index: 0, name: '招手', file: '', sound: null },
        { group: 'Greet', index: 1, name: '作揖', file: '', sound: null },
        { group: 'Body', index: 2, name: '点头', file: '', sound: null },
        { group: 'Body', index: 3, name: '回眸', file: '', sound: null },
        { group: 'Prop', index: 4, name: '撑伞', file: '', sound: null },
        { group: 'Prop', index: 5, name: '摇橹', file: '', sound: null },
      ];
    }

    static runtimeAvailable() { return null; }   // 纯 canvas，没有任何外部运行时依赖

    async init() {
      this._observe();
      this._bindPointer();
      this._loop();
      this.ready = true;
    }

    _observe() {
      const host = this.canvas.parentElement;
      if (typeof window.ResizeObserver === 'function' && host) {
        this._ro = new window.ResizeObserver(() => this.resize());
        this._ro.observe(host);
      }
      window.addEventListener('resize', () => this.resize());
    }

    _bindPointer() {
      const host = this.canvas.parentElement;
      if (!host) return;
      host.addEventListener('mousemove', (e) => {
        this.markPointer();
        const r = host.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 2 - 1;
        const y = ((e.clientY - r.top) / r.height) * 2 - 1;
        this.target.eyeX = clamp(x, -1, 1) * 0.6;
        this.target.eyeY = clamp(y, -1, 1) * 0.4;
        this.target.headTilt = clamp(x, -1, 1) * 5;
      });
      host.addEventListener('mouseleave', () => {
        this.target.eyeX = 0; this.target.eyeY = 0; this.target.headTilt = 0;
      });
      // 点人物：和另外两套舞台一样，交给上层做互动
      this.canvas.addEventListener('pointerdown', () => { if (this.onTapCb) this.onTapCb(); });
    }

    async load(url, { label } = {}) {
      if (!this.ready) await this.init();
      if (label) this.modelId = label;
      this.resize();
      if (this.onReadyCb) {
        this.onReadyCb({
          url: url || 'builtin:lake-boatwoman',
          label: this.modelId,
          expressions: this.expressions,
          motions: this.motions.map(m => ({ ...m })),
          motionGroups: [...new Set(this.motions.map(m => m.group))],
          lipSyncParam: 'procedural:mouthOpen',
        });
      }
      return this;
    }

    /** 这个形象是内置的，不需要外部文件；给出一份能力说明供界面显示 */
    describe() {
      return {
        id: 'builtin-lake-boatwoman',
        label: '西湖船娘',
        note: '程序化绘制的原创形象：汉服、发髻簪花、执油纸伞，配色取自西湖青绿山水。'
          + '不依赖任何外部模型文件，因此没有第三方素材授权问题；任意分辨率都不会糊。'
          + '如果你有西湖主题的 Live2D / VRM 模型，可在「外观 → 更换形象」里换成自己的。',
        tags: ['内置', '西湖主题', '原创程序化'],
      };
    }

    /* ---------------- 尺寸与位置 ---------------- */

    resize() {
      const host = this.canvas.parentElement;
      if (!host) return;
      const r = host.getBoundingClientRect();
      this.w = Math.max(1, Math.floor(r.width));
      this.h = Math.max(1, Math.floor(r.height));
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvas.width = Math.floor(this.w * this.dpr);
      this.canvas.height = Math.floor(this.h * this.dpr);
      this.canvas.style.width = `${this.w}px`;
      this.canvas.style.height = `${this.h}px`;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      // 大屏上人物要够大才撑得住场；小屏则不能顶到边框。
      //
      // 按**人物逻辑高度**去反算缩放，而不是拍一个系数：
      // 人物从脚底(0)到发髻顶大约 345 个逻辑单位，让它占舞台高度的 84%。
      // 这样无论 874×708 的小窗还是 3840×2160 的大屏，人物在画面里的占比都一样
      // （拍系数的话，换个窗口尺寸就会一会儿太小一会儿顶天）。
      this._scale = clamp((this.h * 0.84) / FIGURE_H, 0.4, 6);
    }

    setScale(v) { this.userScale = clamp(Number(v) || 1, 0.3, 3); }
    setPosition(x, y) { this.userX = Number(x) || 0; this.userY = Number(y) || 0; }

    /* ---------------- 表情 ---------------- */

    async setExpression(name) {
      const n = String(name || '').trim();
      if (!this.expressions.includes(n)) return false;
      this._expr = n;
      return true;
    }
    expressionNames() { return this.expressions.slice(); }

    /* ---------------- 动作 ---------------- */

    listMotions() { return this.motions.map(m => ({ ...m })); }

    /**
     * 播放一个动作。
     * 动作 = 一组"关键帧参数 + 时长"，由 _loop 按进度插值推过去。
     * 与另外两套舞台的差别：这里没有外部动画文件，姿态全是算出来的。
     */
    async playMotion(group, index) {
      let m = null;
      if (typeof group === 'string' && !Number.isInteger(index)) {
        m = this.motions.find(x => x.name === group)
          || this.motions.find(x => x.group.toLowerCase() === group.toLowerCase() && (!Number.isInteger(index) || x.index === index))
          || this.motions.find(x => x.name.includes(group));
      }
      if (!m) {
        if (Number.isInteger(index)) m = this.motions.find(x => x.index === index);
        else if (Number.isInteger(group)) m = this.motions.find(x => x.index === group);
      }
      if (!m) m = this.motions[Math.floor(Math.random() * this.motions.length)];
      if (!m) return false;

      this._motion = { name: m.name, startedAt: performance.now(), dur: MOTION_DUR[m.name] || 1600 };
      return { group: m.group, index: m.index, name: m.name };
    }

    async playMotionByName(name) { return this.playMotion(String(name || '').trim()); }

    /* ---------------- 说话与口型 ---------------- */

    async speak(url, audioEl) {
      if (!url) return;
      if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
      audioEl.src = url;
      audioEl.crossOrigin = 'anonymous';
      this.idle.speaking = true;
      try {
        if (this.audioSource) { try { this.audioSource.disconnect(); } catch { /* 忽略 */ } }
        this.audioSource = this.audioCtx.createMediaElementSource(audioEl);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 256;
        this.analyser.smoothingTimeConstant = 0.7;
        this.audioSource.connect(this.analyser);
        this.analyser.connect(this.audioCtx.destination);
      } catch {
        this.analyser = null;   // 同一个 audio 元素只能绑一次，退化为止出声不动嘴
      }
      await new Promise((resolve, reject) => {
        const done = () => { cleanup(); this.target.mouthOpen = 0; this.idle.speaking = false; resolve(); };
        const err = (e) => { cleanup(); this.idle.speaking = false; reject(e); };
        const cleanup = () => {
          audioEl.removeEventListener('ended', done);
          audioEl.removeEventListener('error', err);
        };
        audioEl.addEventListener('ended', done);
        audioEl.addEventListener('error', err);
        audioEl.play().catch(err);
      });
    }

    stopSpeaking(audioEl) {
      try { audioEl.pause(); } catch { /* 忽略 */ }
      this.target.mouthOpen = 0;
      this.idle.speaking = false;
    }

    /* ---------------- 待机 ---------------- */

    markPointer() { this.idle.lastPointerAt = Date.now(); }

    startIdle(opts = {}) {
      this.idle.on = true;
      this.idle.wanted = true;
      this.idle.motionEveryMs = Math.max(4000, Number(opts.motionEveryMs) || 14000);
      this.idle.nextMotionAt = performance.now() + (opts.firstMotionMs != null ? opts.firstMotionMs : 7000);
    }
    stopIdle() { this.idle.on = false; this.idle.wanted = false; }
    idleRunning() { return !!this.idle.on; }

    /* ---------------- 举牌与风景 ---------------- */

    setPlacard(text) {
      const label = String(text || '').trim();
      this.placard = label ? { text: label } : null;
      return !!label;
    }
    clearPlacard() { this.placard = null; }

    async setScenery(src) { this.scenery = src || null; return true; }

    /* ---------------- 主循环 ---------------- */

    _loop() {
      const step = () => {
        this._raf = requestAnimationFrame(step);
        const now = performance.now();
        const t = (now - this._t0) / 1000;

        this._applyMotion(now, t);
        this._applyIdle(now, t);
        this._applyLipSync();

        // 平滑逼近目标姿态（避免参数跳变）
        for (const k of Object.keys(this.pose)) {
          const cur = this.pose[k];
          const tg = this.target[k];
          this.pose[k] = Math.abs(tg - cur) < 0.0005 ? tg : lerp(cur, tg, 0.16);
        }
        this._draw(t);
      };
      step();
    }

    _applyMotion(now, t) {
      const m = this._motion;
      if (!m) return;
      const p = clamp((now - m.startedAt) / m.dur, 0, 1);
      const e = easeInOut(p);
      const T = this.target;
      switch (m.name) {
        case '招手':      // 右手抬起挥两下
          T.armR = 62 * Math.sin(Math.PI * p) + Math.sin(p * Math.PI * 4) * 14 * (1 - p);
          T.headTilt = -4 * Math.sin(Math.PI * p);
          break;
        case '作揖':      // 双手前抬 + 低头
          T.armL = 46 * Math.sin(Math.PI * p);
          T.armR = 46 * Math.sin(Math.PI * p);
          T.headNod = 16 * Math.sin(Math.PI * p);
          break;
        case '点头':
          T.headNod = 13 * Math.sin(Math.PI * p) * (0.6 + 0.4 * Math.sin(p * Math.PI * 3));
          break;
        case '回眸':      // 转身 + 侧头
          T.turn = -0.8 * Math.sin(Math.PI * p);
          T.headTilt = -12 * Math.sin(Math.PI * p);
          T.eyeX = -0.5 * Math.sin(Math.PI * p);
          break;
        case '撑伞':      // 把伞转正并抬高
          T.umbrella = -18 * Math.sin(Math.PI * p);
          T.armR = 30 * Math.sin(Math.PI * p);
          break;
        case '摇橹':      // 双臂前后摆（划船）
          T.armL = 26 * Math.sin(p * Math.PI * 2);
          T.armR = -26 * Math.sin(p * Math.PI * 2);
          T.bodySway = 5 * Math.sin(p * Math.PI * 2);
          break;
        default:
          void e;
      }
      if (p >= 1) {
        // 动作结束：把该动作碰过的参数交回待机/鼠标控制
        this._motion = null;
        T.armL = 0; T.armR = 0; T.headNod = 0; T.umbrella = 0; T.turn = 0;
      }
    }

    _applyIdle(now, t) {
      if (!this.idle.on) return;
      const d = this.idle;
      // 呼吸：一直有，且不依赖模型自带的 Idle 动作
      this.target.breath = Math.sin(t * 1.35 + d.phase);
      // 微摆
      if (!this._motion) this.target.bodySway = Math.sin(t * 0.5 + d.phase) * 2.4;

      // 自主视线：鼠标闲下来才自己瞟
      if (now >= d.nextGaze) {
        d.nextGaze = now + 1800 + Math.random() * 3200;
        const pointerIdle = Date.now() - d.lastPointerAt > 2500;
        if (pointerIdle && !d.speaking) {
          d.gazeX = (Math.random() * 2 - 1) * 0.55;
          d.gazeY = (Math.random() * 2 - 1) * 0.3;
          this.target.eyeX = d.gazeX;
          this.target.eyeY = d.gazeY;
          this.target.headTilt = d.gazeX * 6;
        }
      }
      // 眨眼：随机间隔
      if (now >= (d.nextBlink || 0)) {
        d.nextBlink = now + 2200 + Math.random() * 3600;
        d.blinkUntil = now + 130;
      }
      this.target.eyeOpen = now < (d.blinkUntil || 0)
        ? Math.abs(Math.sin(((d.blinkUntil - now) / 130) * Math.PI))
        : 1;

      // 定时小动作
      if (now >= d.nextMotionAt) {
        d.nextMotionAt = now + d.motionEveryMs * (0.7 + Math.random() * 0.6);
        if (!d.speaking) this.playMotion();
      }
    }

    _applyLipSync() {
      if (this.analyser) {
        const buf = new Uint8Array(this.analyser.frequencyBinCount);
        this.analyser.getByteFrequencyData(buf);
        let sum = 0;
        const from = 2;
        const to = Math.min(buf.length, 48);
        for (let i = from; i < to; i++) sum += buf[i];
        this.target.mouthOpen = Math.min(1, (sum / ((to - from) * 255)) * 2.6);
      } else if (!this.idle.speaking) {
        this.target.mouthOpen = 0;
      }
    }

    /* ---------------- 绘制 ---------------- */

    _draw(t) {
      const g = this.ctx;
      const w = this.w;
      const h = this.h;
      if (!w || !h) return;
      g.clearRect(0, 0, w, h);

      // 背景：导航模式给的风景优先，否则交给 .stage-bg（那层是独立的元素）
      if (this.scenery) {
        drawLakeScene(g, w, h, t, (this.scenery && (this.scenery.spot || this.scenery.city)) || '西湖');
      }

      const P = this.pose;
      const s = (this._scale || 1) * this.userScale;
      const cx = w / 2 + (this.userX / 100) * w * 0.5;
      const baseY = h * 0.97 + (this.userY / 100) * h * 0.5;

      g.save();
      g.translate(cx, baseY);
      g.scale(s, s);
      // 身体微摆 + 转身（转身用一个横向压缩来假装，简单但足够表达"侧身"）
      const turnScale = 1 - Math.abs(P.turn) * 0.22;
      g.rotate((P.bodySway * Math.PI) / 180);
      g.scale(turnScale, 1);

      const breathe = P.breath * 3.2;
      // 绘制顺序 = 从后往前：伞 → 披帛后幅 → 身体 → 手臂 → 头 → 披帛前幅
      this._drawUmbrella(g, P, t);
      this._drawShawl(g, P, t, 'back');
      this._drawBody(g, breathe, t);
      this._drawArms(g, P);
      this._drawHead(g, P, breathe, t);
      this._drawShawl(g, P, t, 'front');
      g.restore();

      // 不再画举牌（_drawPlacard）。
      // 用户反馈那块木牌"太突兀"：比人物还显眼、还挡住风景。而且它和人物动作
      // 对不上 —— 手并没有真的抬起来托住牌子，看着像贴上去的。
      // 目标景点改由舞台右下角的小卡片（#nav-mini）呈现，要看细节就点开整页导航。
      // `_drawPlacard` 方法保留没删：万一以后想做成"可选的展示方式"还能直接用。
    }

    /**
     * 汉服身体：齐胸襦裙（上襦 + 高腰长裙），青花／青碧配色。
     *
     * 比例按"少女"来做（约 6 头身），不是原来的 Q 版比例：
     *   头顶 ≈ -360，下巴 ≈ -286，肩 ≈ -268，腰 ≈ -196，裙摆 = 0
     * 原来的头几乎占了身体的三分之一，看着像儿童。
     */
    _drawBody(g, breathe, t) {
      const y = -breathe;

      // ---- 长裙：高腰、上窄下宽 ----
      // 裙摆收窄到 70：上一版是 80，配上偏大的头，整个人是个等腰三角形。
      const waistY = -196 + y;
      const hemY = 0;
      const sway = Math.sin(t * 0.6) * 3;          // 裙摆轻摆，静止的人物会显得很"死"
      g.beginPath();
      g.moveTo(-25, waistY);
      g.bezierCurveTo(-42, waistY + 70, -58, hemY - 46, -70 + sway, hemY);
      g.lineTo(70 + sway, hemY);
      g.bezierCurveTo(58, hemY - 46, 42, waistY + 70, 25, waistY);
      g.closePath();
      const skirt = g.createLinearGradient(0, waistY, 0, hemY);
      skirt.addColorStop(0, C.skirtTop);
      skirt.addColorStop(0.42, C.skirtMid);
      skirt.addColorStop(1, C.skirtDeep);
      g.fillStyle = skirt;
      g.fill();

      // 裙褶：从腰部向下发散的浅色竖线
      g.strokeStyle = 'rgba(255,255,255,0.13)';
      g.lineWidth = 1.3;
      for (let i = -4; i <= 4; i++) {
        if (!i) continue;
        g.beginPath();
        g.moveTo(i * 5.5, waistY + 16);
        g.quadraticCurveTo(i * 12, waistY + 110, i * 17 + sway, hemY - 6);
        g.stroke();
      }

      // 裙上的缠枝纹：江南织物常见的连续卷草，用一条正弦 + 小圆点示意
      g.strokeStyle = 'rgba(233,240,238,0.30)';
      g.lineWidth = 1.6;
      for (let row = 0; row < 3; row++) {
        const ry = waistY + 74 + row * 42;
        const halfW = 30 + row * 13;
        g.beginPath();
        for (let i = 0; i <= 20; i++) {
          const p = i / 20;
          const x = -halfW + p * halfW * 2;
          const yy = ry + Math.sin(p * Math.PI * 3.4) * 5;
          if (i === 0) g.moveTo(x, yy); else g.lineTo(x, yy);
        }
        g.stroke();
        g.fillStyle = 'rgba(233,240,238,0.26)';
        for (let i = 1; i < 5; i++) {
          const p = i / 5;
          g.beginPath();
          g.arc(-halfW + p * halfW * 2, ry + Math.sin(p * Math.PI * 3.4) * 5, 2.1, 0, Math.PI * 2);
          g.fill();
        }
      }

      // 裙摆镶边（两条：深青 + 米白，汉服常见的"衣缘"层次）
      g.fillStyle = C.trimDeep;
      g.beginPath();
      g.moveTo(-80 + sway, hemY);
      g.lineTo(80 + sway, hemY);
      g.lineTo(80 + sway, hemY - 11);
      g.quadraticCurveTo(sway, hemY - 19, -80 + sway, hemY - 11);
      g.closePath();
      g.fill();
      g.fillStyle = C.trim;
      g.fillRect(-80 + sway, hemY - 12, 160, 3.4);

      // ---- 上襦：月白色短襦，交领右衽 ----
      const shoulderY = -268 + y;
      g.beginPath();
      g.moveTo(-30, shoulderY + 4);
      g.bezierCurveTo(-36, shoulderY + 40, -33, waistY - 16, -27, waistY + 6);
      g.lineTo(27, waistY + 6);
      g.bezierCurveTo(33, waistY - 16, 36, shoulderY + 40, 30, shoulderY + 4);
      g.closePath();
      const torso = g.createLinearGradient(0, shoulderY, 0, waistY);
      torso.addColorStop(0, C.robeHi);
      torso.addColorStop(1, C.robeMid);
      g.fillStyle = torso;
      g.fill();

      // 交领右衽：两道斜边（内白外青），这是汉服最醒目的识别特征
      g.fillStyle = C.lining;
      g.beginPath();
      g.moveTo(-19, shoulderY + 6);
      g.lineTo(0, shoulderY + 52);
      g.lineTo(19, shoulderY + 6);
      g.lineTo(8, shoulderY + 1);
      g.lineTo(0, shoulderY + 33);
      g.lineTo(-8, shoulderY + 1);
      g.closePath();
      g.fill();
      g.strokeStyle = C.trimDeep;
      g.lineWidth = 2.2;
      g.beginPath();
      g.moveTo(-20, shoulderY + 5); g.lineTo(0, shoulderY + 52); g.lineTo(20, shoulderY + 5);
      g.stroke();

      // 袖口与肩部的青边
      g.fillStyle = C.trimDeep;
      g.fillRect(-31, shoulderY + 2, 62, 5);

      // ---- 腰带 + 玉佩（挂在右侧，走动时会晃）----
      g.fillStyle = C.trimDeep;
      g.fillRect(-29, waistY - 8, 58, 12);
      g.fillStyle = C.trim;
      g.fillRect(-29, waistY - 8, 58, 4);
      const knotX = 15;
      g.fillStyle = C.trim;
      g.fillRect(knotX - 2.5, waistY + 4, 5, 34);
      g.fillStyle = C.jade;
      g.beginPath();
      g.arc(knotX, waistY + 42, 6.2, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.45)';
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(knotX, waistY + 42, 6.2, 0, Math.PI * 2);
      g.stroke();
    }

    /**
     * 披帛：江南古风的灵魂配件。
     *
     * 一条长纱从双肩绕过、在身后飘垂 —— 它既是"古风"的强识别符号，
     * 也是让静止人物显得有风、有空气感的关键。所以单独画，
     * 并且前后分两幅（后幅在身体之后画、前幅在之后画），才有"披"的层次。
     *
     * @param {'back'|'front'} layer
     */
    _drawShawl(g, P, t, layer) {
      const flow = Math.sin(t * 0.8) * 6 + P.bodySway * 0.6;
      const shoulderY = -262;
      g.save();
      if (layer === 'back') {
        // 身后垂下的两条**细**绦带。
        // 上一版画成了两片宽纱，渲染出来是两块半透明灰玻璃糊在身侧 —— 很难看。
        // 其实披帛在画面上起的是"线"的作用（拉出飘逸的曲线），不是"面"，
        // 所以这里收成窄带，并贴着身体往下走。
        g.globalAlpha = 0.40;
        g.fillStyle = C.shawlHi;
        for (const side of [-1, 1]) {
          const tipX = side * (22 + flow * 1.5);
          const midX = side * (34 + flow * 0.7);
          g.beginPath();
          g.moveTo(side * 20, shoulderY + 6);
          g.bezierCurveTo(side * 34, shoulderY + 70, midX, shoulderY + 140, tipX, shoulderY + 198);
          g.lineTo(tipX + side * 6, shoulderY + 196);       // 带子的宽度只有 6
          g.bezierCurveTo(midX + side * 6, shoulderY + 138, side * 40, shoulderY + 68, side * 26, shoulderY + 4);
          g.closePath();
          g.fill();
        }
      } else {
        // 身前横过胸前的那一段（略透明，压在衣服上）—— 这是披帛最容易被认出来的一笔
        g.globalAlpha = 0.62;
        g.beginPath();
        g.moveTo(-27, shoulderY + 16);
        g.quadraticCurveTo(0, shoulderY + 42, 27, shoulderY + 16);
        g.quadraticCurveTo(0, shoulderY + 52, -27, shoulderY + 16);
        g.closePath();
        const grad = g.createLinearGradient(-27, shoulderY, 27, shoulderY + 50);
        grad.addColorStop(0, C.shawl);
        grad.addColorStop(0.5, C.shawlHi);
        grad.addColorStop(1, C.shawl);
        g.fillStyle = grad;
        g.fill();
      }
      g.restore();
    }

    /** 手臂：抬起的角度由 armL / armR 决定，袖子随之摆动 */
    _drawArms(g, P) {
      this._drawArm(g, -1, P.armL);
      this._drawArm(g, 1, P.armR);
    }

    /**
     * 一只手臂 + 大袖。
     *
     * 肩高必须跟 _drawBody 里的 shoulderY(-268) 对齐 —— 上一版这里还写着 -196，
     * 是因为当时身体是 Q 版比例。改了身体不改这里，手臂就会从腰部伸出来。
     */
    _drawArm(g, side, angleDeg) {
      // 肩再外扩一点、袖子整体朝外张开 6 度 —— 上一版袖子完全落在裙子轮廓里，
      // 远看就是"没有手臂的一只绿锥子"。稍微张开支在身侧，剪影才有人的形状。
      const shoulderX = side * 29;
      const shoulderY = -264;
      const a = (((side > 0 ? angleDeg : angleDeg) * Math.PI) / 180 * -side) + side * 0.10;
      g.save();
      g.translate(shoulderX, shoulderY);
      g.rotate(a);

      // 交领露出的内袖（素白），先画窄的一层
      g.beginPath();
      g.moveTo(-10, 0);
      g.quadraticCurveTo(-13, 40, -10, 74);
      g.quadraticCurveTo(0, 80, 10, 74);
      g.quadraticCurveTo(13, 40, 10, 0);
      g.closePath();
      g.fillStyle = C.lining;
      g.fill();

      // 外面的宽袖：**月白**，不是深青 —— 深青会和长裙糊成一片，
      // 浅色袖子压在深色裙上才有层次，"宽袍大袖"也才看得出来。
      // 宽度收到 ±16：上一版 ±19 加上内袖，两只袖子连成一大块白，
      // 把上襦和交领全盖住了。
      g.beginPath();
      g.moveTo(-10, -2);
      g.bezierCurveTo(-17, 34, -19, 70, -15, 94);
      g.quadraticCurveTo(0, 103, 15, 94);
      g.bezierCurveTo(19, 70, 17, 34, 10, -2);
      g.closePath();
      const sleeve = g.createLinearGradient(0, 0, 0, 100);
      sleeve.addColorStop(0, '#ffffff');
      sleeve.addColorStop(0.6, C.robeHi);
      sleeve.addColorStop(1, C.robeMid);
      g.fillStyle = sleeve;
      g.fill();
      // 袖身的一道青花暗纹，避免大面积白看起来空
      g.strokeStyle = 'rgba(53,97,143,0.32)';
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(-7.5, 20);
      g.quadraticCurveTo(0, 34, 7.5, 20);
      g.stroke();
      g.beginPath();
      g.moveTo(-9, 48);
      g.quadraticCurveTo(0, 64, 9, 48);
      g.stroke();

      // 袖口青花衣缘（加宽，成为一道明确的深色边）
      g.fillStyle = C.trim;
      g.beginPath();
      g.moveTo(-15, 86);
      g.quadraticCurveTo(0, 96, 15, 86);
      g.lineTo(15, 94);
      g.quadraticCurveTo(0, 104, -15, 94);
      g.closePath();
      g.fill();

      // 手：**不画**。
      // 上一版在手的位置画了个椭圆，结果它悬在裙侧像一块贴上去的肉色斑。
      // 汉服的大袖本来就该把手藏起来（"袖手"），所以让袖口直接收住更自然，
      // 也省掉一个很容易画崩的部位。
      g.restore();
    }

    /** 头：脸、眼、嘴、发髻与簪花 */
    /**
     * 头：江南少女的脸、古风发髻（双环髻 + 步摇）、额前花钿。
     *
     * 本地坐标以**头部中心**为原点，所以外面 translate 到 -318（新的肩高 -268 之上）。
     * 上一版把头放在 -252、比例接近 Q 版，看着像儿童；这一版按约 6 头身重排。
     */
    _drawHead(g, P, breathe, t) {
      const y = -breathe;
      g.save();
      // 头身比：先平移到头部中心，再整体缩到 0.58。
      //
      // 这是上一版最难看的地方 —— 头占了身体四分之一，看着像儿童。
      // 实测把头部单独缩到 0.58、并把中心下移到 -290（这样缩短后的脖子
      // 仍然接得上 -268 的肩线），整只约为 6 头身，才像个"少女"。
      // 缩放放在这里而不是逐个数改坐标，是因为头的构造很细，重算一遍容易出错。
      g.translate(0, -290 + y);
      g.scale(0.58, 0.58);
      g.rotate((P.headTilt * Math.PI) / 180);
      g.translate(0, P.headNod);

      // ---- 脖子（先画，压在脸和衣服之间）----
      g.fillStyle = C.skinShade;
      g.beginPath();
      g.moveTo(-10, 24); g.lineTo(10, 24); g.lineTo(12, 56); g.lineTo(-12, 56);
      g.closePath();
      g.fill();

      // ---- 后发：整片垫在脸后面，并向下延伸成长发 ----
      const hairSway = Math.sin(t * 0.7) * 3.5;
      g.fillStyle = C.hair;
      g.beginPath();
      g.ellipse(0, -2, 39, 46, 0, 0, Math.PI * 2);
      g.fill();
      // 两侧垂到腰的长发。
      // 注意头部整体缩到了 0.58，所以这里的局部长度要放大回去 ——
      // 否则头发跟着头一起缩，只到胸口，看着像短发。
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(side * 33, -6);
        g.bezierCurveTo(side * 54, 78, side * (48 + hairSway), 170, side * (36 + hairSway * 1.4), 246);
        g.lineTo(side * (18 + hairSway * 1.2), 238);
        g.bezierCurveTo(side * 32, 164, side * 36, 78, side * 22, -4);
        g.closePath();
        g.fill();
      }
      // 发丝高光：一道沿头顶走的浅色弧，避免整头死黑
      g.strokeStyle = C.hairHi;
      g.lineWidth = 2.4;
      g.beginPath();
      g.arc(0, -4, 31, Math.PI * 1.12, Math.PI * 1.62);
      g.stroke();
      g.lineWidth = 1.4;
      g.beginPath();
      g.arc(0, 2, 27, Math.PI * 1.2, Math.PI * 1.5);
      g.stroke();

      // ---- 脸：下巴略收的鹅蛋脸 ----
      g.fillStyle = C.skin;
      g.beginPath();
      g.moveTo(0, -34);
      g.bezierCurveTo(26, -34, 30, -14, 30, 2);
      g.bezierCurveTo(30, 22, 18, 36, 0, 40);
      g.bezierCurveTo(-18, 36, -30, 22, -30, 2);
      g.bezierCurveTo(-30, -14, -26, -34, 0, -34);
      g.closePath();
      g.fill();
      // 脸颊两侧一点点暗，让脸有体积（纯平涂会很"贴纸"）
      g.fillStyle = 'rgba(210,160,140,0.16)';
      g.beginPath();
      g.ellipse(0, 14, 26, 20, 0, 0, Math.PI);
      g.fill();

      // ---- 刘海：中分 + 两侧鬓发 ----
      g.fillStyle = C.hair;
      g.beginPath();
      g.moveTo(-31, -12);
      g.bezierCurveTo(-28, -40, -14, -50, 0, -50);
      g.bezierCurveTo(14, -50, 28, -40, 31, -12);
      g.bezierCurveTo(22, -22, 14, -26, 8, -22);
      g.bezierCurveTo(2, -18, -2, -18, -8, -22);
      g.bezierCurveTo(-14, -26, -22, -22, -31, -12);
      g.closePath();
      g.fill();
      // 鬓发：贴着脸颊垂下来的两缕
      for (const side of [-1, 1]) {
        g.beginPath();
        g.moveTo(side * 29, -14);
        g.quadraticCurveTo(side * 37, 6, side * 31, 30);
        g.quadraticCurveTo(side * 26, 12, side * 24, -8);
        g.closePath();
        g.fill();
      }

      // ---- 双环髻 + 步摇 ----
      for (const side of [-1, 1]) {
        g.fillStyle = C.hair;
        g.beginPath();
        g.ellipse(side * 25, -46, 15, 13, side * 0.35, 0, Math.PI * 2);
        g.fill();
        g.strokeStyle = C.hairHi;
        g.lineWidth = 1.4;
        g.beginPath();
        g.ellipse(side * 25, -46, 15, 13, side * 0.35, Math.PI * 0.9, Math.PI * 1.7);
        g.stroke();
      }
      // 髻间的珍珠与簪花
      g.fillStyle = C.pearl;
      for (const [px, py] of [[0, -52], [-13, -48], [13, -48]]) {
        g.beginPath(); g.arc(px, py, 3.2, 0, Math.PI * 2); g.fill();
      }
      g.fillStyle = C.flower;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        g.beginPath();
        g.arc(Math.cos(a) * 4.4, -58 + Math.sin(a) * 4.4, 3.4, 0, Math.PI * 2);
        g.fill();
      }
      g.fillStyle = C.trim;
      g.beginPath(); g.arc(0, -58, 2.2, 0, Math.PI * 2); g.fill();

      // 步摇：从左侧发髻垂下的珠串，随人物微摆而晃（"步则摇之"，是古风最灵的一笔）
      const swing = Math.sin(t * 1.1 + 0.6) * 4 + P.bodySway * 0.5;
      g.strokeStyle = C.pearl;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(-31, -40);
      g.quadraticCurveTo(-38 + swing * 0.4, -18, -36 + swing, 4);
      g.stroke();
      for (let i = 1; i <= 3; i++) {
        const p = i / 3;
        const bx = -31 + (-5 + swing) * p;
        const by = -40 + 44 * p;
        g.fillStyle = i === 3 ? C.flower : C.pearl;
        g.beginPath(); g.arc(bx, by, i === 3 ? 3.6 : 2.4, 0, Math.PI * 2); g.fill();
      }

      // ---- 额前花钿：古风少女的标志性一笔 ----
      g.fillStyle = C.flower;
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
        g.beginPath();
        g.ellipse(Math.cos(a) * 3.4, -20 + Math.sin(a) * 3.4, 2.2, 1.5, a, 0, Math.PI * 2);
        g.fill();
      }
      g.beginPath(); g.arc(0, -20, 1.5, 0, Math.PI * 2); g.fill();

      // ---- 眉眼 ----
      const expr = this._expr;
      const eyeH = 11.5 * clamp(P.eyeOpen, 0, 1);
      const dx = clamp(P.eyeX, -1, 1) * 2.4;
      const dy = clamp(P.eyeY, -1, 1) * 1.6;
      for (const side of [-1, 1]) {
        const ex = side * 13;
        const ey = 6;
        // 眼白
        g.fillStyle = '#fdfaf7';
        g.beginPath();
        g.ellipse(ex, ey, 8.6, Math.max(0.6, eyeH * 0.78), 0, 0, Math.PI * 2);
        g.fill();
        if (eyeH > 1.8) {
          // 虹膜：上深下浅的渐变，加一个高光点 —— 眼睛有没有神全靠这两笔
          const iris = g.createLinearGradient(ex, ey - eyeH * 0.6, ex, ey + eyeH * 0.6);
          iris.addColorStop(0, '#2c3b4d');
          iris.addColorStop(0.55, '#4a7f92');
          iris.addColorStop(1, '#9fc9d2');
          g.fillStyle = iris;
          const look = expr === '凝望' ? side * 0.6 : 0;
          g.beginPath();
          g.ellipse(ex + dx + look, ey + dy, 5.2, Math.min(eyeH * 0.72, 7), 0, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = '#1d2733';
          g.beginPath();
          g.arc(ex + dx + look, ey + dy, 2.4, 0, Math.PI * 2);
          g.fill();
          g.fillStyle = 'rgba(255,255,255,0.95)';
          g.beginPath();
          g.arc(ex + dx + look - 1.8, ey + dy - 2.2, 1.7, 0, Math.PI * 2);
          g.fill();
        }
        // 上眼线（比下眼线粗，是动画脸的关键）
        g.strokeStyle = '#2b2119';
        g.lineWidth = 2.6;
        g.beginPath();
        const lidY = ey - eyeH * 0.8;
        g.moveTo(ex - 9, lidY + 1.8);
        g.quadraticCurveTo(ex, lidY - 2.6, ex + 9, lidY + 1.8);
        g.stroke();
        // 睫毛尖
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(ex + side * 8.6, lidY + 1.4);
        g.lineTo(ex + side * 11.5, lidY - 1.6);
        g.stroke();
      }
      // 眉：细长的远山眉
      g.strokeStyle = '#4a3b33';
      g.lineWidth = 1.7;
      const browLift = expr === '欣喜' ? -2.4 : expr === '凝望' ? -1 : 0;
      for (const side of [-1, 1]) {
        const ex = side * 13;
        g.beginPath();
        g.moveTo(ex - 8.5, -8 + browLift);
        g.quadraticCurveTo(ex, -12.5 + browLift, ex + 8.5, -8.6 + browLift);
        g.stroke();
      }
      // 鼻：只画一小笔投影，画多了就变成"写实脸"了
      g.strokeStyle = 'rgba(190,140,120,0.5)';
      g.lineWidth = 1.3;
      g.beginPath();
      g.moveTo(1.5, 18);
      g.lineTo(-1.5, 20.5);
      g.stroke();

      // 腮红
      if (P.blush > 0.01) {
        g.globalAlpha = P.blush;
        g.fillStyle = C.blush;
        for (const side of [-1, 1]) {
          g.beginPath();
          g.ellipse(side * 21, 18, 8.5, 5, 0, 0, Math.PI * 2);
          g.fill();
        }
        g.globalAlpha = 1;
      }

      // 唇：口型由 mouthOpen 驱动
      const mo = clamp(P.mouthOpen, 0, 1);
      g.fillStyle = C.lip;
      if (mo > 0.06) {
        g.beginPath();
        g.ellipse(0, 28, 5.6, 2 + mo * 6, 0, 0, Math.PI * 2);
        g.fill();
      } else if (expr === '微笑' || expr === '欣喜') {
        g.strokeStyle = C.lip;
        g.lineWidth = 2.2;
        g.beginPath();
        g.arc(0, 24.5, 6.6, 0.3 * Math.PI, 0.7 * Math.PI);
        g.stroke();
      } else {
        g.strokeStyle = C.lip;
        g.lineWidth = 1.9;
        g.beginPath();
        g.moveTo(-4, 27.5);
        g.quadraticCurveTo(0, 29.4, 4, 27.5);
        g.stroke();
      }
      g.restore();
    }
    /**
     * 油纸伞：扛在右肩上方。改成**青花纸伞**（白底蓝绘），配江南的色调 ——
     * 原来那把大红的伞跟烟青月白放在一起太抢眼，像节庆道具。
     */
    _drawUmbrella(g, P, t) {
      const sway = Math.sin(t * 0.65 + 1.2) * 2.4;
      g.save();
      g.translate(48 + sway * 0.6, -330);
      g.rotate(((P.umbrella - 20 + sway) * Math.PI) / 180);

      // 伞柄（竹）
      g.strokeStyle = '#8a6a44';
      g.lineWidth = 3.4;
      g.beginPath();
      g.moveTo(0, 0);
      g.lineTo(0, 150);
      g.stroke();
      // 伞柄上的两道竹节
      g.strokeStyle = 'rgba(90,66,40,0.6)';
      g.lineWidth = 1.6;
      for (const yy of [46, 100]) {
        g.beginPath(); g.moveTo(-2.6, yy); g.lineTo(2.6, yy); g.stroke();
      }

      // 伞面：白底 + 青花描边
      g.beginPath();
      g.arc(0, 0, 66, Math.PI, Math.PI * 2);
      g.closePath();
      const canopy = g.createLinearGradient(-66, -56, 66, 0);
      canopy.addColorStop(0, '#ffffff');
      canopy.addColorStop(0.55, C.umbrella);
      canopy.addColorStop(1, '#cddbe6');
      g.fillStyle = canopy;
      g.fill();

      // 青花缠枝：沿伞面画两道弧线 + 点，模仿青花瓷的连续纹样
      g.save();
      g.beginPath();
      g.arc(0, 0, 66, Math.PI, Math.PI * 2);
      g.closePath();
      g.clip();
      g.strokeStyle = 'rgba(53,97,143,0.55)';
      g.lineWidth = 2.2;
      for (const rr of [40, 54]) {
        g.beginPath();
        g.arc(0, 0, rr, Math.PI, Math.PI * 2);
        g.stroke();
      }
      g.fillStyle = 'rgba(53,97,143,0.45)';
      for (let i = 0; i <= 8; i++) {
        const a = Math.PI + (Math.PI * i) / 8;
        g.beginPath();
        g.arc(Math.cos(a) * 47, Math.sin(a) * 47, 2.6, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();

      // 伞骨
      g.strokeStyle = 'rgba(53,97,143,0.5)';
      g.lineWidth = 1.3;
      for (let i = 1; i < 6; i++) {
        const a = Math.PI + (Math.PI * i) / 6;
        g.beginPath();
        g.moveTo(0, 0);
        g.lineTo(Math.cos(a) * 66, Math.sin(a) * 66);
        g.stroke();
      }
      // 伞顶
      g.fillStyle = C.trimDeep;
      g.beginPath();
      g.arc(0, 0, 4.2, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    /** 手里的木牌：与 nav-visuals.js 的样式保持同一种"木牌"观感 */
    _drawPlacard(g, w, h, cx, baseY, s) {
      if (!this.placard) return;
      const label = this.placard.text;
      const scale = clamp(s * 0.9, 0.5, 2.2);
      const W = 210;
      const H = 118;
      g.save();
      g.translate(cx + 150 * s, baseY - 330 * s);
      g.rotate(0.06);
      g.scale(scale, scale);
      // 杆
      g.fillStyle = '#6d4a28';
      g.beginPath();
      g.roundRect(-7, H - 8, 14, 120, 5);
      g.fill();
      // 牌面
      g.fillStyle = '#5d3f24';
      g.beginPath();
      g.roundRect(-W / 2, -H / 2, W, H, 10);
      g.fill();
      g.fillStyle = '#8b6239';
      g.beginPath();
      g.roundRect(-W / 2 + 5, -H / 2 + 5, W - 10, H - 10, 8);
      g.fill();
      // 木纹
      g.strokeStyle = 'rgba(93,63,36,0.32)';
      g.lineWidth = 1;
      for (let i = 1; i < 5; i++) {
        const y = -H / 2 + (H / 5) * i;
        g.beginPath();
        g.moveTo(-W / 2 + 12, y);
        g.lineTo(W / 2 - 12, y);
        g.stroke();
      }
      // 字
      g.fillStyle = '#2b1a0c';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      let size = 34;
      const maxW = W - 40;
      const maxH = H - 30;
      const lines = [];
      while (size >= 15) {
        lines.length = 0;
        g.font = `700 ${size}px "Microsoft YaHei","PingFang SC",sans-serif`;
        let line = '';
        for (const ch of label) {
          const nx = line + ch;
          if (g.measureText(nx).width > maxW && line) { lines.push(line); line = ch; }
          else line = nx;
        }
        if (line) lines.push(line);
        if (lines.length * size * 1.2 <= maxH) break;
        size -= 2;
      }
      if (!lines.length) lines.push('');
      g.font = `700 ${size}px "Microsoft YaHei","PingFang SC",sans-serif`;
      const lh = size * 1.2;
      const y0 = -((lines.length - 1) * lh) / 2;
      lines.forEach((ln, i) => g.fillText(ln, 0, y0 + i * lh));
      g.restore();
    }

    destroy() {
      if (this._raf) cancelAnimationFrame(this._raf);
      if (this._ro) { try { this._ro.disconnect(); } catch { /* 忽略 */ } }
      this._ro = null;
      this.ready = false;
    }
  }

  /** 各动作的时长（毫秒） */
  const MOTION_DUR = {
    招手: 1700, 作揖: 1900, 点头: 1200, 回眸: 2000, 撑伞: 1800, 摇橹: 2400,
  };

  // 「江南古风少女」(lake-boatwoman) 形象条目已移除：形象列表不再提供它。
  // 注意：本文件仍然导出 LakeAvatar 与 drawLakeScene ——
  //   · drawLakeScene 负责「西湖美景」背景绘制（backgrounds.js / boot.js 在用），
  //     删掉整个文件会让该背景失效，所以只摘掉形象条目。
  window.WenlvLake = { LakeAvatar, drawLakeScene, COLORS: C };
})();
