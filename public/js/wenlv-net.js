/**
 * 离线重连模块（wenlv-net.js）
 *
 * 解决的问题：后端是本机的 FastAPI 服务。如果它还没起来、或者中途重启/崩溃，
 * 前端原来的写法是 **直接抛错**（util.js 的 api/sse 都不重试），用户看到的是
 * "请求失败"这种没用的一句话，也不知道该等还是该做什么。
 *
 * 现在改成：
 *   ① 只要有一次请求因为**连不上后端**而失败，就进入"重连中"状态 ——
 *      页面上出现「连接已断开，正在重连…（第 N 次）」的横幅
 *   ② 持续探测 /api/status，按指数退避重试（1s→2s→4s…最多 8s）
 *   ③ 一旦恢复：横幅变绿消失，并广播 'wenlv:online' 让各处自行刷新数据
 *   ④ 也监听浏览器的 online/offline 事件（网线/网卡层面的断网）
 *
 * 为什么用"请求失败"而不是 navigator.onLine 作为主判据：
 *   本项目的后端在 127.0.0.1，navigator.onLine 永远是 true ——
 *   后端没起来时它是 true，但所有请求都失败。所以必须以实际请求为准。
 */
(function () {
  'use strict';

  var STATUS_PATH = '/api/status';
  // 探测走轻量的 /api/ping —— 它不做任何外部调用，毫秒级返回。
  // /api/status 会去探 Ollama，本机没启动 Ollama 时每次要等完整超时
  // （实测两次探测共 4 秒），拿它做每几秒一次的探测既慢又浪费。
  var PING_PATH = '/api/ping';

  var state = {
    online: true,       // 后端是否可达
    retrying: false,     // 是否正在重连
    attempts: 0,         // 已重试次数
    nextDelay: 1000,     // 下次重试间隔
    timer: null,
    lastOk: Date.now(),
  };

  var el = null;         // 横幅元素
  var listeners = { online: [], offline: [] };

  /* ---------------------------------------------------------------- 横幅 */
  var CSS_ID = 'wenlv-net-style';
  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID;
    s.textContent = [
      '#wenlv-net-banner{position:fixed;left:50%;top:14px;transform:translateX(-50%);',
      'z-index:3000;display:none;align-items:center;gap:9px;padding:8px 16px;',
      'border-radius:999px;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;',
      'background:rgba(38,30,22,.94);color:#ffd9a0;border:1px solid rgba(255,180,90,.45);',
      'box-shadow:0 6px 24px rgba(0,0,0,.35);backdrop-filter:blur(8px);white-space:nowrap}',
      '#wenlv-net-banner.show{display:flex}',
      '#wenlv-net-banner.ok{background:rgba(22,40,34,.94);color:#9ff0cf;',
      'border-color:rgba(95,224,176,.5)}',
      '#wenlv-net-banner .spin{width:12px;height:12px;border-radius:50%;flex:none;',
      'border:2px solid rgba(255,217,160,.3);border-top-color:#ffd9a0;',
      'animation:wenlv-spin .8s linear infinite}',
      '#wenlv-net-banner.ok .spin{border:none;width:auto;height:auto;animation:none}',
      '@keyframes wenlv-spin{to{transform:rotate(360deg)}}',
      'body.kiosk #wenlv-net-banner{font-size:15px;padding:10px 20px}',
    ].join('');
    document.head.appendChild(s);
  }

  function banner() {
    if (el) return el;
    injectCss();
    el = document.createElement('div');
    el.id = 'wenlv-net-banner';
    el.innerHTML = '<span class="spin"></span><span class="txt"></span>';
    document.body.appendChild(el);
    return el;
  }

  function paint() {
    var b = banner();
    var txt = b.querySelector('.txt');
    if (state.online) {
      b.classList.remove('show');
      return;
    }
    b.classList.add('show');
    b.classList.remove('ok');
    txt.textContent = '连接已断开，正在重连…（第 ' + state.attempts + ' 次）';
  }

  function flashOk() {
    var b = banner();
    b.classList.add('show', 'ok');
    b.querySelector('.txt').textContent = '✓ 已重新连接';
    setTimeout(function () { b.classList.remove('show'); }, 2200);
  }

  /* ---------------------------------------------------------------- 探测 */
  function probe() {
    // 短超时的 GET 判断后端是否活着。
    // 先打 /api/ping（毫秒级）；万一老后端没有这个路由（404），退回 /api/status。
    function tryFetch(path) {
      return fetch(path + '?_=' + Date.now(), {
        method: 'GET',
        cache: 'no-store',
        signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
      }).then(function (r) {
        // 404 说明这个后端还没有 ping 路由（旧版本），交给上层退回 status
        return { ok: r.ok, missing: r.status === 404 };
      }).catch(function () { return { ok: false, missing: false }; });
    }
    return tryFetch(PING_PATH).then(function (r) {
      if (r.ok) return true;
      if (r.missing) {
        // 旧后端没有 /api/ping：退回 status（慢，但能判定）
        return tryFetch(STATUS_PATH).then(function (r2) { return r2.ok; });
      }
      return false;
    });
  }

  function emit(name) {
    (listeners[name] || []).forEach(function (fn) {
      try { fn(); } catch (e) { /* 单个订阅者出错不影响别人 */ }
    });
  }

  function goOffline() {
    if (!state.online && state.retrying) return;   // 已在重连流程里
    state.online = false;
    state.retrying = true;
    state.attempts = 0;
    state.nextDelay = 1000;
    paint();
    emit('offline');
    schedule();
  }

  function schedule() {
    clearTimeout(state.timer);
    state.timer = setTimeout(tick, state.nextDelay);
  }

  function tick() {
    state.attempts += 1;
    paint();
    probe().then(function (ok) {
      if (ok) {
        state.online = true;
        state.retrying = false;
        state.lastOk = Date.now();
        flashOk();
        emit('online');
      } else {
        // 指数退避，上限 8 秒；避免断网时疯狂打请求
        state.nextDelay = Math.min(state.nextDelay * 2, 8000);
        schedule();
      }
    });
  }

  /**
   * 供各处调用：报告一次"连不上后端"的失败。
   * 只有真正连不上（网络层错误 / 5xx / 502 / 503）才算离线；
   * 业务错误（400 参数不对之类）不算 —— 那不是网络问题。
   */
  function reportFailure(err) {
    if (!err) return;
    var netlike = err.name === 'TypeError'                       // fetch 网络失败
      || err.name === 'TimeoutError'
      || err.code === 'ECONNREFUSED'
      || (err.status >= 500 && err.status <= 599)
      || err.status === 0;
    var msg = String(err.message || '');
    if (/Failed to fetch|NetworkError|Load failed|ERR_CONNECTION|ERR_NETWORK/i.test(msg)) netlike = true;
    if (netlike) goOffline();
  }

  function reportSuccess() {
    if (!state.online) {           // 离线期间某次请求成功了 → 直接判定恢复
      state.online = true;
      state.retrying = false;
      clearTimeout(state.timer);
      flashOk();
      emit('online');
    } else {
      state.lastOk = Date.now();
    }
  }

  /* ------------------------------------------------- 浏览器层面的断网 */
  window.addEventListener('offline', function () { goOffline(); });
  window.addEventListener('online', function () {
    // 网卡恢复不代表后端就绪，立刻探一次
    state.nextDelay = 800;
    if (!state.online) schedule();
  });

  /* ---------------------------------------------------------------- 导出 */
  window.WenlvNet = {
    isOnline: function () { return state.online; },
    attempts: function () { return state.attempts; },
    /** 手动触发重连（界面上给个"立即重试"时可用） */
    retryNow: function () {
      if (state.online) return;
      clearTimeout(state.timer);
      state.nextDelay = 500;
      schedule();
    },
    reportFailure: reportFailure,
    reportSuccess: reportSuccess,
    probe: probe,
    onOnline: function (fn) { listeners.online.push(fn); },
    onOffline: function (fn) { listeners.offline.push(fn); },
    /** 供自动化测试用 */
    _state: state,
  };
})();
