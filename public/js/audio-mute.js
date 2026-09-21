/* ============================================================================
 * audio-mute.js —— 全局静音中枢
 *
 * ## 为什么要有这一层
 *
 * 这个项目有两套界面，各自有独立的声音，而且**互不知情**：
 *
 *   · 开屏（主页）：`#boot-video` 自己出声，`#boot-mute` 按钮只管它
 *   · 功能页      ：背景视频恒静音（自动播放的硬性前提），真正出声的是
 *                   配乐 `#bg-audio`（bg-audio.js 建的）与朗读 `#tts-audio`
 *
 * 结果是：在主页点了静音，进功能页配乐照响；在功能页想让声音停掉，
 * 却没有任何入口 —— 只有主页那一个按钮，进了功能页就够不着了。
 *
 * 这一层把"静音"做成**一个状态**，任何一处切换，所有声音一起跟着变：
 *
 *   · `apply(el)`     把当前静音状态套到某个媒体元素上（并接管它，之后自动跟随）
 *   · `register(el)`  登记一个常驻元素（幂等，可反复调）
 *   · `onChange(fn)`  订阅状态变化，用来同步各处按钮的样子
 *
 * ## 为什么不直接给 `#bg-video` 开声音
 *
 * 去不掉：浏览器只允许"静音的视频"自动播放。背景视频一旦不静音，
 * 自动播放会被直接拒绝，背景就黑了。所以它**永远保持静音**，
 * 功能页的声音由配乐与朗读负责，两者才是静音键该管的对象。
 * ==========================================================================*/

