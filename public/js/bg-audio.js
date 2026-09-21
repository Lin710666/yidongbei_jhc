/* ============================================================================
 * bg-audio.js —— 背景配乐：主界面的声音**只由这里决定**
 *
 * ## 为什么默认是"无声"而不是"视频原声"
 *
 * 背景视频是 `muted` 的 —— 那是浏览器允许自动播放的硬性前提，去不掉。
 * 所以"用视频原声"这条路根本走不通：视频不出声，也没有别的东西替它出声。
 * 与其摆一个选了却没声音的选项，不如如实叫「无声」，让声音来源只有一处：
 * 下面这个音轨列表（上传宣传片时后端会把音轨抽进 data/audio/，
 * 想要那段原声就在列表里选它）。
 *
 * ## 为什么用独立的 <audio> 而不是给视频换音轨
 *
 * 背景视频是 `muted` 的 —— 那是浏览器允许自动播放的硬性前提，去不掉。
 * 所以"自定义配乐"只能走另一条路：视频继续静音放着，配乐由独立的
 * <audio> 元素播。好处是两边互不干扰（换配乐不用重新加载视频），
 * 坏处是要自己对齐播放状态 —— 下面 play/pause/seek 都跟视频绑在一起了。
 * ==========================================================================*/

(function () {
  'use strict';

  var KEY = 'wenlv.bgAudio';       // 存的是音轨文件名；'' = 不放配乐（无声）

  var audioEl = null;
  var items = [];
  var chosen = '';

  function read() {
    try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; }
  }
  function write(v) {
    chosen = v || '';
    try { localStorage.setItem(KEY, chosen); } catch (e) { /* 忽略 */ }
  }

  function ensureEl() {
    if (audioEl) return audioEl;
    audioEl = document.createElement('audio');
    audioEl.id = 'bg-audio';
    audioEl.loop = true;
    audioEl.preload = 'auto';
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
    // 交给全局静音中枢：这样功能页的静音键（收纳栏 / 调试区）能管到配乐，
    // 开屏上的 🔊 也能一并管到 —— 以前配乐是完全不受静音键影响的。
    if (window.WenlvMute) window.WenlvMute.apply(audioEl);
    return audioEl;
  }

  /** 当前选中的那条音轨对象 */
  function current() {
    return items.filter(function (x) { return x.name === chosen; })[0] || null;
  }

  /** 找页面上的背景视频（主界面那条） */
  function bgVideo() {
    return document.getElementById('bg-video');
  }

  /**
   * 把配乐状态跟背景视频对齐。
   * - chosen 为空 → 停止配乐，主界面**无声**
   *   （注意：这里不会去给背景视频开声 —— 它必须保持 muted 才能自动播放，
   *     所以"无声"就是真的没有声音，不是"用视频原声"）
   * - chosen 有值 → 视频继续静音，配乐跟着视频播/停
   */
  function apply() {
    var v = bgVideo();
    var el = ensureEl();
    var track = current();

    if (!track) {
      try { el.pause(); } catch (e) { /* 忽略 */ }
      el.removeAttribute('src');
      return { mode: 'silent' };
    }

    var url = track.url;
    if (el.dataset.src !== url) {
      el.dataset.src = url;
      el.src = url;
      try { el.load(); } catch (e) { /* 忽略 */ }
    }
    // 视频这边一律静音 —— 两路声音叠在一起会很难听。
    // 而且它必须保持静音：浏览器只允许静音视频自动播放，改了背景就黑。
    if (v) { v.muted = true; }
    // 静音状态下不强行 play()：元素本身已经 muted，放了也没声，
    // 但保持暂停更贴合"用户按了静音"的预期；解除静音时 apply() 会再被调到。
    if (window.WenlvMute && window.WenlvMute.isMuted()) {
      return { mode: 'track', name: track.name, muted: true };
    }
    // ★ 开屏期间也不许配乐出声。
    //   开屏自己有一路宣传片在响，配乐这时再播就是**两路音频叠在一起**
    //   （实测 boot-video 与 bg-audio 同时 audible，听感就是"有重音"）。
    //   这里必须显式挡一道：光靠声明的顺序不可靠 —— 页面加载时 boot 的
    //   setScene 与 bg-audio 的 init 谁先跑完并不确定。
    //   回到功能页时 setScene('main') 会触发 syncAll → 这里被重新调到，配乐就接上了。
    if (window.WenlvMute && window.WenlvMute.scene && window.WenlvMute.scene() === 'boot') {
      return { mode: 'track', name: track.name, scene: 'boot' };
    }
    try {
      var pr = el.play();
      if (pr && pr.catch) pr.catch(function () { /* 自动播放被拒，等用户点一下 */ });
    } catch (e) { /* 忽略 */ }
    return { mode: 'track', name: track.name };
  }

  /** 视频播/停时带上配乐；视频换片重载后重新对齐 */
  function bindVideo() {
    var v = bgVideo();
    if (!v || v.dataset.audioBound === '1') return;
    v.dataset.audioBound = '1';
    v.addEventListener('play', function () { if (chosen) { try { ensureEl().play(); } catch (e) { /* 忽略 */ } } });
    v.addEventListener('pause', function () { try { ensureEl().pause(); } catch (e) { /* 忽略 */ } });
    v.addEventListener('loadeddata', function () { if (chosen) apply(); });
  }

  /* ------------------------------------------------------------------ 界面 */

  function render(box) {
    var host = typeof box === 'string' ? document.querySelector(box) : box;
    if (!host) return;
    host.innerHTML = '';

    var mk = function (tag, cls, text) {
      var e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text != null) e.textContent = text;
      return e;
    };

    // 选项一：不放配乐（默认）
    //
    // ★ 这里**不能**叫「视频原声」。实测那条分支是**完全无声的**：
    //   背景视频在 HTML 上带 `muted`（浏览器只允许静音视频自动播放，去不掉），
    //   而下面 apply() 在没有选中音轨时只是 pause 掉 <audio>、并不去动视频的 muted。
    //   原先写着"用宣传片自带的音轨"，用户选了它却一点声音都没有，
    //   看起来就像坏了 —— 标签必须跟实际听感一致。
    //
    // url 必须带上：试听按钮要拿它当 <audio> 的 src。
    var rows = [{ name: '', label: '无声（不放配乐）', note: '主界面不播任何配乐；声音由上面选的音轨提供', url: '' }].concat(
      items.map(function (t) {
        return {
          name: t.name,
          label: t.name,
          url: t.url,
          note: (t.bytes / 1024 / 1024).toFixed(1) + ' MB',
        };
      })
    );

    rows.forEach(function (r) {
      var row = mk('div', 'aud-row' + (chosen === r.name ? ' on' : ''));
      var main = mk('div', 'aud-main');
      main.appendChild(mk('div', 'aud-name', r.label));
      main.appendChild(mk('div', 'aud-note', r.note));
      row.appendChild(main);

      // 试听（原声那条不给试听 —— 它不是一个独立文件）
      if (r.name) {
        var pv = mk('button', 'aud-btn', '▶');
        pv.type = 'button';
        pv.title = '试听这段配乐';
        pv.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var t = ensureEl();
          if (!t.paused && t.dataset.preview === r.name) {
            t.pause(); t.dataset.preview = ''; pv.textContent = '▶';
            return;
          }
          t.dataset.preview = r.name;
          if (t.dataset.src !== r.url || !t.src) {
            // 试听不改"已选用"的那条，只临时切一下源
            t.src = r.url;
          }
          t.play().then(function () { pv.textContent = '⏸'; }).catch(function () { pv.textContent = '▶'; });
        });
        row.appendChild(pv);
      }

      var use = mk('button', 'aud-btn primary', chosen === r.name ? '✓ 使用中' : '选用');
      use.type = 'button';
      use.addEventListener('click', function (ev) {
        ev.stopPropagation();
        write(r.name);
        var el = ensureEl();
        el.dataset.preview = '';
        // 换源：apply 里会比对 dataset.src
        el.dataset.src = '';
        apply();
        render(host);
        if (window.toast) {
          window.toast(r.name ? ('配乐已换成「' + r.name + '」') : '已改为无声（不放配乐）', 'ok');
        }
      });
      row.appendChild(use);

      // 删除（"无声"那条不是文件，没有可删的东西）
      if (r.name) {
        var del = mk('button', 'aud-btn danger', '✕');
        del.type = 'button';
        del.title = '从音频库删除这条配乐（只删音频，不动宣传片）';
        del.addEventListener('click', function (ev) {
          ev.stopPropagation();
          if (!window.confirm('删除配乐「' + r.name + '」？文件会从本机 data/audio/ 移除。\n'
            + '（只删音频，宣传片不受影响；需要时可重新上传视频再抽一次音轨）')) return;
          del.disabled = true;
          del.textContent = '…';
          var xhr = new XMLHttpRequest();
          xhr.open('DELETE', '/api/audio/' + encodeURIComponent(r.name));
          xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 300) {
              // 删掉的正是当前选用那条 → 回到"无声"，否则会继续播一个已不存在的文件
              if (chosen === r.name) {
                write('');
                var el = ensureEl();
                el.dataset.preview = '';
                el.dataset.src = '';
              }
              if (window.toast) window.toast('已删除「' + r.name + '」', 'ok');
              // 重新拉列表并整体重绘（比手动从 items 里删更稳：顺带反映磁盘真实状态）
              load().then(function () {
                render(host);
                apply();
              });
            } else {
              del.disabled = false;
              del.textContent = '✕';
              var msg = '删除失败（HTTP ' + xhr.status + '）';
              try { msg = JSON.parse(xhr.responseText).detail || msg; } catch (e2) { /* 非 JSON */ }
              if (window.toast) window.toast(msg, 'err');
            }
          };
          xhr.onerror = function () {
            del.disabled = false;
            del.textContent = '✕';
            if (window.toast) window.toast('删除失败：请求发不出去', 'err');
          };
          xhr.send();
        });
        row.appendChild(del);
      }

      host.appendChild(row);
    });

    if (!items.length) {
      var tip = mk('div', 'aud-empty',
        '音频库还是空的。上传宣传片时会自动把音轨抽出来放进 data/audio/。');
      host.appendChild(tip);
    }
  }

  async function load() {
    try {
      var r = await fetch('/api/audio');
      var j = await r.json();
      items = (j && j.items) || [];
    } catch (e) {
      items = [];
    }
    return items;
  }

  /** 上传新视频后调用：重新拉列表并套用当前选择 */
  async function refresh(box) {
    await load();
    render(box);
    apply();
    return items;
  }

  /** 容器当前是否真的看得见（所在页签处于激活态）。 */
  function hostVisible(host) {
    if (!host) return false;
    var pane = host.closest ? host.closest('.pane') : null;
    return !pane || pane.classList.contains('active');
  }

  window.WenlvBgAudio = {
    init: async function (box) {
      chosen = read();
      // ★ 列表**必须现在拉**：下面 apply() 要靠 items 才能把用户选的那首
      //   装到 <audio> 的 src 上（不拉就恢复不了播放）。
      //   但**渲染**可以等 —— 配乐列表默认是隐藏的（外观页签），
      //   启动就把它画出来属于白干活。
      await load();
      var host = typeof box === 'string' ? document.querySelector(box) : box;
      if (hostVisible(host)) render(box);
      bindVideo();
      apply();
      // 静音键切换时重新对齐配乐的播放状态
      if (window.WenlvMute) window.WenlvMute.onChange(function () { apply(); });
      return items;
    },
    refresh: refresh,
    apply: apply,
    /**
     * 面板打开时补画列表。
     * 启动时如果配乐区所在的页签还没激活，init() 会跳过渲染（省掉隐藏面板的白活），
     * 切到「外观」页时由 switchTab 调这里补上。
     */
    renderList: function (box) {
      var host = typeof box === 'string' ? document.querySelector(box) : (box || document.querySelector('#audio-list'));
      if (host) render(host);
      return items;
    },
    /** 静音状态变化后重新对齐：解除静音要把配乐放起来，静音时要停掉 */
    onMuteChanged: function () { apply(); },
    current: function () { return chosen; },
    items: function () { return items; },
    /** 上传接口返回里带了音轨信息，用它给用户一句反馈 */
    onUploaded: function (info) {
      if (!info) return;
      if (info.has_audio && info.extracted) {
        if (window.toast) window.toast('已提取视频音轨 → ' + info.track, 'ok', 4200);
      } else if (info.has_audio && !info.extracted) {
        if (window.toast) window.toast('检测到音轨但提取失败：' + (info.reason || ''), 'err', 5000);
      } else if (window.toast) {
        window.toast('这条片子没有音轨' + (info.reason ? '（' + info.reason + '）' : ''), 'warn', 4200);
      }
    },
  };
})();
