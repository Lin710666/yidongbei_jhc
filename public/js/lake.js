/* ============================================================================
 * lake.js —— 西湖风景（动态、程序化绘制）
 *
 * ## 这里为什么是"画"出来的
 *
 * 项目需要一个"西湖"的视觉底子：开屏的整屏宣传片背景、以及「西湖」这个背景选项，
 * 都用它。走渲染图/视频太重（几十 MB、还要授权），而西湖的形是可以用几何描出来的 ——
 * 三面云山、一堤两塔、湖面反光加一层雾。所以这里用 Canvas 2D 现画：
 * 零外部素材、零授权风险、任意分辨率都不糊（矢量绘制，不是位图缩放）。
 *
 * ## 谁在用
 *   · backgrounds.js —— 背景列表里的「西湖」这一项
 *   · boot.js        —— 开屏在视频清单还没回来时，先用它顶上，不至于白屏
 *
 * 入口只有一个：`drawLakeScene(ctx, w, h, t, key)`，t 是秒数，key 是景点名
 * （决定用哪套配色 / 构图）。它是纯函数式的绘制，不持有状态、不依赖 DOM。
 *
 * ## 曾经还有个「西湖船娘」形象
 *
 * 本文件原来还导出一个 LakeAvatar 类（程序化画的人物，代号 lake-boatwoman，
 * 形象列表里叫「江南古风少女」）。那个形象**已经删掉了**（形象列表里不再提供，
 * 卡片也不再指向它）—— 上面那段"为什么画而不是找模型"的说辞是它当年留下的，
 * 现在风景这部分仍然适用，所以保留改写版，不再提它。
 *
 * 要换人物形象请用 Live2D 或 3D：外观页的「更换形象」即可。
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

  // 只导出风景。
  // 「江南古风少女」(lake-boatwoman) 那套人物形象**已经整个删掉**了 ——
  // 不是"从列表里摘掉"而是连类和它的工具函数一起删的（形象列表、卡片、
  // app.js 的分支都清了）。这个文件现在只管画西湖的景。
  window.WenlvLake = { drawLakeScene, COLORS: C };
})();