(function () {
  'use strict';

  var KEY = 'wenlv.muted';

  /**
   * 当前是否静音。**默认静音**。
   *
   * 为什么默认静音：浏览器本来就不允许带声音的自动播放，开屏视频必然是静音起播；
   * 而配乐如果选了音轨，一进页面就会开始放 —— 用户还没按任何东西，声音先出来了。
   * 统一成"默认不出声，要听就点一下声音键"，行为最可预期
   * （开屏底部那个「点击开启声音」、以及功能页工具排里的声音键都行）。
   * 用户显式选过之后就按他选的来（localStorage 记住）。
   */
  var muted = true;
  /** 本地是否已经有用户选过的记录。用来决定"服务端偏好"要不要覆盖本地选择。 */
  var localChoice = false;
  try {
    var saved = localStorage.getItem(KEY);
    if (saved === '1') { muted = true; localChoice = true; }
    else if (saved === '0') { muted = false; localChoice = true; }
  } catch (e) { /* 隐私模式下 localStorage 会抛，忽略 */ }

  /** 已接管的元素。用真 Set（不是 WeakSet）—— syncAll 要遍历它们，
   *  才能把每个元素各自的 keepMuted 选项带下去。 */
  var managed = [];
  /** 订阅者 */
  var listeners = [];

  /**
   * 当前在哪个界面：'boot'（开屏/主页）或 'main'（功能页）。
   *
   * 为什么需要它：开屏上**只有开屏宣传片该出声**；功能页的背景配乐
   * （#bg-audio）如果这时也播着，两路音频就会叠在一起 —— 实测「开屏点开声音」
   * 后 boot-video 与 bg-audio 同时 audible，听感就是"有重音"。
   * 所以按界面对媒体分流：开屏期间暂停配乐，回到功能页再恢复。
   */
  var scene = 'main';

  function save() {
    try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (e) { /* 忽略 */ }
  }

  /**
   * 把一个媒体元素纳入静音管理。
   * 之后每次切换静音，它都会被自动同步。
   * @param {HTMLMediaElement} el
   * @param {{keepMuted?: boolean}} [opt] keepMuted=true 表示该元素永远静音
   *        （背景视频用：它出声会导致自动播放被拒）
   */
  function apply(el, opt) {
    if (!el) return;
    var keepMuted = !!(opt && opt.keepMuted);
    // ★ 不要写 `el.dataset = el.dataset || {}`：dataset 是**只读属性**，
    //   整赋值会抛 "Cannot set property dataset"，把后面的同步全带崩。
    //   它是 DOMStringMap，直接挂键上去就行。
    if (keepMuted) el.dataset.muteKeep = '1';
    if (managed.indexOf(el) < 0) managed.push(el);
    sync(el);
  }

  /** 同步单个元素 */
  function sync(el) {
    if (!el) return;
    var keepMuted = el.dataset && el.dataset.muteKeep === '1';
    var want = keepMuted ? true : muted;
    try {
      el.muted = want;
      // 只改 muted 有时会留下极小音量，取消静音时顺手恢复满音量
      if (!want) el.volume = 1;
    } catch (e) { /* 忽略 */ }
  }

  /** 把状态刷到所有已接管元素上；顺带按选择器兜一遍页面上新出现的元素 */
  function syncAll() {
    // ① 已接管的：会带上各自的 keepMuted（背景视频必须永远静音）
    for (var i = managed.length - 1; i >= 0; i--) {
      var el = managed[i];
      // 元素已从文档移除（例如开屏被销毁）就顺手清掉，避免数组无限增长
      if (el && el.isConnected === false) { managed.splice(i, 1); continue; }
      sync(el);
    }
    // ② 兜底：选择器命中的、但还没登记过的元素（例如 bg-audio.js 刚建出来的）
    var sel = ['#boot-video', '.boot-video-bg', '#bg-video', '#bg-audio', '#tts-audio'];
    for (var s = 0; s < sel.length; s++) {
      var nodes = document.querySelectorAll(sel[s]);
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (managed.indexOf(n) < 0) { apply(n); } else { sync(n); }
      }
    }
    // ③ 分场景：开屏期间不让配乐出声（否则和开屏宣传片叠成两路声音）
    var bgAudio = document.querySelector('#bg-audio');
    if (bgAudio) {
      if (scene === 'boot') {
        // 暂停但**不换源**：回到功能页时 apply() 会按当前选中的音轨恢复
        try { bgAudio.pause(); } catch (e) { /* 忽略 */ }
      } else if (bgAudio.paused && bgAudio.getAttribute('src') && !muted) {
        // 回到功能页且没静音、且已选过音轨 → 恢复播放
        var pr = bgAudio.play();
        if (pr && pr.catch) pr.catch(function () { /* 自动播放被拒，等用户点一下 */ });
      }
    }
  }

  /**
   * 切换界面场景。开屏 show() 时传 'boot'，回到功能页时传 'main'。
   * 只影响"哪一路该出声"，不改变用户的静音选择。
   */
  function setScene(which) {
    var next = which === 'boot' ? 'boot' : 'main';
    if (next === scene) return scene;
    scene = next;
    syncAll();
    return scene;
  }

  function notify() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](muted); } catch (e) { /* 单个订阅者出错不影响其它 */ }
    }
  }

  /**
   * 切换静音。
   * @param {boolean} [next] 不传则翻转
   * @returns {boolean} 切换后的状态
   */
  function set(next) {
    muted = (typeof next === 'boolean') ? next : !muted;
    localChoice = true;      // 一旦用户/程序设定过，就不再让服务端偏好覆盖
    save();
    syncAll();
    notify();
    return muted;
  }

  /**
   * 给一个 <audio> / <video> 挂上静音状态。
   * 用法：把 `el.muted = ...` 换成 `Mute.apply(el)`；
   * 元素是"临时造的"（例如试听）也要调一次，否则它会无视全局静音。
   */
  function register(el, opt) {
    apply(el, opt);
    return el;
  }

  /** 订阅状态变化，返回取消订阅的函数 */
  function onChange(fn) {
    if (typeof fn !== 'function') return function () {};
    listeners.push(fn);
    try { fn(muted); } catch (e) { /* 忽略 */ }
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /**
   * 造一个静音按钮，自动跟随状态更新外观。
   * 两处（收纳栏 / 调试区）都用它，样子与语义天然一致，不会各写一套。
   */
  function button(className, extraClass) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = [className, extraClass].filter(Boolean).join(' ');
    b.setAttribute('data-mute-btn', '1');
    refreshBtn(b, muted);
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      set();
    });
    onChange(function (m) { refreshBtn(b, m); });
    return b;
  }

  function refreshBtn(b, m) {
    if (!b) return;
    b.textContent = m ? '🔇 静音' : '🔊 有声';
    b.title = m ? '当前静音，点击开启声音' : '当前有声，点击静音';
    b.setAttribute('aria-pressed', m ? 'false' : 'true');
    b.classList.toggle('on', !m);
  }

  window.WenlvMute = {
    isMuted: function () { return muted; },
    hasLocalChoice: function () { return localChoice; },
    set: set,
    setScene: setScene,
    scene: function () { return scene; },
    toggle: function () { return set(); },
    apply: apply,
    register: register,
    onChange: onChange,
    syncAll: syncAll,
    button: button,
    KEY: KEY,
  };
})();
