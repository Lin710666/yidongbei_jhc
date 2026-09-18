#!/usr/bin/env node
/**
 * start-blender.js —— 拉起 Blender 并自动开启 MCP 服务
 *
 * 运行：node tools/start-blender.js        （或 npm run blender:start）
 *
 * ## 为什么必须开图形界面
 *
 * "MCP for Blender" 插件源码里写得很明确：`blender -b`（后台模式）下**命令永远不会被执行**。
 * 原因是它的命令队列靠 Blender 的 timer 在主线程里排空，而后台模式没有事件循环。
 * 所以这个脚本只能开 GUI —— 会弹出一个 Blender 窗口，这是正常且必须的。
 *
 * ## 它是幂等的
 *
 * 已经在跑就不用再开一个：脚本会先探一下 9876 端口，通了就直接返回。
 * 重复执行不会开出第二个 Blender。
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.BLENDER_PORT || 9876);

/** 找 Blender：环境变量优先，然后是常见安装位置 */
function findBlender() {
  if (process.env.BLENDER_EXE && fs.existsSync(process.env.BLENDER_EXE)) return process.env.BLENDER_EXE;
  const cands = [
    'E:\\New Folder\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe',
    'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe',
    'D:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

function portOpen(port, timeout = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { sock.destroy(); } catch { /* 忽略 */ } resolve(v); };
    const t = setTimeout(() => done(false), timeout);
    sock.on('connect', () => { clearTimeout(t); done(true); });
    sock.on('error', () => { clearTimeout(t); done(false); });
  });
}

const STARTUP_PY = `
import bpy
# 插件可能已经启用（存在用户偏好里），重复启用只是无事发生；未启用时才真的启用
try:
    bpy.ops.preferences.addon_enable(module="blender_mcp")
except Exception as e:
    print("ADDON_ENABLE:", e)
try:
    bpy.ops.blendermcp.start_server()
    print("WENLV_MCP_STARTED", bpy.context.scene.blendermcp_port)
except Exception as e:
    print("WENLV_MCP_START_ERROR:", e)
`;

async function main() {
  console.log('启动 Blender 并开启 MCP 服务\n');

  if (await portOpen(PORT)) {
    console.log(`  ✓ ${PORT} 端口已经在监听 —— Blender MCP 已在运行，不重复启动。`);
    return;
  }

  const exe = findBlender();
  if (!exe) {
    console.log('  ✗ 没找到 Blender。可以设环境变量 BLENDER_EXE 指向 blender.exe，例如：');
    console.log('      set BLENDER_EXE=D:\\Blender\\blender.exe');
    process.exitCode = 1;
    return;
  }
  console.log(`  · Blender：${exe}`);

  // 把启动脚本写成文件再传给 Blender：比 --python-expr 少一层命令行转义风险
  const pyPath = path.join(ROOT, 'data', 'blender-start.py');
  fs.mkdirSync(path.dirname(pyPath), { recursive: true });
  fs.writeFileSync(pyPath, STARTUP_PY, 'utf8');

  console.log('  · 正在启动 Blender（会弹出一个窗口，这是必须的 —— 插件不支持后台模式）…');
  const child = spawn(exe, ['--python', pyPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();

  // 等端口起来。Blender 冷启动通常 5~15 秒，首次启用插件可能更久
  const deadline = Date.now() + 90000;
  process.stdout.write('  · 等待 MCP 服务就绪');
  while (Date.now() < deadline) {
    if (await portOpen(PORT)) {
      console.log(`\n  ✓ 已就绪：127.0.0.1:${PORT}`);
      console.log('\n现在可以在「设置 → Blender 动画」里生成移动动画了。');
      return;
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('\n  ✗ 90 秒内端口仍未监听。');
  console.log('    请看一下 Blender 窗口：侧栏（按 N）里有没有「MCP for Blender」面板，');
  console.log('    并确认 3D 视图右上角的端口是 ' + PORT + '。');
  process.exitCode = 1;
}

main().catch((e) => {
  console.error('启动脚本出错：', e.message);
  process.exitCode = 1;
});
