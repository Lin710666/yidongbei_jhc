#!/usr/bin/env node
/**
 * location-server.js —— 位置 MCP 服务（零第三方依赖，JSON-RPC over stdio）
 *
 * 实现 Model Context Protocol，把"用户在哪"这件事开放给任何支持 MCP 的客户端
 * （Claude Desktop / Cursor / 各种 Agent 框架），它们就能在回答里用上真实位置。
 *
 * ## 协议要点（自己实现 MCP 最容易踩的几处）
 *
 * 1. **stdout 是协议通道，一个字节都不能污染。**
 *    这条是硬约束：任何 `console.log` 调试输出都会混进 JSON-RPC 报文里，
 *    客户端解析失败后通常只报"连接异常"，根本看不出是自己多打了一行日志。
 *    所以本文件全程用 `console.error`（走 stderr）输出日志。
 *
 * 2. **换行分隔的 JSON-RPC 2.0。** 一条消息一行，不允许多行美化。
 *
 * 3. **通知（notification）不能回响应。** 带 `id` 的才是请求，需要回；
 *    没有 `id` 的是通知（例如 `notifications/initialized`），回了反而是协议错误。
 *
 * 4. **工具执行出错要走 isError，而不是 JSON-RPC error。**
 *    前者是"工具跑了但失败了"，模型能看到并自行调整；后者是协议层错误，
 *    客户端一般会直接把它当成服务故障。
 *
 * ## 位置从哪来
 *
 * 直接读 `<项目>/data/location.json` —— 也就是网页端（浏览器定位 / 手填 / IP 兜底）
 * 写下的那份。这样两个进程不需要互相调用，MCP 服务也不需要自己去做定位。
 *
 * 用法：
 *   node mcp/location-server.js          # 直接跑（stdio）
 *   注册到 MCP 客户端时把 command 指向 node、args 指向本文件即可，见 mcp/README.md
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const LOCATION_FILE = path.join(DATA_DIR, 'location.json');

const SERVER_INFO = { name: 'wenlv-location', version: '1.0.0' };
// 客户端与服务端协商协议版本；这里声明我们支持的版本，客户端给的版本我们原样回。
const DEFAULT_PROTOCOL = '2024-11-05';

const geo = require('../lib/geo');

/* ==========================================================================
 * 读位置
 * ========================================================================*/

