#!/usr/bin/env node
/**
 * 位置 MCP 服务测试
 *
 * 运行：node test/mcp-location.js     （或 npm run test:mcp）
 *
 * 为什么必须用**真的子进程 + 真 stdio**去测：
 *   这个服务的正确性全在协议细节上，而协议细节只有真的收发报文才能验出来 ——
 *   换行分隔的 JSON、通知不回响应、stdout 一个字节都不能被日志污染。
 *   直接 require 进来调函数会把这几条全绕过去，测了个寂寞。
 *
 * 覆盖：
 *   A. 握手与能力声明
 *   B. tools/list 的 schema 完整性
 *   C. tools/call：无位置 / 有位置 / 距离方位 / 参数错误
 *   D. 协议边界：未知方法、坏 JSON、通知不回响应
 *   E. stdout 纯净性（不能混入任何非协议输出）
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wenlv-mcp-'));
const SERVER = path.join(ROOT, 'mcp', 'location-server.js');

let pass = 0;
let fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${extra !== undefined ? `  → ${extra}` : ''}`); }
}

/** 极简 MCP 客户端：按行收发 JSON-RPC */
function connect() {
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  const queue = [];          // 收到的所有消息（含通知，虽然本服务不发）
  const waiters = new Map(); // id -> resolve
  let stderr = '';
  let rawLines = [];

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      rawLines.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch {
        // 非 JSON 行意味着 stdout 被污染了，单独记下来供断言
        queue.push({ __unparsable: line });
        continue;
      }
      queue.push(msg);
      if (msg.id !== undefined && msg.id !== null && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });

  let nextId = 1;
  function send(msg) { child.stdin.write(`${JSON.stringify(msg)}\n`); }
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`等待 ${method} 响应超时（id=${id}）`)), 8000);
      waiters.set(id, (m) => { clearTimeout(timer); resolve(m); });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }
  function notify(method, params) { send({ jsonrpc: '2.0', method, params }); }
  function writeRaw(text) { child.stdin.write(text); }

  return {
    request, notify, writeRaw,
    get stderr() { return stderr; },
    get lines() { return rawLines; },
    close: () => new Promise((r) => { child.on('exit', r); child.kill(); }),
  };
}

const writeLocation = (obj) => fs.writeFileSync(path.join(DATA_DIR, 'location.json'), JSON.stringify(obj), 'utf8');

