/**
 * blender.js —— Blender MCP 客户端（驱动已装的 "MCP for Blender" v1.6 插件）
 *
 * ## 协议（读插件源码得到，不是猜的）
 *
 *   · TCP，默认 127.0.0.1:9876
 *   · 发一条 JSON：`{ "type": "<命令>", "params": { ... } }`
 *   · 收一条 JSON：`{ "status": "success"|"error", "result": ... }`
 *   · 一条连接可以发多条命令（插件那边 `_handle_client` 是 while 循环）
 *
 * 基础命令里对本项目有用的：
 *   ping / get_scene_info / get_object_info / get_viewport_screenshot
 *   **execute_code** —— 在 Blender 主线程里执行任意 Python，这是驱动建模与动画的入口
 *
 * ## 两个必须注意的点
 *
 * 1. **插件不能在后台模式跑。** 插件源码里写得很清楚：`blender -b` 下命令永远
 *    不会被执行（命令队列靠 Blender 的 timer 在主线程里排空，后台模式没有事件循环）。
 *    所以必须开着 Blender 的图形界面。本模块会检测并如实说明，而不是让你干等。
 *
 * 2. **一次命令一条连接。** 插件的响应是从 timer 回调里 `sendall` 出去的，
 *    多条命令共用一个连接时响应可能交错。每次开一条新连接最简单也最稳 ——
 *    本机回环连接的开销可以忽略，换来的是"响应一定属于这次请求"。
 */

const fs = require('fs');
const path = require('path');
const net = require('net');

const ANIM_SCRIPT = path.join(__dirname, '..', 'tools', 'blender-anim.py');
const DEFAULT_HOST = process.env.BLENDER_HOST || '127.0.0.1';
const DEFAULT_PORT = Number(process.env.BLENDER_PORT || 9876);