function readLocation() {
  try {
    if (!fs.existsSync(LOCATION_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(LOCATION_FILE, 'utf8'));
    const c = raw && raw.current;
    if (!c || !geo.isValidCoord(Number(c.lat), Number(c.lng))) return null;
    const ageMs = Date.now() - (c.at || 0);
    return {
      lat: Number(c.lat),
      lng: Number(c.lng),
      accuracy: c.accuracy ?? null,
      label: c.label || '',
      source: c.source || 'unknown',
      at: c.at || 0,
      ageMs,
      ageText: ageMs < 60000 ? '刚刚' : ageMs < 3600000 ? `${Math.round(ageMs / 60000)} 分钟前` : `${Math.round(ageMs / 3600000)} 小时前`,
      fresh: ageMs <= 10 * 60 * 1000,
      accuracyNote: c.source === 'browser'
        ? (c.accuracy ? `浏览器定位，精度约 ±${Math.round(c.accuracy)} 米` : '浏览器定位')
        : c.source === 'manual' ? '手动填写的坐标'
          : 'IP 定位（精度仅到城市级，可能偏差几十公里）',
    };
  } catch (e) {
    console.error('[location-mcp] 读取位置失败：', e.message);
    return null;
  }
}

/* ==========================================================================
 * 工具
 * ========================================================================*/

const TOOLS = [
  {
    name: 'get_location',
    description:
      '获取用户当前所在位置（经纬度、来源与时效）。当需要判断"离某个景点多远""往哪个方向走"'
      + '这类与用户实际位置有关的问题时使用。注意返回里带 source 与 ageMs：'
      + 'source=ip 表示只精确到城市级，fresh=false 表示位置已经过时，都应当在回答里如实说明。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'distance_to_spot',
    description:
      '计算用户当前位置到某个景点的直线距离与方位。景点坐标优先查内置坐标表'
      + '（覆盖杭州/苏州/成都/丽江/西安的主要景点），查不到时如实返回失败原因。',
    inputSchema: {
      type: 'object',
      properties: {
        spot: { type: 'string', description: '景点名称，例如「西湖」「兵马俑」' },
        city: { type: 'string', description: '所在城市，可选，用于提高匹配准确度' },
      },
      required: ['spot'],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args) {
  if (name === 'get_location') {
    const loc = readLocation();
    if (!loc) {
      return {
        isError: true,
        text: '目前没有用户位置。请先在「文旅智能辅助」网页里点「获取我的位置」授权浏览器定位，'
          + '或手动填写坐标（位置会写到 data/location.json，本服务直接从那里读）。',
      };
    }
    return {
      text: JSON.stringify({
        lat: loc.lat,
        lng: loc.lng,
        label: loc.label,
        source: loc.source,
        accuracyMeters: loc.accuracy,
        accuracyNote: loc.accuracyNote,
        ageMs: loc.ageMs,
        ageText: loc.ageText,
        fresh: loc.fresh,
      }, null, 2),
    };
  }

  if (name === 'distance_to_spot') {
    const spot = String((args && args.spot) || '').trim();
    if (!spot) return { isError: true, text: '缺少 spot 参数（景点名称）。' };

    const loc = readLocation();
    if (!loc) return { isError: true, text: '目前没有用户位置，无法计算距离。请先在网页里获取或填写位置。' };

    const target = geo.lookupSpot(spot, { city: String((args && args.city) || '').trim() });
    if (!target) {
      return {
        isError: true,
        text: `查不到「${spot}」的坐标。内置坐标表只覆盖样本库的 5 个城市`
          + '（杭州 / 苏州 / 成都 / 丽江 / 西安）的主要景点。',
      };
    }

    const rel = geo.describeRelation(
      { lat: loc.lat, lng: loc.lng, label: loc.label || '用户位置' },
      { lat: target.lat, lng: target.lng, label: target.name },
    );
    return {
      text: JSON.stringify({
        spot: target.name,
        city: target.city,
        coordSource: target.source,
        distanceMeters: Math.round(rel.distanceMeters),
        distanceText: rel.distanceText,
        bearingDegrees: Number(rel.bearing.toFixed(1)),
        bearingText: rel.bearingText,
        caveat: [loc.source === 'ip' ? '用户位置来自 IP 解析，只精确到城市级' : '',
          !loc.fresh ? `用户位置已过时（${loc.ageText}）` : ''].filter(Boolean).join('；') || null,
      }, null, 2),
    };
  }

  return { isError: true, text: `没有名为 ${name} 的工具。可用工具：${TOOLS.map(t => t.name).join('、')}` };
}

/* ==========================================================================
 * JSON-RPC 主循环
 * ========================================================================*/

function send(msg) {
  // 必须一行一条；写 stderr 的日志不会干扰协议
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id, result) { send({ jsonrpc: '2.0', id, result }); }
function fail(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      ok(id, {
        protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
      return;

    case 'notifications/initialized':
    case 'initialized':
      return;   // 通知，不回

    case 'ping':
      if (!isNotification) ok(id, {});
      return;

    case 'tools/list':
      ok(id, { tools: TOOLS });
      return;

    case 'tools/call': {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      try {
        const r = await callTool(name, args);
        ok(id, {
          content: [{ type: 'text', text: r.text }],
          ...(r.isError ? { isError: true } : {}),
        });
      } catch (e) {
        // 工具内部异常：仍然走 isError（工具失败了），而不是 JSON-RPC error（协议坏了）。
        // 这样模型能看懂"这次调用失败了"，而不是以为整个 MCP 服务挂了。
        ok(id, { content: [{ type: 'text', text: `工具执行失败：${e.message}` }], isError: true });
      }
      return;
    }

    // 其余 MCP 能力（resources / prompts）本服务不提供，按规范回"方法不存在"
    default:
      if (!isNotification) fail(id, -32601, `Method not found: ${method}`);
  }
}

function main() {
  console.error(`[location-mcp] 已启动，位置文件：${LOCATION_FILE}`);

  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        // 解析不了就没法知道 id，按规范用 null
        fail(null, -32700, 'Parse error：收到的不是合法 JSON');
        continue;
      }
      // 串行处理：位置读取很快，但保持顺序能让响应与请求一一对应，便于排查
      Promise.resolve(handle(msg)).catch((e) => {
        console.error('[location-mcp] 处理异常：', e && e.stack || e);
        if (msg && msg.id !== undefined) fail(msg.id, -32603, `Internal error: ${e.message}`);
      });
    }
  });

  process.stdin.on('end', () => {
    console.error('[location-mcp] stdin 关闭，退出');
    process.exit(0);
  });
}

if (require.main === module) main();

module.exports = { TOOLS, callTool, readLocation, handle, LOCATION_FILE };
