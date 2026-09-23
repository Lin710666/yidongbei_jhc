/* ============================================================================
 * agent.js —— 智能体对话页
 *
 * 需求方给的交互（对照手绘示意图）：
 *   ① 从主界面进去后是一个**像扣子那样的对话界面**：有头像、有气泡、
 *      有输入框，底部除了发送键还有一个「AI 规划」键
 *   ② 点「AI 规划」→ **文旅功能从右侧拉出来**（抽屉），不再把表单塞进对话里
 *
 * 与 app.js 的分工：
 *   · app.js 管形象、词云、背景、角色卡这些"外壳"；它通过 window.__wenlv.agent
 *     把 say / toast / runPlanWith / 抽屉开关 等接口暴露出来（显式导出，
 *     不让这个文件去猜内部实现）。
 *   · 这个文件只管对话页自己的 DOM 与状态：气泡、流式、历史、快捷开场。
 *
 * 对话走后端 `/api/agent`（SSE）。那条链路与 /api/chat/stream 是同一个实现，
 * 见 backend/app/routers/ui_compat.py 的说明。
 * ==========================================================================*/
(function () {
  'use strict';

  const A = () => (window.__wenlv && window.__wenlv.agent) || null;
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* 一段对话 = 一串 {role, content}。只存内存 + localStorage 里的「当前段」，
     归档仍在 app.js 的 S.sessions（历史对话那块没动）。 */
  const state = {
    msgs: [],        // [{role:'user'|'assistant', content}]
    busy: false,
    stream: null,    // 当前 SSE 句柄，可中止
  };

  const LS_KEY = 'wenlv.agent.msgs';

  function save() {
    try {
      // 只留最近 60 条，免得 localStorage 被长对话撑爆
      localStorage.setItem(LS_KEY, JSON.stringify(state.msgs.slice(-60)));
    } catch { /* 隐私模式等，忽略 */ }
  }
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) state.msgs = arr.filter(m => m && m.role && typeof m.content === 'string');
    } catch { /* 坏数据就当没有 */ }
  }

  /* ------------------------------------------------------------- 渲染气泡 */
  function md(text) {
    // 复用 util.js 的 Markdown（和方案结果区同一套排版，观感一致）
    try {
      if (window.U && typeof window.U.renderMarkdown === 'function') return window.U.renderMarkdown(text);
    } catch { /* 落到下面 */ }
    return esc(text).replace(/\n/g, '<br>');
  }

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function bubbleFor(role, content, { typing = false } = {}) {
    const me = role === 'user';
    const wrap = el('div', 'amsg ' + (me ? 'me' : 'bot'));
    const name = A() && A().card() ? (A().card().name || '小文') : '小文';
    wrap.appendChild(el('div', 'amsg-ava', me ? '我' : esc(name.slice(0, 1))));
    const body = el('div', 'amsg-body');
    body.appendChild(el('div', 'amsg-name', me ? '我' : esc(name)));
    const b = el('div', 'bubble');
    if (typing) b.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    else b.innerHTML = md(content);
    body.appendChild(b);
    wrap.appendChild(body);
    return { wrap, bubble: b };
  }

  function log() { return $('#agent-log'); }

  function scrollEnd() {
    const L = log();
    if (L) L.scrollTop = L.scrollHeight;
  }

  function renderAll() {
    const L = log();
    if (!L) return;
    L.innerHTML = '';
    if (!state.msgs.length) { L.appendChild(emptyState()); return; }
    for (const m of state.msgs) L.appendChild(bubbleFor(m.role, m.content).wrap);
    scrollEnd();
  }

  function emptyState() {
    const box = el('div', 'agent-empty');
    const name = A() && A().card() ? (A().card().name || '小文') : '小文';
    const greet = (A() && A().card() && A().card().greeting) || '你好，我是你的文旅向导。';
    box.innerHTML =
      '<div class="big">💬</div>' +
      '<div class="t">' + esc(greet) + '</div>' +
      '<div class="d">可以直接聊任何问题；想让 ' + esc(name) +
      '帮你排行程，点下面的 <b>AI 规划</b>。</div>';
    const chips = el('div', 'agent-chips');
    const IDEAS = [
      '杭州两天怎么安排？',
      '带孩子去成都，有什么推荐？',
      '周末周边游，预算 800',
      '帮我写一段杭州的营销文案',
    ];
    for (const t of IDEAS) {
      const c = el('button', 'agent-chip', esc(t));
      c.type = 'button';
      c.addEventListener('click', () => {
        const inp = $('#agent-input');
        if (inp) { inp.value = t; autoGrow(); inp.focus(); }
      });
      chips.appendChild(c);
    }
    box.appendChild(chips);
    return box;
  }

  /* ------------------------------------------------------------- 发消息 */
  function setBusy(b) {
    state.busy = b;
    const btn = $('#agent-send');
    if (btn) btn.disabled = b;
    const inp = $('#agent-input');
    if (inp) inp.disabled = false;   // 允许边生成边打字，符合聊天习惯
    const hint = $('#agent-hint');
    if (hint) hint.textContent = b ? '正在回复…（再点一次发送可停止）' : 'Enter 发送 · Shift+Enter 换行';
  }

  function push(role, content) {
    state.msgs.push({ role, content });
    save();
  }

  async function send(textArg) {
    const inp = $('#agent-input');
    const text = (textArg != null ? textArg : (inp ? inp.value : '')).trim();
    if (!text) return;

    // 正在生成时再点发送 = 停止（比强迫用户等到底更合手）
    if (state.busy) {
      try { state.stream && state.stream.abort && state.stream.abort(); } catch { }
      return;
    }

    if (inp) { inp.value = ''; autoGrow(); }
    const L = log();
    // 空状态那条要撤掉
    const empty = L && L.querySelector('.agent-empty');
    if (empty) empty.remove();

    push('user', text);
    if (L) { L.appendChild(bubbleFor('user', text).wrap); scrollEnd(); }

    setBusy(true);
    const asst = bubbleFor('assistant', '', { typing: true });
    if (L) { L.appendChild(asst.wrap); scrollEnd(); }
    // 让形象进入"说话"状态（口型/动作），和聊天同步
    try { A() && A().sayStreaming && A().sayStreaming(text); } catch { }

    let acc = '';
    const U = window.U || {};
    if (!U.sse) {
      asst.bubble.textContent = '（对话组件未加载：util.js 的 sse 不可用）';
      setBusy(false);
      return;
    }

    const stream = U.sse('/api/agent', { message: text, history: state.msgs.slice(-12) }, (ev) => {
      if (!ev || !ev.type) return;
      /* 后端的事件类型（见 backend/app/routers/ui_compat.py 的 _chat_stream）：
           start   {model}
           notice  {text}     —— "正在理解需求，并检索真实景点与天气…"
           delta   {text}     —— 正文分片，逐片追加
           done    {content, warnings, model, elapsed}
           error   {code, error}   ★ 注意错误信息在 error 字段，不是 text
         这里额外把 notice 当作"临时状态行"显示，让等待期间有反馈。 */
      if (ev.type === 'delta' && ev.text) {
        acc += ev.text;
        asst.bubble.innerHTML = md(acc);
        scrollEnd();
      } else if (ev.type === 'notice' && ev.text) {
        if (!acc) asst.bubble.innerHTML = '<span class="agent-notice">' + esc(ev.text) + '</span>';
      } else if (ev.type === 'error') {
        const msg = ev.error || ev.text || '生成失败';
        asst.bubble.innerHTML = md(acc ? (acc + '\n\n⚠️ ' + msg) : ('⚠️ ' + msg));
        scrollEnd();
      }
    });
    state.stream = stream;

    try {
      await stream.promise;
    } catch (e) {
      // 用户主动中止不算错误
      if (!(e && e.name === 'AbortError')) {
        asst.bubble.innerHTML = md(acc || ('⚠️ ' + (e && e.message ? e.message : '请求失败')));
      }
    } finally {
      state.stream = null;
      setBusy(false);
      // 落盘：空回复不记（避免中止后留下空气泡）
      const finalText = acc.trim();
      if (finalText) {
        push('assistant', finalText);
        try { A() && A().say && A().say(finalText.slice(0, 120), true); } catch { }
      } else {
        asst.wrap.remove();
      }
      scrollEnd();
    }
  }

  function autoGrow() {
    const inp = $('#agent-input');
    if (!inp) return;
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 132) + 'px';
  }

  function bind() {
    const inp = $('#agent-input');
    const sendBtn = $('#agent-send');
    const planBtn = $('#agent-plan');
    const clearBtn = $('#agent-clear');
    const newBtn = $('#agent-new');

    if (inp) {
      inp.addEventListener('input', autoGrow);
      inp.addEventListener('keydown', (e) => {
        // Enter 发送，Shift+Enter 换行 —— 和扣子/常见聊天一致
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          e.preventDefault();
          send();
        }
      });
    }
    if (sendBtn) sendBtn.addEventListener('click', () => send());

    /* ★ 「AI 规划」= 把文旅面板从右边拉出来（需求方明确要的这条）。
       注意：**不往对话里插表单**，对话保持纯粹；规划在抽屉里做。 */
    if (planBtn) {
      planBtn.addEventListener('click', () => {
        const a = A();
        if (!a) return;
        a.openDrawer({ focusPlan: true });
        // 顺手把当前这句话的意思带过去：如果用户刚说了城市/天数，预填进表单
        const lastUser = [...state.msgs].reverse().find(m => m.role === 'user');
        if (lastUser) {
          try { prefillPlan(lastUser.content); } catch { /* 忽略 */ }
        }
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        if (!state.msgs.length) return;
        if (!confirm('清空当前对话？')) return;
        state.msgs.length = 0;
        save();
        renderAll();
        const a = A();
        if (a && a.clearHistory) { try { a.clearHistory(); } catch { } }
      });
    }
    if (newBtn) {
      newBtn.addEventListener('click', () => {
        state.msgs.length = 0;
        save();
        renderAll();
        const inp2 = $('#agent-input');
        if (inp2) inp2.focus();
      });
    }
  }

  /** 从一句话里认出城市/天数，预填到抽屉里的规划表单（认不出就不动） */
  function prefillPlan(text) {
    const cityInput = document.querySelector('#plan-city');
    const days = document.querySelector('#plan-days');
    if (!cityInput) return;
    const s = String(text || '');
    const CITIES = ['杭州', '上海', '北京', '成都', '苏州', '广州', '深圳', '西安',
      '南京', '重庆', '厦门', '青岛', '大理', '丽江', '三亚', '长沙',
      '武汉', '天津', '昆明', '桂林', '哈尔滨', '拉萨', '乌鲁木齐', '郑州'];
    const c = CITIES.find(x => s.includes(x));
    if (c) {
      cityInput.value = c;
      cityInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const d = /(\d+)\s*天/.exec(s);
    if (d && days) {
      const n = Math.max(1, Math.min(7, Number(d[1])));
      days.value = String(n);
      days.dispatchEvent(new Event('input', { bubbles: true }));
      days.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function init() {
    load();
    bind();
    renderAll();
    autoGrow();
    // 角色卡换了名字要跟着变
    document.addEventListener('wenlv:card-changed', () => renderAll());
    window.__agent = { state, send, renderAll, prefillPlan };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
