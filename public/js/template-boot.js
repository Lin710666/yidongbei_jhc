/* ============================================================================
 * template-boot.js —— 模板判定 + Live2D 运行时按需注入
 *
 * 必须在**所有其它脚本之前**同步执行（所以没写 defer）：
 * 它要赶在 app.js 起来之前把 `body.focus` / `body.guide` 定下来，
 * 否则会先按"有人物"画一帧、再跳成"没人物"，用户能看见闪一下。
 *
 * 两个职责：
 *   1. 读模板设置（默认 focus = 不启用人物），同步打好 body 类
 *   2. **按需注入 Live2D 运行时** —— 默认不注入。
 *      这样"不用人物"的用户连 PixiJS 都不下载（约 400KB）。
 *      需要时（启动即 guide，或用户点「启用人物」）调 ensureLive2DRuntime()。
 *
 * 为什么不用 `<script defer src=...>`：
 *   静态标签一定会下载。而"默认不用人物"这个需求的重点就是**不下**。
 * ==========================================================================*/
(function () {
  'use strict';

  var TEMPLATE_KEY = 'wenlv.template';
  var LEGACY_HIDE_KEY = 'wenlv.avatarHidden';

  /** 读模板。默认 focus（需求方要求默认不启用人物）。 */
  function readTemplate() {
    try {
      var v = localStorage.getItem(TEMPLATE_KEY);
      if (v === 'guide' || v === 'focus') return v;
      // 老用户曾经把人物设成隐藏 —— 那意图就是"不想看人物"，迁移到 focus
      if (localStorage.getItem(LEGACY_HIDE_KEY) === '1') return 'focus';
    } catch (e) { /* 隐私模式等，按默认走 */ }
    return 'focus';                      // ★ 默认：不启用人物
  }

  var current = readTemplate();

  // 同步打类：越早越好，避免"先画人物再切成没有人"的闪烁
  function paint(name) {
    current = (name === 'guide') ? 'guide' : 'focus';
    var cl = document.body.classList;
    cl.toggle('focus', current === 'focus');
    cl.toggle('guide', current === 'guide');
    cl.toggle('avatar-hidden', current === 'focus');   // 兼容旧类
    window.__WENLV_TEMPLATE__ = current;
  }
  // body 可能还没解析出来（脚本在 head 里），两个时机都试一次
  if (document.body) paint(current);
  else document.addEventListener('DOMContentLoaded', function () { paint(current); }, { once: true });

  /* ---------------------------------------------------------------- 运行时注入 */
  //: 顺序有意义：Cubism 核心必须先于 pixi-live2d-display。
  var RUNTIME = [
    '/vendor/live2dcubismcore.min.js',
    '/vendor/pixi.min.js',
    '/vendor/pixi-live2d-display-cubism4.min.js',
  ];
  var injecting = null;

  function injectOne(src) {
    return new Promise(function (res, rej) {
      // 已经加载过就直接过（按 src 找，不看 window 上有没有，因为
      // cubismcore 是 Emscripten 模块，window 上未必有显眼的标志）
      var hit = document.querySelector('script[data-wenlv-runtime="' + src + '"]');
      if (hit) { res(); return; }
      var s = document.createElement('script');
      s.src = src;
      s.async = false;                   // 保持插入顺序执行
      s.dataset.wenlvRuntime = src;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('加载失败: ' + src)); };
      document.head.appendChild(s);
    });
  }

  /**
   * 确保 Live2D 运行时可用。可重复调用（内部缓存 promise）。
   * @returns {Promise<boolean>} 是否可用
   */
  function ensureLive2DRuntime() {
    if (injecting) return injecting;
    injecting = (async function () {
      for (var i = 0; i < RUNTIME.length; i++) await injectOne(RUNTIME[i]);
      return !!(window.PIXI && window.PIXI.live2d);
    })().catch(function (e) {
      injecting = null;                  // 失败允许重试
      console.warn('[template] 运行时注入失败：', e && e.message ? e.message : e);
      return false;
    });
    return injecting;
  }

  // 启动时就是 guide → 立刻注入（用户要看人物，这一步跑不掉）
  if (current === 'guide') ensureLive2DRuntime();

  window.WenlvTemplate = {
    get: function () { return current; },
    isFocus: function () { return current === 'focus'; },
    /** 只切类与存储，不碰运行时；要连运行时一起就调 activate() */
    paint: paint,
    ensureLive2DRuntime: ensureLive2DRuntime,
    set: function (name) {
      current = (name === 'guide') ? 'guide' : 'focus';
      try {
        localStorage.setItem(TEMPLATE_KEY, current);
        localStorage.removeItem(LEGACY_HIDE_KEY);
      } catch (e) { /* 忽略 */ }
      return current;
    },
  };
})();