async function main() {
  console.log('位置 MCP 服务测试');
  console.log(`临时数据目录：${DATA_DIR}\n`);

  const cli = connect();

  try {
    // ---------- A. 握手 ----------
    console.log('A. 握手与能力声明');
    const init = await cli.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    check('initialize 有 result', Boolean(init.result), JSON.stringify(init).slice(0, 160));
    check('回显协商后的 protocolVersion', init.result && typeof init.result.protocolVersion === 'string', init.result && init.result.protocolVersion);
    check('声明了 tools 能力', Boolean(init.result && init.result.capabilities && init.result.capabilities.tools));
    check('serverInfo 带 name/version', Boolean(init.result && init.result.serverInfo && init.result.serverInfo.name && init.result.serverInfo.version));

    // 通知不应产生响应：先发通知，再发一个 ping，收到的应当只有 ping 的响应
    const before = cli.lines.length;
    cli.notify('notifications/initialized');
    const pong = await cli.request('ping', {});
    check('ping 正常返回', Boolean(pong.result));
    check('通知（无 id）不会产生响应', cli.lines.length - before === 1, `期间收到 ${cli.lines.length - before} 条`);

    // ---------- B. tools/list ----------
    console.log('\nB. 工具清单');
    const tl = await cli.request('tools/list', {});
    const tools = (tl.result && tl.result.tools) || [];
    check('列出工具', tools.length >= 2, `实际 ${tools.length} 个`);
    check('含 get_location', tools.some(t => t.name === 'get_location'));
    check('含 distance_to_spot', tools.some(t => t.name === 'distance_to_spot'));
    check('每个工具都有 name / description / inputSchema',
      tools.every(t => t.name && t.description && t.inputSchema && t.inputSchema.type === 'object'),
      JSON.stringify(tools.map(t => t.name)));
    const dts = tools.find(t => t.name === 'distance_to_spot');
    check('distance_to_spot 把 spot 标为必填',
      dts && Array.isArray(dts.inputSchema.required) && dts.inputSchema.required.includes('spot'));

    // ---------- C. tools/call ----------
    console.log('\nC. 工具调用');

    // C1：还没有位置
    const noLoc = await cli.request('tools/call', { name: 'get_location', arguments: {} });
    check('没有位置时返回 isError 而不是协议错误', noLoc.result && noLoc.result.isError === true);
    check('提示里告诉用户去哪设置位置',
      noLoc.result && noLoc.result.content[0].text.includes('网页'), noLoc.result && noLoc.result.content[0].text.slice(0, 80));

    // C2：写入一个"浏览器定位"的位置，再读
    writeLocation({
      version: 1,
      current: { lat: 30.2470, lng: 120.1490, accuracy: 20, label: '杭州市西湖区', source: 'browser', at: Date.now() },
    });
    const withLoc = await cli.request('tools/call', { name: 'get_location', arguments: {} });
    const payload = JSON.parse(withLoc.result.content[0].text);
    check('读回经纬度', payload.lat === 30.2470 && payload.lng === 120.1490, JSON.stringify(payload));
    check('带上来源与精度说明', payload.source === 'browser' && /±20/.test(payload.accuracyNote), payload.accuracyNote);
    check('带上时效信息', typeof payload.ageMs === 'number' && payload.fresh === true, JSON.stringify({ age: payload.ageMs, fresh: payload.fresh }));

    // C3：距离与方位（西湖 → 灵隐寺，约 4.7 公里、西向）
    const dist = await cli.request('tools/call', { name: 'distance_to_spot', arguments: { spot: '灵隐寺', city: '杭州' } });
    const dj = JSON.parse(dist.result.content[0].text);
    check('算出了距离', dj.distanceMeters > 4000 && dj.distanceMeters < 5500, `${dj.distanceMeters} 米`);
    check('算出了方位', dj.bearingText === '西', dj.bearingText);
    check('标注了坐标来源', dj.coordSource === 'builtin', dj.coordSource);

    // C4：景点不在内置表里
    const badSpot = await cli.request('tools/call', { name: 'distance_to_spot', arguments: { spot: '不存在的地方' } });
    check('查不到的景点返回 isError', badSpot.result && badSpot.result.isError === true);
    check('并说明内置表覆盖范围', badSpot.result.content[0].text.includes('杭州'));

    // C5：缺参数
    const noArg = await cli.request('tools/call', { name: 'distance_to_spot', arguments: {} });
    check('缺 spot 参数时给出可读错误', noArg.result && noArg.result.isError === true && noArg.result.content[0].text.includes('spot'));

    // C6：未知工具名
    const unknown = await cli.request('tools/call', { name: 'nope', arguments: {} });
    check('未知工具返回 isError 并列出可用工具',
      unknown.result && unknown.result.isError === true && unknown.result.content[0].text.includes('get_location'));

    // C7：IP 来源的位置要把"只到城市级"说清楚
    writeLocation({
      version: 1,
      current: { lat: 30.2741, lng: 120.1551, label: '杭州', source: 'ip', at: Date.now() },
    });
    const ipLoc = await cli.request('tools/call', { name: 'get_location', arguments: {} });
    const ipj = JSON.parse(ipLoc.result.content[0].text);
    check('IP 定位的精度局限被如实标注', /城市级/.test(ipj.accuracyNote), ipj.accuracyNote);

    // C8：过期的位置要标 fresh=false
    writeLocation({
      version: 1,
      current: { lat: 30.2470, lng: 120.1490, label: '', source: 'browser', at: Date.now() - 3 * 3600 * 1000 },
    });
    const stale = await cli.request('tools/call', { name: 'get_location', arguments: {} });
    const sj = JSON.parse(stale.result.content[0].text);
    check('过期的位置标记 fresh=false', sj.fresh === false, JSON.stringify({ fresh: sj.fresh, age: sj.ageText }));
    check('并给出可读的"多久之前"', /小时前/.test(sj.ageText), sj.ageText);

    // C9：坐标损坏时不能算出错误结果
    writeLocation({ version: 1, current: { lat: 999, lng: 120 } });
    const broken = await cli.request('tools/call', { name: 'get_location', arguments: {} });
    check('非法坐标被视为"没有位置"，而不是算出 0 米', broken.result && broken.result.isError === true);

    // ---------- D. 协议边界 ----------
    console.log('\nD. 协议边界');
    const unknownMethod = await cli.request('resources/list', {});
    check('未知方法返回 -32601', unknownMethod.error && unknownMethod.error.code === -32601, JSON.stringify(unknownMethod.error));

    const beforeBad = cli.lines.length;
    cli.writeRaw('这不是 JSON\n');
    await new Promise(r => setTimeout(r, 250));
    const badLine = cli.lines.slice(beforeBad).map(l => { try { return JSON.parse(l); } catch { return null; } }).find(m => m && m.error);
    check('坏 JSON 回 -32700 且不崩溃', badLine && badLine.error.code === -32700, JSON.stringify(badLine && badLine.error));

    // 服务仍然活着
    const alive = await cli.request('ping', {});
    check('经历异常输入后服务仍然存活', Boolean(alive.result));

    // ---------- E. stdout 纯净性 ----------
    console.log('\nE. stdout 纯净性');
    const unparsable = cli.lines.filter(l => { try { JSON.parse(l); return false; } catch { return true; } });
    check('stdout 每一行都是合法 JSON（没有任何日志混入）', unparsable.length === 0, unparsable.slice(0, 2).join(' | '));
    check('日志走的是 stderr', cli.stderr.includes('[location-mcp]'), cli.stderr.slice(0, 80));
  } finally {
    await cli.close();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('测试自身出错：', e);
  process.exitCode = 1;
});
