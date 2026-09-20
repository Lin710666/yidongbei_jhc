/* ============================================================================
 * ask-bubbles.js —— 对话引导：分批气泡
 *
 * 交互（按用户要求）：
 *   · 进入对话后抛出一批**气泡**，气泡里是文旅界面要问的问题
 *   · 点气泡里的选项选中；点「我选好了」切到**下一批**
 *   · 最后一批点「我选好了」→ 按收集到的答案生成方案
 *   · **第一批什么都没选就点「我选好了」→ 只弹字幕"请认真选择"，不出方案**
 *   · 气泡之外仍然可以直接打字（自由输入随时可用）
 *
 * 为什么做成独立模块：这套交互替换的是原来的「猜你想去 + 让 AI 先问我」，
 * 那两块的代码缠在 app.js 里。写成独立文件 + 外部只调一个 start()，
 * 万一有问题可以整体摘掉，不会连累主流程。
 * ==========================================================================*/

(function () {
  'use strict';

  /** 分批：每批 2 个问题，问完 6 项正好三批 —— 太少显得磨蹭，太多一屏放不下 */
  var BATCHES = [
    {
      title: '第 1 步 · 去哪、去几天',
      items: [
        { key: 'city', q: '想去哪座城市？', opts: ['杭州', '苏州', '成都', '丽江', '西安'] },
        { key: 'days', q: '玩几天？', opts: ['1 天', '2 天', '3 天', '5 天', '7 天'] },
      ],
    },
    {
      title: '第 2 步 · 和谁去、预算多少',
      items: [
        { key: 'crowd', q: '和谁一起去？', opts: ['独自', '情侣', '朋友', '家庭', '带老人', '带小孩'] },
        { key: 'budget', q: '预算大概是哪一档？', opts: ['经济', '舒适', '品质', '豪华'] },
      ],
    },
    {
      title: '第 3 步 · 喜欢什么、有什么忌口',
      items: [
        { key: 'interests', q: '对什么感兴趣？（可多选）', opts: ['人文历史', '自然风光', '美食', '娱乐', '亲子', '摄影'], multi: true },
        { key: 'diet', q: '有饮食禁忌吗？', opts: ['无', '清真', '素食', '不吃辣', '不吃海鲜'] },
      ],
    },
  ];

  var st = null;          // { bi, answers, onDone }
  var host = null;        // 当前这批气泡的容器

  function logEl() { return document.getElementById('chat-log'); }

  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function scrollBottom() {
    var l = logEl();
    if (l) l.scrollTop = l.scrollHeight;
  }

  /** 用页面上那套 appendMsg 追加一条助手消息；取不到就自己造一个 .msg */
  function bubbleHost(html) {
    if (typeof window.appendMsg === 'function') {
      try { return window.appendMsg('assistant', html); } catch (e) { /* 落到下面 */ }
    }
    var l = logEl();
    if (!l) return null;
    var msg = mk('div', 'msg');
    var bd = mk('div', 'bd');
    bd.innerHTML = html;
    msg.appendChild(mk('div', 'av', '🧭'));
    msg.appendChild(bd);
    l.appendChild(msg);
    return bd;
  }

  /** 「请认真选择」字幕 —— 复用页面的字幕条，取不到就用 toast */
  function subtitle(text) {
    var el = document.getElementById('subtitle') || document.querySelector('.subtitle');
    if (el) {
      el.textContent = text;
      el.classList.add('on');
      clearTimeout(subtitle._t);
      subtitle._t = setTimeout(function () { el.classList.remove('on'); }, 2600);
      return;
    }
    if (typeof window.toast === 'function') window.toast(text, 'warn', 2600);
  }

  /* ---------------------------------------------------------------- 渲染 */

  function renderBatch() {
    var batch = BATCHES[st.bi];
    var bd = bubbleHost('**' + batch.title + '**　<span class="ask-step">第 ' + (st.bi + 1) + ' / ' + BATCHES.length + ' 批</span>');
    if (!bd) return;
    host = bd;

    var wrap = mk('div', 'ask-bubbles');

    batch.items.forEach(function (item) {
      var bub = mk('div', 'ask-bubble');
      bub.appendChild(mk('div', 'ask-q', item.q));

      var opts = mk('div', 'ask-opts');
      opts.addEventListener('click', function (ev) { ev.stopPropagation(); });   // 点选项绝不翻批
      item.opts.forEach(function (o) {
        var b = mk('button', 'ask-opt', o);
        b.type = 'button';
        if (isPicked(item.key, o)) b.classList.add('on');
        b.addEventListener('click', function (ev) {
          ev.stopPropagation();
          pick(item, o);
          // 单选：点新的就换过去；多选：累积、再点取消。
          // **不翻批** —— 一旦翻批，多选就不可能了（选第二个时本批已经走了）。
          b.classList.toggle('on', isPicked(item.key, o));
        });
        opts.appendChild(b);
      });
      bub.appendChild(opts);

      // 多选项给一句提示，否则用户不知道可以点好几个
      if (item.multi) {
        bub.appendChild(mk('div', 'ask-hint', '可以多选，选完点下面的「我选好了」'));
      }

      // 这一项已经选过什么，直接写出来（多选时尤其需要）
      var note = mk('div', 'ask-note', noteFor(item));
      bub.appendChild(note);
      bub._note = note;
      bub._item = item;

      // ★ 点**气泡本体**（不是选项）→ 翻到下一批。
      //   这样"看下一批问题"和"选东西"是两个动作，互不干扰。
      bub.addEventListener('click', function () {
        if (!anyAnswered()) { subtitle('请认真选择'); return; }
        nextBatch();
      });
      var tip = mk('div', 'ask-next-tip', '点气泡空白处看下一批 ›');
      bub.appendChild(tip);

      wrap.appendChild(bub);
    });

    bd.appendChild(wrap);

    // 固定选项：我选好了
    var done = mk('button', 'ask-done', st.bi === BATCHES.length - 1 ? '✓ 我选好了，出方案' : '✓ 我选好了，下一步');
    done.type = 'button';
    done.addEventListener('click', onDone);
    bd.appendChild(done);
    scrollBottom();
  }

  function isPicked(key, o) {
    var v = st.answers[key];
    if (Array.isArray(v)) return v.indexOf(o) >= 0;
    return v === o;
  }

  function pick(item, o) {
    if (item.multi) {
      var arr = Array.isArray(st.answers[item.key]) ? st.answers[item.key].slice() : [];
      var i = arr.indexOf(o);
      if (i >= 0) arr.splice(i, 1); else arr.push(o);
      st.answers[item.key] = arr;
    } else {
      st.answers[item.key] = o;
    }
    // 刷新这一批的"已选"提示
    if (host) {
      var bubbles = host.querySelectorAll('.ask-bubble');
      for (var k = 0; k < bubbles.length; k++) {
        var bb = bubbles[k];
        if (bb._note && bb._item && bb._item.key === item.key) bb._note.textContent = noteFor(bb._item);
      }
    }
  }

  function noteFor(item) {
    var v = st.answers[item.key];
    var empty = item.multi ? '还没选' : '还没选';
    if (v == null || (Array.isArray(v) && !v.length)) return '已选：' + empty;
    return '已选：' + (Array.isArray(v) ? v.join('、') : v);
  }

  /** 这一批里有没有任何一项被选过 */
  function batchAnswered(bi) {
    return BATCHES[bi].items.some(function (it) {
      var v = st.answers[it.key];
      return Array.isArray(v) ? v.length > 0 : (v != null && v !== '');
    });
  }

  /* ---------------------------------------------------------------- 流程 */

  /**
   * 「我选好了」= **就用现在选到的内容去生成**。
   *
   * 关键改动：它不再"推进到下一批"，而是直接出方案。
   * 原因（用户反馈）：问题不必问全 —— 用户给多少就用多少生成。
   * 想多看几批问题，点**气泡本体**翻批（见 renderBatch 里的绑定）。
   */
  function onDone() {
    // 什么都没选 → 只提示，不生成
    if (!anyAnswered()) {
      subtitle('请认真选择');
      return;
    }
    finish();
  }

  /** 目前为止有没有选过任何一项 */
  function anyAnswered() {
    return Object.keys(st.answers).some(function (k) {
      var v = st.answers[k];
      return Array.isArray(v) ? v.length > 0 : (v != null && v !== '');
    });
  }

  /** 翻到下一批（点气泡本体触发）。到底了就停在最后一批。 */
  function nextBatch() {
    if (st.bi < BATCHES.length - 1) {
      st.bi += 1;
      renderBatch();
    } else {
      subtitle('已经到最后一批了，点「我选好了」就出方案');
    }
  }

  function finish() {
    var answers = normalize(st.answers);
    var city = answers.city || '杭州';
    bubbleHost('收齐了：**' + city + (answers.days ? ' · ' + answers.days + ' 天' : '') + '**，开始按这份画像排…');
    var done = st.onDone;
    st = null;
    if (typeof done === 'function') {
      try { done(answers); } catch (e) { /* 忽略 */ }
    }
  }

  /** 把气泡里的中文选项翻成规划链路要的值 */
  function normalize(a) {
    var out = {};
    Object.keys(a).forEach(function (k) { out[k] = a[k]; });
    if (out.days) {
      var n = parseInt(String(out.days).replace(/[^\d]/g, ''), 10);
      out.days = Number.isFinite(n) ? n : 2;
    }
    if (Array.isArray(out.interests) && !out.interests.length) delete out.interests;
    return out;
  }

  window.WenlvAsk = {
    BATCHES: BATCHES,
    /** 开一轮引导。onDone(answers) 由外部负责真正去生成 */
    start: function (onDone) {
      var l = logEl();
      if (!l) return false;
      if (st) { subtitle('先把上面那批选完'); return false; }
      st = { bi: 0, answers: {}, onDone: onDone };
      renderBatch();
      return true;
    },
    active: function () { return !!st; },
    answers: function () { return st ? st.answers : null; },
    /** 给外部（比如"自由输入"那条路）用：直接把一项写进答案 */
    set: function (key, val) { if (st) st.answers[key] = val; },
  };
})();
