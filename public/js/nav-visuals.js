/* ============================================================================
 * nav-visuals.js —— 导航模式的两种画面：手里的木牌、身后的风景
 *
 * 为什么单独放一个文件：Live2D 用 PixiJS、3D 用 three.js，两套渲染器的对象模型
 * 完全不同，但"牌子长什么样""风景怎么画"是**纯粹的 2D 绘制**，跟渲染器无关。
 * 两边各写一份的话，改个木头颜色要改两处，迟早只改一处。
 *
 * 这里全部用离屏 canvas 的 2D context 画，再由调用方决定怎么用：
 *   · Live2D —— Texture.from(canvas) 变成 Pixi 纹理
 *   · 3D     —— CanvasTexture 贴到平面上
 *
 * 另一个刻意的设计：牌子和风景都是**现画的**，不引用任何图片素材。
 * VTube Studio 的 Items 目录里确实有现成的木牌 PNG，但那是第三方作者的作品
 * （文件名里带着 @ 署名），拷进项目里用不合适。程序化画一张则完全没有这个问题，
 * 顺带还省掉了联网下载和离线可用性的麻烦。
 * ==========================================================================*/
(function () {
  'use strict';

  /** 中文字体栈：不显式给的话，某些环境会落到没有中文字形的字体上，字变成方框 */
  const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", "SimHei", sans-serif';

  // roundRect 是较新的 API（Chrome 99+/Safari 16+）。缺了不做兜底的话，
  // 牌子和风景会整块画不出来，而且**不报错** —— 只是白板一块，很难查。
  if (typeof CanvasRenderingContext2D !== 'undefined'
      && !CanvasRenderingContext2D.prototype.roundRect) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      const rr = Math.min(typeof r === 'number' ? r : 0, w / 2, h / 2);
      this.moveTo(x + rr, y);
      this.arcTo(x + w, y, x + w, y + h, rr);
      this.arcTo(x + w, y + h, x, y + h, rr);
      this.arcTo(x, y + h, x, y, rr);
      this.arcTo(x, y, x + w, y, rr);
      this.closePath();
      return this;
    };
  }

  /** 用字符串做一个稳定的 32 位种子，让同一个景点每次画出同一张风景 */
  function seedOf(str) {
    let s = 0;
    const t = String(str || '');
    for (let i = 0; i < t.length; i++) s = (s * 31 + t.charCodeAt(i)) >>> 0;
    return s;
  }

  function makeRnd(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }

  /** 建一张离屏 canvas 并返回 2D context */
  function surface(w, h) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w));
    cv.height = Math.max(1, Math.round(h));
    return cv;
  }

  /**
   * 画一块举着的木牌。
   *
   * 牌面按 300×170 的逻辑尺寸画，木杆画在下方 —— 调用方直接整体缩放即可，
   * 不用关心尺寸。回传的 canvas 里已经包含木杆。
   *
   * @param {string} text  牌面上的字（就是上一次的导航项目）
   * @returns {HTMLCanvasElement}
   */
  function drawPlacard(text, opts = {}) {
    const W = 300;
    const H = 170;
    const POLE = 130;
    const cv = surface(W, H + POLE);
    const g = cv.getContext('2d');
    if (!g) return cv;

    const label = String(text || '').trim();
    const scale = opts.scale || 2;          // 画大一点再缩下去，边缘才不糊
    cv.width = W * scale;
    cv.height = (H + POLE) * scale;
    g.scale(scale, scale);

    // 木杆：先画，让它垫在牌面下面（看起来像钉在牌子背后）
    g.fillStyle = '#6d4a28';
    g.beginPath();
    g.roundRect(W / 2 - 9, H - 8, 18, POLE + 8, 6);
    g.fill();
    // 杆上的高光，一根竖线就够了，多了显脏
    g.fillStyle = 'rgba(255,225,180,0.18)';
    g.fillRect(W / 2 - 6, H - 4, 4, POLE);

    // 牌面：深棕描边 + 木色底
    g.fillStyle = '#5d3f24';
    g.beginPath();
    g.roundRect(0, 0, W, H, 12);
    g.fill();
    g.fillStyle = '#8b6239';
    g.beginPath();
    g.roundRect(5, 5, W - 10, H - 10, 9);
    g.fill();

    // 木纹：几条深浅不一的横线
    g.strokeStyle = 'rgba(93,63,36,0.35)';
    g.lineWidth = 1;
    for (let i = 1; i < 7; i++) {
      const y = (H / 7) * i;
      g.beginPath();
      g.moveTo(12, y);
      g.lineTo(W - 12, y);
      g.stroke();
    }

    // 四角圆钉
    g.fillStyle = '#3d2a17';
    for (const [dx, dy] of [[16, 16], [W - 16, 16], [16, H - 16], [W - 16, H - 16]]) {
      g.beginPath();
      g.arc(dx, dy, 4, 0, Math.PI * 2);
      g.fill();
    }

    // 字：自动折行，太长就缩字号，直到塞得下
    let size = 40;
    const maxW = W - 56;
    const maxH = H - 40;
    const lines = [];
    while (size >= 18) {
      lines.length = 0;
      g.font = `700 ${size}px ${FONT}`;
      let line = '';
      for (const ch of label) {
        const next = line + ch;
        if (g.measureText(next).width > maxW && line) { lines.push(line); line = ch; }
        else line = next;
      }
      if (line) lines.push(line);
      if (lines.length * size * 1.15 <= maxH) break;
      size -= 2;
    }
    if (!lines.length) lines.push('');
    g.font = `700 ${size}px ${FONT}`;
    g.fillStyle = '#2b1a0c';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const lh = size * 1.15;
    const startY = H / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, i) => g.fillText(ln, W / 2, startY + i * lh));

    return cv;
  }

  /**
   * 画一张风格化风景背景。
   *
   * 同一个景点名画出同一张图（种子取自名字），不同景点则天色与山形不同 ——
   * 否则"跟着景点换背景"这件事看起来像没生效。
   */
  function drawScenery(spot, city, w, h) {
    const key = String(city || spot || '');
    const seed = seedOf(key);
    const rnd = makeRnd(seed);
    const cv = surface(w, h);
    const g = cv.getContext('2d');
    if (!g) return cv;

    const hue = 195 + (seed % 60) - 30;     // 天色在青蓝到暖紫之间浮动

    // 天空
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, `hsl(${hue}, 55%, 20%)`);
    sky.addColorStop(0.45, `hsl(${hue - 12}, 48%, 44%)`);
    sky.addColorStop(0.72, `hsl(${hue - 28}, 42%, 63%)`);
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);

    // 太阳 + 光晕
    const sunX = w * (0.2 + rnd() * 0.6);
    const sunY = h * (0.18 + rnd() * 0.16);
    const halo = g.createRadialGradient(sunX, sunY, 0, sunX, sunY, h * 0.36);
    halo.addColorStop(0, 'rgba(255,236,190,0.85)');
    halo.addColorStop(0.25, 'rgba(255,210,150,0.30)');
    halo.addColorStop(1, 'rgba(255,200,140,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, w, h);
    g.beginPath();
    g.arc(sunX, sunY, h * 0.045, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,246,220,0.95)';
    g.fill();

    // 远山：三层，越近越暗，做出纵深
    const horizon = h * 0.68;
    for (let layer = 0; layer < 3; layer++) {
      const base = horizon - h * (0.16 - layer * 0.05);
      const amp = h * (0.10 - layer * 0.02);
      g.beginPath();
      g.moveTo(0, h);
      g.lineTo(0, base);
      const peaks = 4 + layer * 2;
      for (let i = 0; i <= peaks; i++) {
        const x = (w / peaks) * i;
        const y = base - Math.abs(Math.sin(i * 1.7 + layer * 2.3 + seed * 0.001)) * amp;
        g.lineTo(x, y);
      }
      g.lineTo(w, h);
      g.closePath();
      g.fillStyle = `hsla(${hue - 8}, ${Math.max(8, 38 - layer * 6)}%, ${30 - layer * 7}%, ${0.75 + layer * 0.08})`;
      g.fill();
    }

    // 水面：地平线以下压暗，加横向波纹与太阳倒影
    const water = g.createLinearGradient(0, horizon, 0, h);
    water.addColorStop(0, `hsla(${hue - 20}, 45%, 34%, 0.92)`);
    water.addColorStop(1, `hsla(${hue - 30}, 40%, 11%, 0.98)`);
    g.fillStyle = water;
    g.fillRect(0, horizon, w, h - horizon);
    for (let i = 0; i < 26; i++) {
      const y = horizon + (h - horizon) * (i / 26) + rnd() * 4;
      const rw = w * (0.08 + rnd() * 0.5);
      g.fillStyle = `rgba(255,240,210,${Math.max(0, 0.16 - i * 0.005)})`;
      g.fillRect(sunX - rw / 2, y, rw, Math.max(1, h * 0.0035));
    }

    // 暗角：人物通常是深色的，不加这层会跟背景糊在一起
    const vig = g.createRadialGradient(w / 2, h * 0.55, Math.min(w, h) * 0.25, w / 2, h * 0.55, Math.max(w, h) * 0.78);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = vig;
    g.fillRect(0, 0, w, h);

    return cv;
  }

  window.WenlvNavVisuals = { drawPlacard, drawScenery, seedOf, FONT };
})();
