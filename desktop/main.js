/**
 * Electron 桌面外壳（HikiTravel AIRI 融合版）
 *
 * 设计要点和"为什么这么做"：
 *
 * ① **自带后端**。安装包里放一个 PyInstaller 打出来的 hiki-backend.exe，
 *    目标机器不需要装 Python。启动时由主进程拉起它、退出时杀掉它。
 *
 * ② **端口动态选**。写死 8000 在别人机器上很容易被占。这里先探一个空闲端口
 *    再把它传给后端（HIKI_PORT）。
 *
 * ③ **先显示加载页，再切到应用**。后端冷启动要一两秒，直接 loadURL 会白屏。
 *    所以先载入本地 loading.html，等 /api/ping 通了再跳转 —— 顺便把
 *    「正在启动本地服务…」这件事明确告诉用户，而不是让他对着白屏猜。
 *
 * ④ **启动失败要能自救**。后端起不来时显示错误页，给「重试」「打开日志」
 *    两个按钮，并把 stderr 落盘到 userData/backend.log —— 否则用户只能拿到
 *    "打不开"三个字，没法排查。
 */
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const isDev = !app.isPackaged;

/** 后端 exe 与前端 public/ 的位置：开发时在仓库里，打包后在 resources/ 下 */
function paths() {
  const res = process.resourcesPath || path.join(__dirname, '..');
  if (isDev) {
    return {
      exe: path.join(__dirname, 'dist-backend', 'hiki-backend', 'hiki-backend.exe'),
      publicDir: path.join(__dirname, '..', 'public'),
    };
  }
  return {
    exe: path.join(res, 'backend', 'hiki-backend.exe'),
    publicDir: path.join(res, 'public'),
  };
}

let win = null;
let backend = null;
let backendPort = 0;
let logStream = null;

function logFile() {
  return path.join(app.getPath('userData'), 'backend.log');
}

function logLine(s) {
  try {
    if (!logStream) logStream = fs.createWriteStream(logFile(), { flags: 'a' });
    logStream.write(`[${new Date().toISOString()}] ${s}\n`);
  } catch { /* 落盘失败不影响运行 */ }
}

/** 让系统分配一个空闲端口 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** 探测后端是否活着（用轻量的 /api/ping，不做外部调用，毫秒级） */
function ping(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/api/ping', timeout: timeoutMs },
      (res) => { res.resume(); resolve(res.statusCode === 200); },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitBackend(port, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await ping(port)) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function startBackend() {
  const { exe, publicDir } = paths();
  backendPort = await freePort();

  if (!fs.existsSync(exe)) {
    return { ok: false, error: `找不到后端程序：\n${exe}\n\n请先运行 desktop 里的后端打包脚本。` };
  }

  logLine(`启动后端 exe=${exe} port=${backendPort} static=${publicDir}`);

  backend = spawn(exe, [], {
    cwd: path.dirname(exe),
    env: {
      ...process.env,
      HIKI_PORT: String(backendPort),
      HIKI_HOST: '127.0.0.1',
      STATIC_DIR: publicDir,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      // 打包后 .env 不一定在旁边，明确给一份默认值
      OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  backend.stdout.on('data', d => logLine('[out] ' + d.toString().trim()));
  backend.stderr.on('data', d => logLine('[err] ' + d.toString().trim()));
  backend.on('exit', (code, sig) => {
    logLine(`后端退出 code=${code} signal=${sig}`);
    // 后端意外退出时告诉界面，而不是留一个点不动的空壳
    if (win && !win.isDestroyed()) win.webContents.send('backend-exited', { code, sig });
  });

  const ok = await waitBackend(backendPort);
  if (!ok) return { ok: false, error: `后端启动超时（端口 ${backendPort}）。\n日志：${logFile()}` };
  return { ok: true, port: backendPort };
}

function stopBackend() {
  if (backend && !backend.killed) {
    logLine('停止后端');
    try { backend.kill(); } catch { /* 忽略 */ }
    backend = null;
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 660,
    backgroundColor: '#0d1117',
    title: '智能文旅辅助系统',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // 外链一律用系统浏览器打开，别在应用窗口里把界面顶掉
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.loadFile(path.join(__dirname, 'renderer', 'loading.html')).catch(() => {});
  return win;
}

/* ------------------------------------------------------------------ IPC */
ipcMain.handle('app:boot', async () => {
  const r = await startBackend();
  return r.ok ? { ok: true, port: r.port } : { ok: false, error: r.error };
});

ipcMain.handle('app:goto', async (_e, port) => {
  if (!win) return false;
  await win.loadURL(`http://127.0.0.1:${port}/`);
  return true;
});

ipcMain.handle('app:retry', async () => {
  stopBackend();
  const r = await startBackend();
  return r.ok ? { ok: true, port: r.port } : { ok: false, error: r.error };
});

ipcMain.handle('app:openLog', async () => {
  try { await shell.openPath(logFile()); return true; } catch { return false; }
});

ipcMain.handle('app:openDevTools', async () => {
  if (win) win.webContents.openDevTools({ mode: 'detach' });
  return true;
});

/* --------------------------------------------------------------- 生命周期 */
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopBackend();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', stopBackend);
process.on('exit', stopBackend);
