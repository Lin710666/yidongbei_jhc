#!/usr/bin/env node
/**
 * 冒烟测试：把几个"踩过的坑"钉住，防止以后改回去。
 *
 * 运行：node test/smoke.js      （或 npm run smoke）
 *
 * 覆盖的回归点：
 *   1. /api/status 能正常返回，且带上 hasModel 字段
 *   2. 首页能正常打开
 *   3. 畸形 URL（/%）返回 400 —— 而不是把整个服务打崩（历史 bug）
 *   4. 目录穿越（/..%2f..%2fserver.js）被拦在 demo/ 之外
 *   5. 非法 type、非法 JSON 返回 4xx —— 而不是一律 200
 *   6. 跑完全部畸形请求后，服务仍然活着（最关键的一条）
 *
 * 会用 SMOKE_PORT（默认 8123）临时启动一份服务副本，结束时自动关闭。
 */

const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.SMOKE_PORT || 8123);
const HOST = '127.0.0.1';
const ROOT = path.join(__dirname, '..');

let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) {
    pass++;
    console.log(`  \u2713 ${name}`);
  } else {
    fail++;
    console.log(`  \u2717 ${name}${extra ? '  → ' + extra : ''}`);
  }
}

// 直接用 http 模块发请求：不会像 fetch 那样对路径做归一化，才能测出 /..%2f 这类编码穿越
function request(method, reqPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HOST, port: PORT, path: reqPath, method, headers: body ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await request('GET', '/api/status');
      if (r.status === 200) return true;
    } catch {
      /* 还没起来，继续等 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main() {
  console.log('文旅智能辅助 · 冒烟测试');
  console.log(`临时服务端口：${PORT}\n`);

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST },
    stdio: 'ignore', // 不用管道，兼容受限的沙箱环境
  });

  let alive = true;
  child.on('exit', () => (alive = false));

  try {
    if (!(await waitReady(15000))) {
      console.log('  \u2717 服务未能在 15 秒内就绪，测试中止');
      process.exitCode = 1;
      return;
    }

    // 1 & 2
    const st = await request('GET', '/api/status');
    let stJson = {};
    try { stJson = JSON.parse(st.body); } catch { /* 忽略 */ }
    check('/api/status 返回 200', st.status === 200, `实际 ${st.status}`);
    check('/api/status 带 hasModel 字段（前端徽标靠它避免假绿）', typeof stJson.hasModel === 'boolean', JSON.stringify(stJson));

    const home = await request('GET', '/');
    check('首页返回 200', home.status === 200, `实际 ${home.status}`);
    check('首页内容正确', home.body.includes('文旅智能辅助'));

    // 3 历史 bug：畸形 URL 曾把服务打崩（退出码 1）
    const bad = await request('GET', '/%');
    check('畸形 URL /%  返回 400', bad.status === 400, `实际 ${bad.status}`);

    // 4 目录穿越
    const trav = await request('GET', '/..%2f..%2fserver.js');
    check('目录穿越被拦截（403/404，且不返回源码）', (trav.status === 403 || trav.status === 404) && !trav.body.includes('buildSystemPrompt'), `实际 ${trav.status}`);

    // 5 输入校验
    const badType = await request('POST', '/api/generate', JSON.stringify({ type: 'nope', params: {} }));
    check('非法 type 返回 4xx（不再一律 200）', badType.status >= 400 && badType.status < 500, `实际 ${badType.status}`);

    const badJson = await request('POST', '/api/generate', '{不是合法JSON');
    check('非法 JSON 返回 400', badJson.status === 400, `实际 ${badJson.status}`);

    // 6 关键：经过上面所有畸形请求，服务必须还活着
    await new Promise((r) => setTimeout(r, 500));
    const after = await request('GET', '/api/status');
    check('全部畸形请求之后服务仍然存活', alive && after.status === 200, alive ? `status ${after.status}` : '进程已退出（崩服回归！）');
  } catch (e) {
    fail++;
    console.log(`  \u2717 测试过程抛出异常：${e.message}`);
  } finally {
    if (alive) child.kill();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
}

main();
