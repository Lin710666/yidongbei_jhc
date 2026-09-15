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
      this.rafId = null;
      this.ready = false;
      this.onReadyCb = null;
      this.onErrorCb = null;
      this.onTapCb = null;
      this.expressions = [];
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

      // 鼠标移动 → 视线跟随（把屏幕坐标换算成模型坐标系的 -1..1）
      host.addEventListener('mousemove', (e) => {
        if (!this.model) return;
        const r = host.getBoundingClientRect();
        const x = ((e.clientX - r.left) / r.width) * 2 - 1;
        const y = ((e.clientY - r.top) / r.height) * 2 - 1;
        this.model.focus(x, y);
      });
      host.addEventListener('mouseleave', () => { if (this.model) this.model.focus(0, 0); });

      // 点击人物 → 交给上层做互动
      this.app.stage.interactive = true;
      this.app.stage.hitArea = new window.PIXI.Rectangle(0, 0, width, height);
      this.app.stage.on('pointertap', () => { if (this.onTapCb) this.onTapCb(); });

      window.addEventListener('resize', () => this.resize());
      this.loop();
      this.ready = true;
    }

    /** 载入模型。url 形如 /models/nahida/Nahida.model3.json */
    async load(url, { label } = {}) {
      if (!this.app) await this.init();

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

      // 保险起见过一次"默认表情"，避免上一只模型的表情残留
      try { model.internalModel.motionManager.expressionManager?.resetExpression(); } catch { /* 忽略 */ }

      if (this.onReadyCb) this.onReadyCb({ url, label: this.modelId, expressions: this.expressions });
      return model;
    }

    /** 按容器尺寸把模型摆正：底部对齐、水平居中，再叠加用户的手动缩放/位移 */
    resize() {
      if (!this.app) return;
      const host = this.canvas.parentElement;
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      this.app.renderer.resize(w, h);
      if (this.app.stage.hitArea) this.app.stage.hitArea = new window.PIXI.Rectangle(0, 0, w, h);
      if (!this.model) return;

      const mw = this.model.width || 1;
      const mh = this.model.height || 1;
      // 让模型高度占容器的 ~86%，宽度不超过 ~92%
      this.baseScale = Math.min((h * 0.86) / mh, (w * 0.92) / mw);
      this.applyTransform();
    }

    applyTransform() {
      if (!this.model) return;
      const host = this.canvas.parentElement;
      const rect = host.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
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

    /** 随机抽一个动作播（模型有动作文件时才有反应） */
    async playMotion() {
      if (!this.model) return false;
      try {
        // 随机选一个动作组，避免每次都播同一个
        const mm = this.model.internalModel.motionManager;
        const groups = Object.keys(mm.definitions || {});
        if (!groups.length) return false;
        const g = groups[Math.floor(Math.random() * groups.length)];
        await this.model.motion(g);
        return true;
      } catch { return false; }
    }

    /** 每帧：把目标嘴型平滑逼近（避免音量抖动导致嘴抽搐） */
    loop() {
      const step = () => {
        this.rafId = requestAnimationFrame(step);
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
        } else {
          this.targetMouthOpen = 0;
        }
        this.mouthOpen += (this.targetMouthOpen - this.mouthOpen) * 0.35;
        try {
          const core = this.model && this.model.internalModel && this.model.internalModel.coreModel;
          if (core && this.mouthOpen > 0.001) core.setParameterValueById('ParamMouthOpenY', this.mouthOpen);
          else if (core) core.setParameterValueById('ParamMouthOpenY', 0);
        } catch { /* 该模型没有该参数就跳过 */ }
      };
      step();
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
        const onEnd = () => { cleanup(); this.targetMouthOpen = 0; resolve(); };
        const onErr = (e) => { cleanup(); reject(e); };
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
    }

    destroy() {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      if (this.model) { try { this.model.destroy(); } catch { /* 忽略 */ } }
      if (this.app) { try { this.app.destroy(false, { children: true }); } catch { /* 忽略 */ } }
      this.ready = false;
    }
  }

  window.Live2DStage = Live2DStage;
})();
