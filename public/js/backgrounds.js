/* ============================================================================
 * backgrounds.js —— 背景管理器
 *
 * 三类背景：
 *   · 图片背景   —— 直接铺一张图（内置 3 张来自 AIRI，或用户自己上传的）
 *   · 程序化背景 —— 用 Canvas 现画，零素材体积、任意分辨率都不糊
 *   · 纯色       —— 什么都不画，只留主题底色
 *
 * 程序化背景的写法是照着 AIRI 的 Backgrounds 组件重做的：
 *   part-animated-wave.vue → wave      SakuraPetal.vue → sakura
 *   pattern-cross.vue      → cross     默认色相流动    → aurora
 * 另外补了几个文旅场景（山水/黄昏/宣纸）和星野，都是几行数学，不引任何库。
 *
 * 性能上的取舍：背景是每秒都在重绘的，所以
 *   · 设备像素比封顶 1.5（背景不需要人物那么锐）
 *   · 一律用 Canvas 2D 的渐变/路径，不用 shadowBlur（它在动画里非常贵）
 *   · 页面切到后台（document.hidden）时停掉 rAF，别白烧电
 * ==========================================================================*/
(function () {
  'use strict';

  const prefersReduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** 伪随机（可复现）：同一个种子每次画出同一片星空/同一批花瓣，避免刷新就换样 */
  function rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  class BackgroundManager {
    constructor({ imageEl, canvasEl, videoEl }) {
      this.imageEl = imageEl;
      this.canvasEl = canvasEl;
      // 视频背景：西湖美景那类实拍素材。
      // 用真正的 <video>（而不是把视频画进 canvas）有三个好处：
      //   · 交给浏览器的硬解码器，4K 视频也不吃主线程
      //   · 不需要把整段视频解进内存，长视频也能用
      //   · `object-fit: cover` 直接就把"铺满且不变形"做掉了
      this.videoEl = videoEl || null;
      this.ctx = canvasEl.getContext('2d', { alpha: true });
      this.current = null;
      this.raf = null;
      this.t0 = performance.now();
      this.particles = [];
      this.w = 0;
      this.h = 0;
      // DPR 上限跟 Live2D / 3D 对齐（它们都是 2）。
      // 原来这里是 1.5，结果高分屏上背景比角色糊一档 —— 同一屏里一个清晰一个虚，很出戏。
      // 背景每帧的开销本来就很低（实测关掉它帧率只涨 1fps），提到 2 不会拖慢。
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.paused = false;

      this._onResize = () => this.resize();
      window.addEventListener('resize', this._onResize);

      // 光靠 window.resize 不够 —— 舞台尺寸会因为下面这些原因变，而窗口本身没变、
      // 根本不会触发 resize：
      //   · 点「全屏放大词云」：body.wc-full 把 .stage 改成 position:fixed 铺满窗口
      //   · 侧栏展开/收起、面板切换
      //   · 字体加载完成后文字尺寸变化
      // 之前背景这里只监听了 window.resize，所以一进全屏词云，背景 canvas 还停在旧尺寸，
      // 舞台上就露出一大块没铺到的黑底（用户截图里那条明显的分界线就是这么来的）。
      // Live2D / 3D / 词云都是靠 ResizeObserver 盯舞台本体解决的，背景这边漏了，这里补上。
      this._resizeTimer = null;
      if (typeof window.ResizeObserver === 'function') {
        const host = this.canvasEl.parentElement;
        if (host) {
          this._ro = new window.ResizeObserver(() => {
            // 稍微延后：全屏切换这类场景父容器尺寸是连续变化的，等它稳下来再量
            clearTimeout(this._resizeTimer);
            this._resizeTimer = setTimeout(() => this.resize(), 60);
          });
          this._ro.observe(host);
        }
      }
      document.addEventListener('visibilitychange', () => {
        this.paused = document.hidden;
        if (this.paused) {
          this._stop();
          this._stopVideo();
        } else if (this.current && this.current.kind === 'video') {
          // 回到前台要接着播 —— video 元素被 pause 之后不会自己恢复
          this._setVideo(this.current.url);
        } else if (this.current && this.current.kind === 'procedural') {
          this._start();
        }
      });
    }

    resize() {
      const host = this.canvasEl.parentElement;
      if (!host) return;
      const r = host.getBoundingClientRect();
      this.w = Math.max(1, Math.floor(r.width));
      this.h = Math.max(1, Math.floor(r.height));
      // 浏览器缩放（Ctrl + 滚轮 / Ctrl 加号）会改 devicePixelRatio，但只监听 window.resize
      // 在个别路径上不一定收到。这里每次 resize 都重算一遍，保证缩放后不会变糊
      //（Live2D / 3D 那边也是这么处理的）。
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.canvasEl.width = Math.floor(this.w * this.dpr);
      this.canvasEl.height = Math.floor(this.h * this.dpr);
      this.canvasEl.style.width = `${this.w}px`;
      this.canvasEl.style.height = `${this.h}px`;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this._seedParticles();
      if (this.current && this.current.kind !== 'procedural') this._stop();
      else if (this.current) this._drawOnce();
    }

    /** 切换背景。item 可以是 null（等同纯色） */
    set(item) {
      this.current = item || { kind: 'procedural', renderer: 'plain', palette: [] };
      this._stop();
      this.ctx.clearRect(0, 0, this.w, this.h);

      if (this.current.kind === 'video' && this.videoEl) {
        // 视频铺：canvas 与 <img> 都让开
        this.canvasEl.style.opacity = '0';
        this.imageEl.style.opacity = '0';
        this.imageEl.removeAttribute('src');
        this._setVideo(this.current.url);
        return;
      }
      // 从视频切走时要把视频停掉 —— 只把 opacity 设成 0 的话，
      // 它还在后台解码播放，白烧 CPU/GPU（大屏上尤其明显）
      this._stopVideo();

      if (this.current.kind === 'image') {
        // 图片交给 <img> 铺，canvas 完全让开，省一次绘制
        this.canvasEl.style.opacity = '0';
        this.imageEl.style.opacity = '1';
        this.imageEl.src = this.current.url;
        return;
      }

      this.imageEl.style.opacity = '0';
      this.imageEl.removeAttribute('src');
      this.canvasEl.style.opacity = '1';
      this._seedParticles();
      if (prefersReduced()) { this._drawOnce(0); return; }
      this._start();
    }

    /* ---------------- 视频背景 ---------------- */

    /** 装载并播放一个视频；同一个地址不重复重载（重载会闪一下黑） */
    _setVideo(url) {
      const v = this.videoEl;
      if (!v || !url) return;
      if (this._videoUrl !== url) {
        this._videoUrl = url;
        v.src = url;
        try { v.load(); } catch { /* 个别浏览器对空 src 会抛，忽略 */ }
      }
      v.style.opacity = '1';
      // 尊重"减少动态效果"：把首帧停在那儿当静态背景用，而不是让它在旁边转
      if (prefersReduced()) {
        try { v.pause(); v.currentTime = 0; } catch { /* 忽略 */ }
        return;
      }
      // 自动播放策略：必须 muted（已在 HTML 上设好），否则浏览器会拒绝 play()
      const p = v.play();
      if (p && p.catch) {
        p.catch((e) => {
          // 真被拒了也别让用户对着一片黑：报一声，并回落到当前已有的画面
          console.warn('[backgrounds] 视频背景自动播放被拒绝：', e && e.message);
        });
      }
    }

    _stopVideo() {
      const v = this.videoEl;
      if (!v) return;
      try { v.pause(); } catch { /* 忽略 */ }
      v.style.opacity = '0';
    }

    /** 跟随角色卡主色：只换调色板，不换形状 */
    setPalette(colors) {
      if (!this.current || this.current.kind !== 'procedural' || !colors || !colors.length) return;
      this.current = { ...this.current, palette: colors };
      this.ctx.clearRect(0, 0, this.w, this.h);
      this._seedParticles();
      if (prefersReduced()) this._drawOnce(0);
    }

    _seedParticles() {
      const p = (this.current && this.current.palette) || [];
      const kind = this.current && this.current.renderer;
      const rand = rng(20260915);
      this.particles = [];

      if (kind === 'sakura') {
        // 花瓣数量按面积算，保证大屏小屏密度观感一致。
        // 上限原来是 90 —— 那在小屏（938×800 ≈ 0.75M px²，算出来 31 片）够用，
        // 但 4K 全屏（约 6.9M px²）本该 287 片却被截到 90，密度只剩小屏的三成，
        // 看起来"稀稀拉拉、没铺满"，这其实就是"大屏不支持"的真正原因。
        // 背景每帧开销很低（实测关掉它帧率只涨 1fps），放宽上限不会拖慢。
        const n = Math.round(Math.min(420, Math.max(24, (this.w * this.h) / 24000)));
        for (let i = 0; i < n; i++) {
          this.particles.push({
            x: rand() * this.w,
            y: rand() * this.h,
            r: 5 + rand() * 7,
            vy: 12 + rand() * 26,           // px/s
            sway: 14 + rand() * 30,
            phase: rand() * Math.PI * 2,
            rot: rand() * Math.PI * 2,
            vr: (rand() - 0.5) * 1.6,
            alpha: 0.35 + rand() * 0.5,
            color: p[i % Math.max(1, p.length)] || '#f9a8d4',
          });
        }
      } else if (kind === 'stars') {
        // 同理：上限从 220 提到 900。4K 全屏按面积该有 764 颗，原来被截到 220，
        // 星空看着就像"只有几粒"，和小屏完全不是一个观感。
        const n = Math.round(Math.min(900, Math.max(60, (this.w * this.h) / 9000)));
        for (let i = 0; i < n; i++) {
          this.particles.push({
            x: rand() * this.w,
            y: rand() * this.h,
            r: 0.4 + rand() * 1.5,
            vx: (rand() - 0.5) * 4,
            vy: (rand() - 0.5) * 4,
            tw: rand() * Math.PI * 2,
            tws: 0.6 + rand() * 1.8,
            color: p[i % Math.max(1, p.length)] || '#e2e8f0',
          });
        }
      }
    }

    _start() {
      if (this.raf) return;
      const loop = (now) => {
        this.raf = requestAnimationFrame(loop);
        if (this.paused) return;
        this._drawOnce((now - this.t0) / 1000);
      };
      this.raf = requestAnimationFrame(loop);
    }

    _stop() {
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = null; }
    }

    _drawOnce(t = 0) {
      const { ctx, w, h } = this;
      const item = this.current;
      if (!item || item.kind !== 'procedural') return;
      const p = item.palette && item.palette.length ? item.palette : ['#7dd3fc', '#a78bfa', '#f472b6'];
      ctx.clearRect(0, 0, w, h);
      const fn = this['_' + (item.renderer || 'plain')];
      if (typeof fn === 'function') fn.call(this, ctx, w, h, p, t);
    }

    /* ---------------- 各个程序化背景 ---------------- */

    /**
     * 西湖美景（本项目默认背景）。
     *
     * 绘制逻辑放在 public/js/lake.js 里，因为它和「西湖船娘」形象是同一条主题线上
     * 的东西（同一套配色、同一份对西湖的理解），分成两处迟早会漂移。
     *
     * 这一条的存在意义：用户手上还没有西湖宣传片时，背景不能是一片黑 ——
     * 程序化画出来的西湖动态画面就是这个位置上的兜底，而且它完全离线、不吃素材。
     */
    _lake(ctx, w, h, _palette, t) {
      if (window.WenlvLake && window.WenlvLake.drawLakeScene) {
        window.WenlvLake.drawLakeScene(ctx, w, h, t, '西湖');
      }
    }

    /** 极光渐变：几个大色斑缓慢漂移 + 叠加发光（对应 AIRI 的默认色相流动） */
    _aurora(ctx, w, h, p, t) {
      ctx.fillStyle = '#0b0d10';
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';
      const blobs = [
        { x: 0.24, y: 0.28, r: 0.62, sp: 0.055, ph: 0 },
        { x: 0.76, y: 0.70, r: 0.58, sp: -0.041, ph: 2.1 },
        { x: 0.56, y: 0.16, r: 0.44, sp: 0.033, ph: 4.0 },
      ];
      blobs.forEach((b, i) => {
        const cx = (b.x + Math.sin(t * b.sp + b.ph) * 0.09) * w;
        const cy = (b.y + Math.cos(t * b.sp * 0.8 + b.ph) * 0.07) * h;
        const r = b.r * Math.max(w, h) * 0.55;
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        const c = p[i % p.length];
        g.addColorStop(0, hexA(c, 0.34));
        g.addColorStop(1, hexA(c, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      });
      ctx.globalCompositeOperation = 'source-over';
    }

    /** 动态波浪：三层正弦波错速流动（对应 AIRI 的 part-animated-wave） */
    _wave(ctx, w, h, p, t) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#0a1014');
      g.addColorStop(1, '#0d1b1f');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      const layers = [
        { amp: 0.055, base: 0.62, k: 1.1, sp: 0.30, a: 0.30 },
        { amp: 0.075, base: 0.72, k: 0.8, sp: -0.20, a: 0.26 },
        { amp: 0.095, base: 0.84, k: 0.6, sp: 0.13, a: 0.34 },
      ];
      layers.forEach((L, i) => {
        ctx.beginPath();
        ctx.moveTo(0, h);
        // 采样步长跟着宽度走。原来固定 6px：大屏上要多算好几倍的 lineTo，
      // 曲线本身很平滑、用不着那么密。按宽度取步长能让各尺寸下平滑度一致
      //（每个波长约 200 个采样点），同时省掉大屏上的无用计算。
      const stepX = Math.max(4, w / 260);
      for (let x = 0; x <= w; x += stepX) {
          const u = x / w;
          const y = (L.base + Math.sin(u * Math.PI * 2 * L.k + t * L.sp) * L.amp
            + Math.sin(u * Math.PI * 2 * L.k * 2.3 + t * L.sp * 1.7) * L.amp * 0.35) * h;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = hexA(p[i % p.length], L.a);
        ctx.fill();
      });
    }

    /** 樱花飘落：花瓣带旋转 + 横向摆动（对应 AIRI 的 SakuraPetal） */
    _sakura(ctx, w, h, p, t) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#1a1420');
      g.addColorStop(1, '#2a1c26');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      const dt = 1 / 60;
      for (const q of this.particles) {
        q.y += q.vy * dt;
        q.rot += q.vr * dt;
        if (q.y - q.r > h) { q.y = -q.r * 2; q.x = Math.random() * w; }
        const x = q.x + Math.sin(q.phase + t * 0.9) * q.sway;
        ctx.save();
        ctx.translate(x, q.y);
        ctx.rotate(q.rot);
        ctx.globalAlpha = q.alpha;
        ctx.fillStyle = q.color;
        // 一片花瓣：两个对称的贝塞尔弧
        ctx.beginPath();
        ctx.moveTo(0, -q.r);
        ctx.bezierCurveTo(q.r * 0.9, -q.r * 0.5, q.r * 0.7, q.r * 0.7, 0, q.r);
        ctx.bezierCurveTo(-q.r * 0.7, q.r * 0.7, -q.r * 0.9, -q.r * 0.5, 0, -q.r);
        ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }

    /** 夜空星野：缓慢漂移 + 呼吸式闪烁 */
    _stars(ctx, w, h, p, t) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#05070d');
      g.addColorStop(0.6, '#0a1020');
      g.addColorStop(1, '#111827');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      const dt = 1 / 60;
      for (const s of this.particles) {
        s.x = (s.x + s.vx * dt + w) % w;
        s.y = (s.y + s.vy * dt + h) % h;
        const tw = 0.55 + 0.45 * Math.sin(t * s.tws + s.tw);
        ctx.globalAlpha = tw;
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    /** 十字点纹：静态几何底纹（对应 AIRI 的 pattern-cross） */
    _cross(ctx, w, h, p, t) {
      ctx.fillStyle = '#101216';
      ctx.fillRect(0, 0, w, h);
      // 格距跟着舞台尺寸缩放。固定 26px 在小屏（约 938×800）上刚好，
      // 但 4K 全屏（约 3338×2060）上格子会相对变小、显得比小屏密得多。
      // 以短边为基准，26px 对应约 800 的高度。
      const step = Math.max(26, Math.min(w, h) * 0.0325);
      ctx.strokeStyle = hexA(p[0] || '#94a3b8', 0.16);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= w; x += step) {
        for (let y = 0; y <= h; y += step) {
          ctx.moveTo(x - 3, y); ctx.lineTo(x + 3, y);
          ctx.moveTo(x, y - 3); ctx.lineTo(x, y + 3);
        }
      }
      ctx.stroke();
      // 叠一层中心暗角，让中间的人物更突出
      const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.1, w / 2, h / 2, Math.max(w, h) * 0.72);
      v.addColorStop(0, 'rgba(0,0,0,0)');
      v.addColorStop(1, 'rgba(0,0,0,0.55)');
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, w, h);
    }

    /** 山水青绿：远近三层山脊 + 晨雾（文旅主色） */
    _shanshui(ctx, w, h, p, t) {
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#04121a');
      sky.addColorStop(0.55, '#0a2430');
      sky.addColorStop(1, '#0d3a3a');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);

      // 一轮淡月
      ctx.fillStyle = 'rgba(226,240,255,0.10)';
      ctx.beginPath();
      ctx.arc(w * 0.76, h * 0.20, Math.min(w, h) * 0.075, 0, Math.PI * 2);
      ctx.fill();

      const ridges = [
        { base: 0.58, amp: 0.07, k: 1.7, a: 0.55, c: p[0] },
        { base: 0.68, amp: 0.05, k: 2.6, a: 0.65, c: p[1] },
        { base: 0.80, amp: 0.035, k: 3.4, a: 0.85, c: p[2] },
      ];
      ridges.forEach((R, i) => {
        ctx.beginPath();
        ctx.moveTo(0, h);
        const stepX = Math.max(4, w / 300);   // 采样步长同上，按宽度缩放
        for (let x = 0; x <= w; x += stepX) {
          const u = x / w;
          const y = (R.base
            + Math.sin(u * Math.PI * 2 * R.k + i * 1.7) * R.amp
            + Math.sin(u * Math.PI * 2 * R.k * 0.5 + i) * R.amp * 0.6) * h;
          ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = hexA(R.c, R.a);
        ctx.fill();
      });

      // 晨雾：几条横向的柔和白带，缓慢左右漂
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 3; i++) {
        const y = h * (0.60 + i * 0.09);
        const off = Math.sin(t * 0.08 + i) * w * 0.06;
        const g = ctx.createLinearGradient(0, y - h * 0.05, 0, y + h * 0.05);
        g.addColorStop(0, 'rgba(190,235,235,0)');
        g.addColorStop(0.5, `rgba(190,235,235,${0.055 - i * 0.012})`);
        g.addColorStop(1, 'rgba(190,235,235,0)');
        ctx.fillStyle = g;
        ctx.fillRect(off - w * 0.1, y - h * 0.05, w * 1.2, h * 0.1);
      }
      ctx.globalCompositeOperation = 'source-over';
    }

    /** 暖金黄昏：落日渐变 + 地平线光晕 */
    _sunset(ctx, w, h, p, t) {
      const sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#1b1030');
      sky.addColorStop(0.45, hexA(p[2], 0.55));
      sky.addColorStop(0.72, hexA(p[1], 0.75));
      sky.addColorStop(1, hexA(p[0], 0.95));
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);

      const cx = w * 0.5;
      const cy = h * 0.82;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.5);
      g.addColorStop(0, 'rgba(255,236,190,0.55)');
      g.addColorStop(0.25, hexA(p[0], 0.28));
      g.addColorStop(1, 'rgba(255,200,120,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);

      // 水面：几条横向亮线，缓慢晃动
      ctx.globalAlpha = 0.18;
      ctx.strokeStyle = 'rgba(255,240,210,0.8)';
      for (let i = 0; i < 7; i++) {
        const y = h * (0.84 + i * 0.022);
        ctx.lineWidth = 1 + i * 0.25;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 8) {
          ctx.lineTo(x, y + Math.sin(x * 0.02 + t * (0.5 + i * 0.2)) * (1 + i * 0.5));
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    /** 宣纸留白：浅色纸纹，对比度最高，适合截图 */
    _paper(ctx, w, h, p, t) {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#fbfaf7');
      g.addColorStop(0.5, p[0] || '#f5f5f4');
      g.addColorStop(1, '#efece6');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      // 纤维噪点：用固定种子画一次就够（这里是每帧重画的，所以点极少、代价可忽略）
      const rand = rng(777);
      ctx.strokeStyle = 'rgba(120,110,95,0.05)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < 260; i++) {
        const x = rand() * w;
        const y = rand() * h;
        const len = 4 + rand() * 16;
        const ang = rand() * Math.PI;
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len);
      }
      ctx.stroke();
      const v = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.75);
      v.addColorStop(0, 'rgba(255,255,255,0)');
      v.addColorStop(1, 'rgba(180,170,150,0.18)');
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, w, h);
    }

    /** 纯色：什么都不画，露出 CSS 主题底色 */
    _plain(ctx, w, h) {
      ctx.clearRect(0, 0, w, h);
    }

    destroy() {
      this._stop();
      this._stopVideo();
      if (this.videoEl) {
        // 清 src 并重新 load，才能真正把解码器与网络请求放掉。
        // 只 pause 的话，某些浏览器会一直攥着这段视频的缓冲。
        try { this.videoEl.removeAttribute('src'); this.videoEl.load(); } catch { /* 忽略 */ }
      }
      window.removeEventListener('resize', this._onResize);
      clearTimeout(this._resizeTimer);
      if (this._ro) { this._ro.disconnect(); this._ro = null; }
    }
  }

  /**
   * 静态渲染一帧到指定 canvas —— 给背景选择器的缩略图用。
   * 选择器里一次要显示十几个背景，如果每个都跑动画，GPU 会被白白吃掉；
   * 所以这里只画一帧（t 取 0.9 而不是 0，让极光/波浪这类背景停在有内容的位置）。
   */
  BackgroundManager.renderStatic = function renderStatic(canvas, item, w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!item || item.kind === 'image') {
      ctx.clearRect(0, 0, w, h);
      return;
    }
    const palette = item.palette && item.palette.length ? item.palette : ['#7dd3fc', '#a78bfa', '#f472b6'];

    // 借一个最小可用的实例来复用绘制方法：不挂监听、不起 rAF
    const stub = Object.create(BackgroundManager.prototype);
    stub.canvasEl = canvas;
    stub.ctx = ctx;
    stub.imageEl = document.createElement('img');
    stub.w = w;
    stub.h = h;
    stub.dpr = dpr;
    stub.t0 = 0;
    stub.paused = true;
    stub.current = { ...item, palette };
    stub._seedParticles();
    stub._drawOnce(0.9);
  };

  /** #rrggbb -> rgba(...)，用于把角色卡主色套到背景上 */
  function hexA(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return `rgba(255,255,255,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  window.BackgroundManager = BackgroundManager;
})();
