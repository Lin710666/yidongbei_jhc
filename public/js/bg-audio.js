/* ============================================================================
 * bg-audio.js —— 背景配乐：默认用视频原声，也可以换成音频库里的音轨
 *
 * ## 为什么要有这一层
 *
 * 上传宣传片时后端会顺手把音轨抽出来（见 backend/app/services/audio_extract.py），
 * 但抽出来只是"有这份文件"，用户还得能**选**：原声 / 静音 / 换成本地某一首。
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

  var KEY = 'wenlv.bgAudio';       // 存的是音轨文件名；'' = 用视频原声

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
   * - chosen 为空 → 视频当静音放（保持原来的行为），停掉配乐
   * - chosen 有值 → 视频静音，配乐跟着视频播/停
   */
  function apply() {
    var v = bgVideo();
    var el = ensureEl();
    var track = current();

    if (!track) {
      try { el.pause(); } catch (e) { /* 忽略 */ }
      el.removeAttribute('src');
      return { mode: 'original' };
    }

    var url = track.url;
    if (el.dataset.src !== url) {
      el.dataset.src = url;
      el.src = url;
      try { el.load(); } catch (e) { /* 忽略 */ }
    }
    // 视频这边一律静音 —— 两路声音叠在一起会很难听
    if (v) { v.muted = true; }
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

    // 选项一：用视频原声（默认）
    // ★ url 必须带上：试听按钮要拿它当 <audio> 的 src。
    //   第一版漏了这个字段，试听直接 404（r.url 是 undefined）。
    var rows = [{ name: '', label: '视频原声（默认）', note: '用宣传片自带的音轨', url: '' }].concat(
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
          window.toast(r.name ? ('配乐已换成「' + r.name + '」') : '已改回视频原声', 'ok');
        }
      });
      row.appendChild(use);
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

  window.WenlvBgAudio = {
    init: async function (box) {
      chosen = read();
      await load();
      render(box);
      bindVideo();
      apply();
      return items;
    },
    refresh: refresh,
    apply: apply,
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
