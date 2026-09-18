# MCP 服务

本项目自带两个 **Model Context Protocol** 服务，让外部 Agent（Claude Desktop、Cursor、
各种 Agent 框架）能用上本项目的能力。都是**零第三方依赖**的纯 Node 实现，走 stdio。

| 服务 | 文件 | 工具 |
| --- | --- | --- |
| 位置 | `mcp/location-server.js` | `get_location`、`distance_to_spot` |
| Blender | `mcp/blender-server.js` | 见该文件头部说明（需 Blender 运行中） |

## 位置服务

### 它从哪拿位置

直接读 `<项目>/data/location.json` —— 也就是网页端写下的那份：

- **浏览器定位**：在「设置 → 位置」里点「📍 获取我的位置」，浏览器弹窗授权后写入。
  数据只落本机磁盘，不经过任何外部服务。
- **手动坐标**：同一个面板里直接填经纬度。演示时最省事，结果也可复现。
- **IP 估算**：点「🛰️ 用 IP 估算」。**默认关闭**，因为它会把请求发给第三方定位服务；
  而且精度只到**城市级**，可能偏差几十公里 —— 返回值里会带 `source: "ip"` 与
  `accuracyNote`，模型应当据此在回答里说明局限，不要把它当成精确位置。

两个进程不需要互相调用：网页端写文件，MCP 服务读文件。

### 注册到 MCP 客户端

以 Claude Desktop 为例，编辑 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "wenlv-location": {
      "command": "node",
      "args": ["E:\\新建文件夹\\mcp\\location-server.js"],
      "env": { "DATA_DIR": "E:\\新建文件夹\\data" }
    }
  }
}
```

`DATA_DIR` 不填时默认是 `<项目>/data`，与网页端一致。

### 工具

**`get_location`** —— 无参数。返回：

```json
{
  "lat": 30.247, "lng": 120.149,
  "label": "杭州市西湖区",
  "source": "browser",
  "accuracyMeters": 18,
  "accuracyNote": "浏览器定位，精度约 ±18 米",
  "ageMs": 4200, "ageText": "刚刚", "fresh": true
}
```

`fresh: false` 表示位置已过期（默认超过 10 分钟），回答时应说明"这个位置可能已不准"。

**`distance_to_spot`** —— 参数 `spot`（必填）、`city`（可选）。返回距离与方位：

```json
{
  "spot": "灵隐寺", "city": "杭州",
  "distanceMeters": 4712, "distanceText": "4.7 公里",
  "bearingDegrees": 262.0, "bearingText": "西",
  "coordSource": "builtin", "caveat": null
}
```

景点坐标先查**内置坐标表**，覆盖样本库的 5 个城市（杭州 / 苏州 / 成都 / 丽江 / 西安）
的主要景点。表外地点会返回明确失败原因，而不是硬编一个坐标出来。

### 距离与方位怎么算的

- 距离用 **haversine**（球面大圆距离），不是平面勾股 —— 后者在高纬度会明显偏，
  而且方位角本来就得用球面公式，两处用同一套模型才不会出现"距离说很近、箭头却指反了"。
- 方位角是**地图方位**（正北为 0、顺时针），**没有扣磁偏角**。国内一般差 2~6 度，
  对"往哪个方向走"这个粒度没影响，但**不要拿它做精确导航**。
- 内置坐标精度到百米级，用途是"离你多远、在哪个方向"，同样不是导航数据。

## 自己实现 MCP 时最容易踩的四个坑

写在服务代码里也提到过，这里再列一次，因为都很隐蔽：

1. **stdout 只能有协议报文。** 一个 `console.log` 就会混进 JSON-RPC 流里，
   客户端通常只报"连接异常"，完全看不出是自己多打了一行日志。日志一律走 stderr。
2. **通知不能回响应。** 带 `id` 的是请求要回；`notifications/initialized` 这类没有 `id`，
   回了反而是协议错误。
3. **工具失败用 `isError`，不要用 JSON-RPC error。** 前者是"工具跑了但失败了"，
   模型能看懂并调整；后者是协议层故障，客户端一般直接当成服务挂了。
4. **响应一行一条，不要 JSON 美化。** 多行输出会被当成多条不完整报文。

`test/mcp-location.js` 用真实子进程 + 真 stdio 把这些点都钉住了（含 stdout 纯净性断言）。
