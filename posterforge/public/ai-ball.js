/* ============================================================================
 * ai-ball.js —— 悬浮球 AI 助手（可嵌到任意页面）
 * ---------------------------------------------------------------------------
 * 为什么要做成独立文件：门户、海报页、旅游规划页三处都要有这颗球，
 * 抄三份必然漂移。这里一份代码，三处共用。
 *
 * 为什么用 Shadow DOM：两个宿主页面配色相反 ——
 * 海报页是深色暖调，旅游规划页是浅色。普通 class 会被宿主的
 * 全局样式（尤其是 body 的 color/background 继承）污染，
 * Shadow DOM 把样式封在组件内，两边看起来一致。
 *
 * 两个能力线（和门户里那个助手一致）：
 *   · 旅游规划 → POST /wenlv/api/chat/stream   （main-repair，SSE 流式）
 *   · 海报模板 → GET  /api/templates/search     （本服务，向量检索）
 *
 * 挂载方式：<script src="/ai-ball.js" defer></script>
 * ========================================================================== */
(function () {
  'use strict';
  if (window.__pfAiBall) return;          // 防重复注入（门户和海报页都会引）
  window.__pfAiBall = true;

  /* 接口基址由**引入它的 script 标签**告诉它，不靠试错探测。
   *
   * 为什么：规划接口的位置取决于这个页面是怎么打开的 ——
   *   · 经反代打开（8800/wenlv/…）→ 接口在 /wenlv/api/…
   *   · 直接打开 HikiTravel 自己的端口（8000/8001）→ 接口在同源 /api/…
   * 早先的写法是先请求 /wenlv/api/health 探一次再回退，功能没问题，
   * 但直连端口时那次探测必然 404，在网络面板里留一条红。
   * 改成读 data-api-base：注入方本来就知道答案，没必要让浏览器去猜。
   *
   *   <script src="/ai-ball.js" data-api-base="/wenlv" defer></script>   反代页面
   *   <script src="/ai-ball.js" defer></script>                          直连页面（同源）
   */
  var WENLV = (function () {
    var tags = document.querySelectorAll('script[src*="ai-ball.js"]');
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].hasAttribute('data-api-base')) return tags[i].getAttribute('data-api-base') || '';
    }
    return '';
  })();
  function apiBase() { return Promise.resolve(WENLV); }

  // 示例问题。**不再写死** —— 由服务端结合当天联网素材轮换（见 /api/assistant/prompts）。
  // 写死的问题永远是那四句，用户看两天就腻了，也跟当天的热点脱节。
  // 这里留一组兜底，网络拿不到时至少还有东西可点。
  var EXAMPLES = [
    '做一张夜市开街的宣传海报',
    '帮我写一段民宿秋季促销的文案'
  ];
  var EXAMPLES_READY = false;

  function loadExamples() {
    return fetch('/api/assistant/prompts')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var list = (j && j.prompts) || [];
        if (list.length >= 2) { EXAMPLES = list.slice(0, 3); EXAMPLES_READY = true; renderExamples(); }
      })
      .catch(function () { /* 拿不到就用兜底那两句 */ });
  }

  function renderExamples() {
    var box = $('exs');
    if (!box) return;
    box.innerHTML = '';
    EXAMPLES.forEach(function (q) {
      var b = document.createElement('button');
      b.className = 'ex';
      b.type = 'button';
      b.textContent = q;
      b.addEventListener('click', function () { $('ta').value = q; send(q); });
      box.appendChild(b);
    });
  }

  /* ---------------------------------------------------------------- 结构 */
  var host = document.createElement('div');
  host.id = 'pf-ai-ball-host';
  host.style.cssText = 'position:fixed;z-index:2147483000;right:0;bottom:0;width:0;height:0';
  var root = host.attachShadow({ mode: 'open' });

  root.innerHTML = [
    '<style>',
    ':host{all:initial}',
    '*,*::before,*::after{box-sizing:border-box}',
    '.ball{position:fixed;right:24px;bottom:24px;width:68px;height:68px;border:0;border-radius:50%;',
    '  cursor:pointer;display:grid;place-items:center;padding:0;',
    '  background:linear-gradient(140deg,#ff5a3c 0%,#ff4d8d 48%,#a855f7 100%);',
    '  box-shadow:0 12px 30px rgba(168,85,247,.42),0 4px 14px rgba(255,90,60,.34);',
    '  transition:transform .18s,opacity .18s;',
    '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
    '.ball:hover{transform:scale(1.07)}',
    '.ball.hide{opacity:0;pointer-events:none;transform:scale(.8)}',
    // 球面文字：光一个图标用户认不出是干什么的。
    // 「AI」大 + 「助手」小，竖排两行 —— 68px 的圆里放得下，且一眼能读出来。
    '.bt{display:flex;flex-direction:column;align-items:center;line-height:1;pointer-events:none}',
    '.bt b{font-size:21px;font-weight:800;color:#fff;letter-spacing:.5px}',
    '.bt i{font-style:normal;font-size:11px;font-weight:700;color:rgba(255,255,255,.94);',
    '  margin-top:3px;letter-spacing:1.5px}',
    // 外圈呼吸光环，和内部文字一起构成"这是个能点的助手"的视觉
    '.ball::after{content:"";position:absolute;inset:-4px;border-radius:50%;',
    '  border:2px solid rgba(168,85,247,.55);animation:pl 2.8s ease-in-out infinite}',
    '@keyframes pl{0%,100%{transform:scale(1);opacity:.85}50%{transform:scale(1.14);opacity:0}}',
    '.dot{position:absolute;top:1px;right:1px;width:13px;height:13px;border-radius:50%;',
    '  background:#22c55e;border:2.5px solid #fff;z-index:2}',
    '.dot.off{background:#c9ced8}',
    '.tip{position:absolute;right:70px;bottom:14px;white-space:nowrap;padding:7px 13px;border-radius:999px;',
    '  background:rgba(22,24,29,.9);color:#fff;font-size:13px;font-weight:600;opacity:0;pointer-events:none;',
    '  transition:opacity .16s;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}',
    '.ball:hover .tip{opacity:1}',

    '.back{position:fixed;inset:0;background:rgba(22,24,29,.34);opacity:0;pointer-events:none;transition:.25s}',
    '.back.on{opacity:1;pointer-events:auto}',

    '.panel{position:fixed;right:26px;bottom:26px;width:min(430px,calc(100vw - 36px));',
    '  height:min(620px,calc(100vh - 52px));background:#fff;border-radius:18px;border:1px solid #e9ebef;',
    '  box-shadow:0 26px 70px rgba(22,24,29,.26);display:flex;flex-direction:column;overflow:hidden;',
    '  opacity:0;pointer-events:none;transform:translateY(14px) scale(.98);transition:.22s cubic-bezier(.22,.9,.3,1);',
    '  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
    '  color:#16181d;text-align:left}',
    '.panel.on{opacity:1;pointer-events:auto;transform:none}',
    '.head{flex:0 0 auto;padding:14px 16px;border-bottom:1px solid #e9ebef;display:flex;align-items:center;gap:10px}',
    '.logo{width:30px;height:30px;border-radius:9px;flex:0 0 auto;display:grid;place-items:center;',
    '  background:linear-gradient(96deg,#ff5a3c,#a855f7)}',
    '.logo svg{width:17px;height:17px}',
    '.title{flex:1;min-width:0}',
    '.title b{display:block;font-size:15px;font-weight:750}',
    '.title span{display:block;font-size:12px;color:#8b929e;margin-top:1px}',
    '.x{width:30px;height:30px;border-radius:8px;border:0;cursor:pointer;flex:0 0 auto;background:transparent;',
    '  color:#8b929e;font-size:17px;display:grid;place-items:center;font-family:inherit}',
    '.x:hover{background:#f7f8fa;color:#16181d}',
    '.note{flex:0 0 auto;margin:12px 14px 0;padding:9px 12px;border-radius:10px;background:#f7f8fa;',
    '  border:1px solid #e9ebef;font-size:12px;color:#5c6470;display:flex;align-items:center;gap:7px;line-height:1.5}',
    '.note svg{width:14px;height:14px;flex:0 0 auto;color:#8b929e}',
    '.msgs{flex:1;min-height:0;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px}',
    '.msg{display:flex;gap:9px}',
    '.mav{width:26px;height:26px;border-radius:8px;flex:0 0 auto;display:grid;place-items:center;',
    '  background:linear-gradient(96deg,#ff5a3c,#a855f7);color:#fff;font-size:12px;font-weight:700}',
    '.mb{background:#f7f8fa;border:1px solid #e9ebef;border-radius:12px;padding:10px 13px;font-size:14px;',
    '  line-height:1.7;white-space:pre-wrap;word-break:break-word;min-width:0;max-width:100%}',
    '.msg.me{flex-direction:row-reverse}',
    '.msg.me .mb{background:#fff1ee;border-color:#ffd9d0}',
    '.msg.me .mav{background:#c9ced8}',
    '.msg.sys .mb{background:#fff8e6;border-color:#f4e2b8;color:#8a6d1f;font-size:12.5px}',
    '.msg.sys .mav{background:#e0b84a}',
    '.cur{display:inline-block;width:7px;height:14px;background:#ff5a3c;vertical-align:-2px;',
    '  animation:bk 1s steps(2) infinite}',
    '@keyframes bk{50%{opacity:0}}',
    '.exs{padding:6px 14px 0;display:flex;flex-direction:column;gap:7px}',
    '.ex{display:flex;align-items:center;gap:9px;text-align:left;cursor:pointer;padding:10px 13px;',
    '  border-radius:999px;border:1px solid #e9ebef;background:#fff;color:#16181d;font-size:13.5px;',
    '  font-family:inherit;transition:.15s}',
    '.ex:hover{border-color:#ffc9bd;background:#fff1ee}',
    '.ex svg{width:15px;height:15px;color:#ff5a3c;flex:0 0 auto}',
    '.hits{margin:0 0 0 35px;padding:9px 11px;border-radius:11px;border:1px dashed #ffc9bd;',
    '  background:#fff1ee;display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
    '.hits i{font-style:normal;font-size:11.5px;color:#8b929e}',
    '.hit{font-size:12px;padding:4px 10px;border-radius:999px;text-decoration:none;background:#fff;',
    '  border:1px solid #e9ebef;color:#16181d;transition:.15s}',
    '.hit:hover{border-color:#ff5a3c;color:#ff5a3c}',
    // ---- 齿轮 + 设置面板 + 虚拟形象 ----
    '.gear{width:30px;height:30px;border:0;background:transparent;color:#8b93a3;cursor:pointer;',
    '  border-radius:8px;display:grid;place-items:center;transition:.15s;flex:0 0 auto}',
    '.gear:hover{background:#f2f4f8;color:#16181d}',
    '.gear svg{width:17px;height:17px}',
    '.settings{position:absolute;inset:0;background:#fff;z-index:5;padding:16px 18px;overflow-y:auto}',
    '.st-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}',
    '.st-head b{font-size:15px;color:#16181d}',
    '.st-x{border:0;background:transparent;font-size:19px;line-height:1;color:#8b93a3;cursor:pointer;padding:0 4px}',
    '.st-row{display:flex;align-items:center;justify-content:space-between;gap:12px;',
    '  padding:11px 0;border-bottom:1px solid #f0f2f6;font-size:13.5px}',
    '.st-row span{color:#3d434f;flex:0 0 auto}',
    '.st-row input[type=text]{flex:1;min-width:0;border:1px solid #e9ebef;border-radius:9px;',
    '  padding:7px 10px;font-size:13px;font-family:inherit;outline:none}',
    '.st-row input[type=text]:focus{border-color:#ffc9bd}',
    '.st-row input[type=checkbox]{width:17px;height:17px;accent-color:#ff5a3c;cursor:pointer}',
    '.st-col{flex-direction:column;align-items:stretch}',
    '.st-col textarea{border:1px solid #e9ebef;border-radius:9px;padding:8px 10px;font-size:13px;',
    '  font-family:inherit;resize:vertical;outline:none;margin-top:7px}',
    '.st-col textarea:focus{border-color:#ffc9bd}',
    '.st-note{font-size:11.5px;color:#8b93a3;line-height:1.6;padding:7px 0 2px}',
    '.st-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:16px}',
    '.st-ok{font-size:12px;color:#12a150}',
    '.st-save{border:0;background:#ff5a3c;color:#fff;font-size:13.5px;font-weight:600;',
    '  padding:9px 20px;border-radius:10px;cursor:pointer;font-family:inherit}',
    '.st-save:hover{background:#f04a2c}',
    '.avatar{border-bottom:1px solid #e9ebef;background:#f7f9fc;height:118px;position:relative;overflow:hidden}',
    '.avatar canvas{display:block;width:100%;height:100%}',
    '.avatar-msg{position:absolute;left:12px;right:12px;bottom:9px;font-size:11.5px;color:#5b6474;',
    '  background:rgba(255,255,255,.9);border-radius:9px;padding:6px 10px;line-height:1.5}',
    '.inp{flex:0 0 auto;padding:12px 14px 14px;border-top:1px solid #e9ebef;margin-top:12px}',
    '.box{display:flex;align-items:flex-end;gap:8px;border:1px solid #e9ebef;border-radius:14px;',
    '  padding:7px 7px 7px 13px;background:#fff;transition:.15s}',
    '.box:focus-within{border-color:#ffc9bd;box-shadow:0 0 0 3px rgba(255,90,60,.1)}',
    'textarea{flex:1;border:0;outline:none;resize:none;background:transparent;font-family:inherit;',
    '  font-size:14px;line-height:1.6;color:#16181d;min-height:26px;max-height:120px;padding:5px 0}',
    '.send{width:34px;height:34px;border-radius:50%;border:0;cursor:pointer;flex:0 0 auto;background:#ff5a3c;',
    '  color:#fff;display:grid;place-items:center;transition:.15s}',
    '.send:hover{background:#e8452a}',
    '.send:disabled{opacity:.4;cursor:not-allowed}',
    '.send svg{width:16px;height:16px}',
    '.foot{text-align:center;font-size:11.5px;color:#8b929e;padding:8px 14px 0}',
    '@media(max-width:640px){.panel{right:0;bottom:0;width:100vw;height:84vh;border-radius:18px 18px 0 0}',
    '  .ball{right:16px;bottom:16px}}',
    '</style>',

    '<button class="ball" id="ball" aria-label="打开 AI 助手">',
    '  <span class="dot" id="dot"></span>',
    '  <span class="bt" id="ballText"><b>AI</b><i>助手</i></span>',
    '  <span class="tip">点这里问行程或写文案</span>',
    '</button>',

    '<div class="back" id="back"></div>',

    '<aside class="panel" id="panel" role="dialog" aria-hidden="true">',
    '  <div class="head">',
    '    <span class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">',
    '      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
    '      <circle cx="12" cy="12" r="3.2"/></svg></span>',
    '    <div class="title"><b id="title">AI 助手</b><span id="st">正在连接…</span></div>',
    // 齿轮只在面板里 —— 收起来时整个面板都不在，所以设置也就看不到了。
    // 这是用户明确要求的：设置只在拉出助手之后才可见。
    '    <button class="gear" id="gear" aria-label="助手设置" title="助手设置">',
    '      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9">',
    '        <circle cx="12" cy="12" r="3"/>',
    '        <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
    '      </svg></button>',
    '    <button class="x" id="close" aria-label="关闭">✕</button>',
    '  </div>',
    // 虚拟形象容器：**默认隐藏**，设置里打开才显示。
    // 它是重资源（Live2D 模型 + pixi 运行时），不该拖慢默认使用。
    '  <div class="avatar" id="avatar" hidden></div>',
    '  <div class="settings" id="settings" hidden></div>',
    '  <div class="note">',
    '    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">',
    '      <circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01" stroke-linecap="round"/></svg>',
    '    <span>AI 助手生成的信息可能不完全准确，出行前请再核实。</span>',
    '  </div>',
    '  <div class="msgs" id="msgs"></div>',
    '  <div class="exs" id="exs"></div>',
    '  <div class="inp">',
    '    <div class="box">',
    '      <textarea id="ta" rows="1" placeholder="问点什么…（Enter 发送）"></textarea>',
    '      <button class="send" id="send" aria-label="发送">',
    '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">',
    '          <path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    '      </button>',
    '    </div>',
    '    <div class="foot">对话由本机模型生成 · 不出本机</div>',
    '  </div>',
    '</aside>'
  ].join('\n');

  var $ = function (s) { return root.getElementById(s); };
  var ball = $('ball'), panel = $('panel'), back = $('back');

  /* ---------------------------------------------------------------- 开合 */
  function open(on) {
    panel.classList.toggle('on', on);
    back.classList.toggle('on', on);
    ball.classList.toggle('hide', on);
    panel.setAttribute('aria-hidden', on ? 'false' : 'true');
    if (on) setTimeout(function () { $('ta').focus(); }, 220);
  }
  ball.addEventListener('click', function () { open(true); });
  $('close').addEventListener('click', function () { open(false); });
  back.addEventListener('click', function () { open(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') open(false); });

  /* ---------------------------------------------------------------- 状态 */
  function probe() {
    apiBase()
      .then(function (b) { return fetch(b + '/api/health', { cache: 'no-store' }); })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var ok = j.status === 'ok';
        $('dot').classList.toggle('off', !ok);
        $('st').textContent = ok
          ? (j.ollama_available ? '本机模型就绪' : '模型未就绪（Ollama 没开）')
          : '离线';
      })
      .catch(function () {
        $('dot').classList.add('off');
        $('st').textContent = '旅游规划服务未启动';
      });
  }

  /* ---------------------------------------------------------------- 聊天 */
  var busy = false;
  function push(who, text) {
    var m = document.createElement('div');
    m.className = 'msg ' + (who === 'me' ? 'me' : who === 'sys' ? 'sys' : '');
    var av = document.createElement('div');
    av.className = 'mav';
    av.textContent = who === 'me' ? '你' : who === 'sys' ? '!' : 'AI';
    var b = document.createElement('div');
    b.className = 'mb';
    b.textContent = text;
    m.appendChild(av); m.appendChild(b);
    $('msgs').appendChild(m);
    $('msgs').scrollTop = $('msgs').scrollHeight;
    return b;
  }

  function send(text) {
    if (busy || !text.trim()) return;
    busy = true; $('send').disabled = true;
    $('exs').innerHTML = '';
    push('me', text);
    $('ta').value = ''; $('ta').style.height = 'auto';

    var body = push('bot', '');
    body.innerHTML = '<span class="cur"></span>';
    var acc = '';

    // 同时问本服务的模板库：助手要能调两个能力，不只是规划那条线
    var tplP = fetch('/api/templates/search?k=3&q=' + encodeURIComponent(text))
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });

    // 对话走**本站自己的** /api/assistant/chat（本机 Ollama）。
    //
    // 原来接的是 <base>/api/chat/stream，也就是 HikiTravel 的接口 ——
    // 但那是**旅游规划**接口，不是聊天：说"你好"，它回的是
    // "还缺少这些信息：目的地、游玩天数、出行人数、总预算"。
    // 用户看到的"助手没实现"就是这个。
    fetch('/api/assistant/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text, history: historyForApi() })
    })
      .then(function (r) {
        if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
        var reader = r.body.getReader(), dec = new TextDecoder(), buf = '';
        function pump() {
          return reader.read().then(function (res) {
            if (res.done) return;
            buf += dec.decode(res.value, { stream: true });
            var parts = buf.split('\n\n');
            buf = parts.pop();
            for (var i = 0; i < parts.length; i++) {
              var lines = parts[i].split('\n');
              for (var k = 0; k < lines.length; k++) {
                if (lines[k].indexOf('data:') !== 0) continue;
                var raw = lines[k].slice(5).trim();
                if (!raw || raw === '[DONE]') continue;
                var ev; try { ev = JSON.parse(raw); } catch (e) { continue; }
                // 本站的事件格式是 {type:'delta'|'done'|'error'}
                if (ev.type === 'error') throw new Error(ev.message || '模型出错');
                if (ev.type === 'delta' && ev.text) {
                  acc += ev.text; body.textContent = acc;
                  $('msgs').scrollTop = $('msgs').scrollHeight;
                  if (window.__pfAvatar) window.__pfAvatar.speak(acc);
                }
              }
            }
            return pump();
          });
        }
        return pump();
      })
      .then(function () {
        body.textContent = acc || '（助手没有返回内容）';
        remember('assistant', acc);
      })
      .catch(function (e) {
        body.textContent = '对话失败：' + e.message +
          '\n\n模型是本机 Ollama。服务端会自动把它拉起来，' +
          '如果这里还是失败，多半是模型没装或名字不对（见 brain.config.json）。';
      })
      .then(function () { busy = false; $('send').disabled = false; })
      .then(function () { return tplP; })
      .then(function (tj) {
        var hits = ((tj && tj.results) || []).filter(function (x) { return x.score >= 0.30; });
        if (!hits.length) return;
        var box = document.createElement('div');
        box.className = 'hits';
        var lb = document.createElement('i'); lb.textContent = '海报模板';
        box.appendChild(lb);
        hits.forEach(function (h) {
          var a = document.createElement('a');
          a.className = 'hit';
          a.textContent = h.title + ' ' + h.score;
          a.href = '/?tpl=' + encodeURIComponent(h.id);
          box.appendChild(a);
        });
        $('msgs').appendChild(box);
        $('msgs').scrollTop = $('msgs').scrollHeight;
      });
  }

  /* ------------------------------------------------------------ 虚拟形象
   *
   * 默认**不加载** —— 运行时（pixi + Cubism core）加起来 760KB，
   * 模型 4.7MB，为了一次都用不上的功能让每个页面都背这些不划算。
   * 用户在设置里打开时才去加载（见 applyPrefs）。
   *
   * 资源是从克隆来的 AIRI-2.0 项目搬的（那个项目有完整的 Live2D 链路）。
   */
  var avatarState = { on: false, app: null, model: null, ready: false, loading: false };

  function loadScript(src) {
    return new Promise(function (res, rej) {
      if (document.querySelector('script[data-pfav="' + src + '"]')) return res();
      var s = document.createElement('script');
      s.src = src; s.async = true; s.dataset.pfav = src;
      s.onload = function () { res(); };
      s.onerror = function () { rej(new Error('加载失败 ' + src)); };
      document.head.appendChild(s);
    });
  }

  function avatarHost() { return $('avatar'); }

  window.__pfAvatar = {
    enable: function (model) {
      var host = avatarHost();
      if (!host) return;
      host.hidden = false;
      if (avatarState.loading) return;
      if (avatarState.ready) {
        // 已经加载过，切模型只需换一个
        if (avatarState.model !== model) window.__pfAvatar._mount(model);
        return;
      }
      avatarState.loading = true;
      host.innerHTML = '<div class="avatar-msg">正在加载形象…（首次约 2 秒）</div>';
      // 顺序不能换：Cubism core 必须在 pixi-live2d 之前就位
      loadScript('/avatar/vendor/pixi.min.js')
        .then(function () { return loadScript('/avatar/vendor/live2dcubismcore.min.js'); })
        .then(function () { return loadScript('/avatar/vendor/pixi-live2d-display-cubism4.min.js'); })
        .then(function () {
          avatarState.ready = true;
          avatarState.loading = false;
          return window.__pfAvatar._mount(model || 'hiyori');
        })
        .catch(function (e) {
          avatarState.loading = false;
          host.innerHTML = '<div class="avatar-msg">形象加载失败：' + esc(e.message) +
            '<br>（不影响对话，可以继续用）</div>';
        });
    },

    _mount: function (model) {
      var host = avatarHost();
      if (!host || !window.PIXI || !window.PIXI.live2d) return;
      var name = String(model || 'hiyori').replace(/[^a-z0-9_-]/gi, '');
      var file = { hiyori: 'Hiyori', mao: 'Mao', hanfu: 'Hanfu', mudan: 'Modan', cangyixiu: 'Cangyixiu' }[name] || 'Hiyori';
      try {
        if (avatarState.app) { avatarState.app.destroy(true); avatarState.app = null; }
        host.innerHTML = '';
        var app = new window.PIXI.Application({
          width: host.clientWidth || 400, height: host.clientHeight || 180,
          backgroundAlpha: 0, antialias: true, autoStart: true,
        });
        host.appendChild(app.view);
        avatarState.app = app;
        window.PIXI.live2d.Live2DModel.from('/avatar/models/' + name + '/' + file + '.model3.json')
          .then(function (m) {
            app.stage.addChild(m);
            var s = Math.min(app.renderer.width / m.width, app.renderer.height / m.height) * 1.35;
            m.scale.set(s);
            m.x = app.renderer.width / 2;
            m.y = app.renderer.height / 2 + m.height * s * 0.34;
            m.anchor.set(0.5, 0.5);
            avatarState.model = m;
            window.__pfAvatar._name = name;
          })
          .catch(function (e) {
            host.innerHTML = '<div class="avatar-msg">模型打不开：' + esc(e.message) + '</div>';
          });
      } catch (e) {
        host.innerHTML = '<div class="avatar-msg">形象初始化失败：' + esc(e.message) + '</div>';
      }
    },

    disable: function () {
      var host = avatarHost();
      if (host) { host.hidden = true; host.innerHTML = ''; }
      if (avatarState.app) { try { avatarState.app.destroy(true); } catch (e) {} avatarState.app = null; }
      avatarState.model = null;
    },

    /** 说话时动一下嘴。没有形象时是空操作，调用方不用判断。 */
    speak: function (text) {
      var m = avatarState.model;
      if (!m) return;
      try {
        var n = Math.min(28, Math.max(6, String(text || '').length));
        var i = 0;
        var timer = setInterval(function () {
          if (!avatarState.model || i++ > n) { clearInterval(timer); return; }
          var p = m.internalModel && m.internalModel.coreModel;
          if (p && p.setParameterValueById) {
            p.setParameterValueById('ParamMouthOpenY', i % 2 ? 1 : 0);
          }
        }, 110);
      } catch (e) { /* 动不了不影响对话 */ }
    },
  };

  /* ------------------------------------------------------------ 设置
   *
   * 用户的要求：设置只在**拉出助手之后**才看得到。
   * 所以它不是页面上一个常驻按钮，而是面板里的一枚齿轮 ——
   * 收起来时整个面板都不在，自然也就看不到设置。
   */

  var prefs = null;

  function loadPrefs() {
    return fetch('/api/assistant/settings')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { prefs = (j && j.settings) || {}; applyPrefs(); return prefs; })
      .catch(function () { prefs = prefs || {}; return prefs; });
  }

  function savePrefs(patch) {
    prefs = Object.assign({}, prefs || {}, patch);
    applyPrefs();
    return fetch('/api/assistant/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.settings) { prefs = j.settings; applyPrefs(); } })
      .catch(function () { /* 存不上就先用内存里的 */ });
  }

  function applyPrefs() {
    var p = prefs || {};
    // 改名：球上的字和面板标题都跟着变，让用户看得出"这确实是我的助手"
    var nm = (p.nickname || 'AI 助手').slice(0, 8);
    var t = $('title'); if (t) t.textContent = nm;
    var bt = $('ballText'); if (bt) bt.textContent = nm.slice(0, 2);
    // 虚拟形象：默认关闭。开了才去加载（它是重资源，不该拖慢默认使用）
    if (window.__pfAvatar) {
      if (p.avatar) window.__pfAvatar.enable(p.avatarModel || 'hiyori');
      else window.__pfAvatar.disable();
    }
  }

  function openSettings() {
    var box = $('settings');
    if (!box) return;
    box.hidden = false;
    if (!prefs) loadPrefs();
    else applyPrefs();
    renderSettings();
  }

  function renderSettings() {
    var box = $('settings');
    if (!box) return;
    var p = prefs || {};
    box.innerHTML =
      '<div class="st-head"><b>助手设置</b><button class="st-x" id="stClose">×</button></div>' +
      '<label class="st-row"><span>虚拟形象</span>' +
        '<input type="checkbox" id="stAvatar"' + (p.avatar ? ' checked' : '') + ' /></label>' +
      '<div class="st-note">默认关闭。打开后会在面板上方加载 Live2D 形象（占内存，首次约 2 秒）。</div>' +
      '<label class="st-row"><span>名字</span>' +
        '<input type="text" id="stName" maxlength="20" value="' + esc(p.nickname || '') + '" placeholder="小旅" /></label>' +
      '<label class="st-row"><span>说话风格</span>' +
        '<input type="text" id="stStyle" maxlength="40" value="' + esc(p.style || '') + '" placeholder="简短 / 详细 / 幽默" /></label>' +
      '<label class="st-row st-col"><span>自定义人设</span>' +
        '<textarea id="stPersona" rows="3" maxlength="400" placeholder="留空则用默认：帮文旅局、酒店、饭馆做物料，也帮游客做行程">' +
        esc(p.persona || '') + '</textarea></label>' +
      '<div class="st-foot"><span class="st-ok" id="stOk"></span>' +
        '<button class="st-save" id="stSave">保存</button></div>';

    $('stClose').onclick = function () { box.hidden = true; };
    $('stSave').onclick = function () {
      var patch = {
        avatar: $('stAvatar').checked,
        nickname: $('stName').value.trim(),
        style: $('stStyle').value.trim(),
        persona: $('stPersona').value.trim(),
      };
      savePrefs(patch).then(function () {
        var ok = $('stOk'); if (ok) { ok.textContent = '已保存'; setTimeout(function () { ok.textContent = ''; }, 1600); }
      });
    };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** 把面板里的对话整理成接口要的 history（只留最近几轮，别把上下文塞爆） */
  var convo = [];
  function remember(role, text) {
    if (!text) return;
    convo.push({ role: role, content: String(text).slice(0, 1500) });
    if (convo.length > 16) convo = convo.slice(-16);
  }
  function historyForApi() {
    // 最后一条是本次提问，接口会自己加，这里不重复带
    return convo.slice(0, -1).slice(-8);
  }

  $('gear') && $('gear').addEventListener('click', openSettings);

  loadPrefs();

  $('send').addEventListener('click', function () { send($('ta').value); });
  $('ta').addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send($('ta').value); }
  });
  $('ta').addEventListener('input', function (e) {
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  });

  // 示例问题：先用兜底那两条渲染出来（面板一打开就有东西可点），
  // 再去问服务端要当天轮换的那组，拿到就替换（见 loadExamples）。
  renderExamples();
  loadExamples();
  $('exs').addEventListener('click', function (e) {
    var b = e.target.closest('.ex');
    if (b) send(b.dataset.q || b.textContent);
  });

  /* ---------------------------------------------------------------- 挂载 */
  function mount() {
    document.body.appendChild(host);
    push('bot', '你好，我是浙里文旅助手。\n可以帮你排行程（说清目的地、天数、同行人、预算），也可以帮你写宣传文案、找海报模板。');
    probe();
    setInterval(probe, 20000);
  }
  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