function mkError(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function createBlender({ host = DEFAULT_HOST, port = DEFAULT_PORT, timeout = 120000, outDir } = {}) {
  const dir = outDir || path.join(__dirname, '..', 'data', 'blender');
  fs.mkdirSync(dir, { recursive: true });

  /** 端口通不通（比 connect 更便宜，也不会在 Blender 侧留下一条空连接） */
  function available(probeTimeout = 1500) {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port });
      const done = (v) => { try { sock.destroy(); } catch { /* 忽略 */ } resolve(v); };
      const timer = setTimeout(() => done(false), probeTimeout);
      sock.on('connect', () => { clearTimeout(timer); done(true); });
      sock.on('error', () => { clearTimeout(timer); done(false); });
    });
  }

  /** 发一条命令并等它回来 */
  function send(type, params = {}, { timeout: ms = timeout } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host, port });
      let buf = '';
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch { /* 忽略 */ }
        fn(arg);
      };
      const timer = setTimeout(() => finish(reject, mkError(
        `Blender MCP 在 ${Math.round(ms / 1000)} 秒内没有响应（${host}:${port}）。\n`
        + '常见原因：命令里在跑很慢的操作、Blender 正在弹模态框挡住主线程、或界面被最小化后卡住。',
        'BLENDER_TIMEOUT',
      )), ms);

      sock.setEncoding('utf8');
      sock.on('connect', () => {
        try { sock.write(JSON.stringify({ type, params })); } catch (e) { clearTimeout(timer); finish(reject, e); }
      });
      sock.on('data', (chunk) => {
        buf += chunk;
        // 插件一次把整条 JSON sendall 出来，但 TCP 可能分片 —— 所以要累积到能解析为止
        try {
          const obj = JSON.parse(buf);
          clearTimeout(timer);
          finish(resolve, obj);
        } catch { /* 还没收全，继续等 */ }
      });
      sock.on('error', (e) => {
        clearTimeout(timer);
        finish(reject, mkError(
          `连不上 Blender MCP（${host}:${port}）：${e.message}\n`
          + '请确认 Blender 已打开、且侧栏「MCP for Blender」面板里点了 Connect（或由 start.bat 自动拉起）。',
          'BLENDER_UNREACHABLE',
        ));
      });
      sock.on('close', () => {
        clearTimeout(timer);
        finish(reject, mkError('Blender 关闭了连接但没有回响应', 'BLENDER_NO_RESPONSE'));
      });
    });
  }

  /** 统一的响应拆包：插件回的是 {status, result} 或 {status:'error', message} */
  function unwrap(res) {
    if (!res || typeof res !== 'object') throw mkError('Blender 返回了无法解析的响应', 'BLENDER_BAD_RESPONSE');
    if (res.status === 'error') throw mkError(res.message || 'Blender 执行出错', 'BLENDER_ERROR');
    return res.result !== undefined ? res.result : res;
  }

  async function ping() {
    return unwrap(await send('ping', {}, { timeout: 8000 }));
  }

  async function sceneInfo() {
    return unwrap(await send('get_scene_info', {}, { timeout: 20000 }));
  }

  /**
   * 在 Blender 里执行一段 Python。
   *
   * 注意插件的返回形状：`execute_code` 的实现是
   *     with redirect_stdout(buf): exec(code)
   *     return {"executed": True, "result": buf.getvalue()}
   * —— 也就是说**Python 的返回值被丢掉了，只把 stdout 带回来**。
   * 所以想拿结构化结果，只能自己在代码里 print 一行带标记的 JSON（见下面的 runCodeJson）。
   */
  async function runCode(code, opts = {}) {
    return unwrap(await send('execute_code', { code }, opts));
  }

  const RESULT_MARK = '__WENLV_JSON__';

  /**
   * 从 Blender 的 stdout 里找出结果标记行并解析。
   *
   * 抽成纯函数是为了能单独测 —— 这块我错过两次：
   * 第一次以为插件会回传 Python 的返回值（其实它把返回值丢掉了，只回 stdout）；
   * 第二次没考虑导出日志也混在 stdout 里（所以要从后往前找标记行，
   * 而不是取最后一行）。
   */
  function parseResultMarker(stdoutText) {
    const out = String(stdoutText || '');
    const line = out.split('\n').reverse().find(l => l.trim().startsWith(RESULT_MARK));
    if (!line) return { found: false, output: out };
    const raw = line.trim().slice(RESULT_MARK.length);
    try {
      return { found: true, value: JSON.parse(raw), output: out };
    } catch (e) {
      const err = mkError(`Blender 返回的结果不是合法 JSON：${e.message}\n原始行：${raw.slice(0, 300)}`, 'BLENDER_BAD_RESULT');
      err.output = out;
      throw err;
    }
  }

  /** 执行 Python，并从 stdout 里取回它打印的标记行（解析成对象） */
  async function runCodeJson(code, opts = {}) {
    const res = await runCode(
      `${code}\nprint(${JSON.stringify(RESULT_MARK)} + __import__('json').dumps(_result, ensure_ascii=False))\n`,
      opts,
    );
    const r = parseResultMarker((res && res.result) || '');
    if (!r.found) {
      throw mkError(
        'Blender 执行完了，但没有返回结果标记。\n'
        + `原始输出（尾部）：\n${String(r.output).slice(-500)}`,
        'BLENDER_NO_RESULT',
      );
    }
    return { value: r.value, output: r.output };
  }

  /**
   * 生成"绕圈巡逻"的移动动画并导出 GLB。
   *
   * Blender 侧的代码放在 tools/blender-anim.py，这里只负责把参数与它拼在一起送过去 ——
   * 不把 Python 塞进 JS 字符串，避免转义问题把报错导向 exec 内部。
   */
  async function buildWalkAnimation({ name = 'walker', frames = 72, radius = 2.4, strideCycles = 4, height = 1.6 } = {}) {
    if (!fs.existsSync(ANIM_SCRIPT)) {
      throw mkError(`找不到 Blender 侧的脚本：${ANIM_SCRIPT}`, 'NO_SCRIPT');
    }
    const script = fs.readFileSync(ANIM_SCRIPT, 'utf8');
    const safe = String(name).replace(/[^\w-]/g, '') || 'walker';
    const fileName = `${safe}-${Date.now().toString(36)}.glb`;
    const output = path.join(dir, fileName);

    const params = {
      name: safe,
      frames: Math.min(Math.max(Number(frames) || 72, 24), 480),
      radius: Math.min(Math.max(Number(radius) || 2.4, 0.5), 20),
      strideCycles: Math.min(Math.max(Number(strideCycles) || 4, 1), 12),
      height: Math.min(Math.max(Number(height) || 1.6, 0.3), 4),
      // 注意：这里**不要**手动把反斜杠转义两遍。
      // JSON.stringify 已经把路径转成合法的 JSON 字符串，而 JSON 的对象字面量
      // 恰好也是合法的 Python 字面量，Python 会把它还原成单反斜杠的路径。
      // 多转一次的结果是 Python 收到字面的双反斜杠，然后在 Windows 上找不到目录。
      output,
    };

    const code = `_params = ${JSON.stringify(params)}\n${script}\n_result = _wenlv_build(_params)\n`;
    const { value: payload, output: blenderOut } = await runCodeJson(code, { timeout: Math.max(timeout, 180000) });

    if (!payload || !payload.ok) {
      throw mkError(
        `Blender 没能导出动画：${payload && payload.error ? payload.error : JSON.stringify(payload).slice(0, 300)}\n`
        + `Blender 输出（尾部）：\n${String(blenderOut).slice(-600)}`,
        'BLENDER_EXPORT_FAILED',
      );
    }
    if (!fs.existsSync(output)) {
      throw mkError(`Blender 报告导出成功，但文件不存在：${output}`, 'BLENDER_EXPORT_FAILED');
    }
    return { ...payload, file: output, fileName, bytes: fs.statSync(output).size };
  }

  function readModel(fileName) {
    const base = path.basename(String(fileName || ''));
    const fp = path.join(dir, base);
    if (!base || !fp.startsWith(dir) || !fs.existsSync(fp)) return null;
    return fs.readFileSync(fp);
  }

  function list() {
    try {
      return fs.readdirSync(dir).filter(f => f.endsWith('.glb')).map(f => {
        const st = fs.statSync(path.join(dir, f));
        return { file: f, bytes: st.size, at: st.mtimeMs };
      }).sort((a, b) => b.at - a.at);
    } catch { return []; }
  }

  function remove(fileName) {
    const base = path.basename(String(fileName || ''));
    try { fs.unlinkSync(path.join(dir, base)); return true; } catch { return false; }
  }

  async function status() {
    const up = await available();
    if (!up) {
      return {
        available: false,
        host,
        port,
        reason: 'Blender MCP 服务没在监听。请打开 Blender，在 3D 视图侧栏的「MCP for Blender」面板点 Connect；'
          + '或运行 npm run blender:start 一键拉起（会自动开 Blender 并启动服务，会在桌面上弹出窗口）。',
        jobs: list().length,
      };
    }
    try {
      const pong = await ping();
      let scene = null;
      try { scene = await sceneInfo(); } catch { /* 场景信息拿不到不算失败 */ }
      return { available: true, host, port, pong, scene, jobs: list().length, reason: '' };
    } catch (e) {
      return { available: false, host, port, reason: `端口通但命令执行失败：${e.message}`, jobs: list().length };
    }
  }

  return {
    dir,
    host,
    port,
    available,
    send,
    ping,
    sceneInfo,
    runCode,
    runCodeJson,
    parseResultMarker,
    RESULT_MARK,
    buildWalkAnimation,
    readModel,
    list,
    remove,
    status,
  };
}

module.exports = { createBlender, ANIM_SCRIPT, DEFAULT_HOST, DEFAULT_PORT };
