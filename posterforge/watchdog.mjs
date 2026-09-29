#!/usr/bin/env node
/**
 * watchdog.mjs —— 守门狗：谁停了就把它拉起来。
 *
 * 为什么需要它：这两个服务反复自己死（实测日志末尾是 ^C^C^C^C^C ——
 * 被 Ctrl+C 信号打死，不是崩溃；也可能是别的进程收控制台时被连带）。
 * 每次都要人工去拉，用户看到的就是"又打不开了"。
 *
 * 守三样：
 *   8800  海报站点（node server.mjs）
 *   8001  旅游规划（uvicorn app.main:app）—— 门户的 /wenlv/ 反代指向它
 *   11434 Ollama —— 站点也能自己拉，但这里一起守着，首屏就不用等
 *
 * 用法：node watchdog.mjs          （前台跑，Ctrl+C 停）
 *       node watchdog.mjs --once   （只检查一次，不循环；给测试用）
 *
 * 注意：它自己必须**脱离父进程**跑（见 启动看门狗.bat 用 WMI 起），
 * 否则父进程一收工它就跟着没了 —— 那样等于没守。
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(__dirname);                       // E:\deepseck
const LOG_DIR = path.join(__dirname, ".work", "logs");
const LOG = path.join(LOG_DIR, "watchdog.log");
const WENLV = path.join(REPO, "HikiTravel-main-repair", "backend");

mkdirSync(LOG_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG, line + "\n"); } catch { /* 日志写不进去不该影响守护 */ }
}

/** 火起来就不管的进程：detached + unref，活得比守门狗久 */
function spawnDetached(cmd, args, cwd) {
  const p = spawn(cmd, args, { cwd, detached: true, stdio: "ignore", windowsHide: true, shell: false });
  p.unref();
  return p.pid;
}

const SERVICES = [
  {
    name: "海报站点",
    port: 8800,
    path: "/api/health",
    start: () => spawnDetached("node", ["server.mjs", "--port", "8800"], __dirname),
  },
  {
    name: "旅游规划",
    port: 8001,
    path: "/api/health",
    start: () => spawnDetached("uv", ["run", "python", "-m", "uvicorn", "app.main:app",
      "--host", "127.0.0.1", "--port", "8001"], WENLV),
  },
  {
    name: "Ollama",
    port: 11434,
    path: "/api/tags",
    start: () => {
      const bin = [
        path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe"),
        "C:\\Program Files\\Ollama\\ollama.exe",
      ].find((p) => p && existsSync(p));
      if (!bin) throw new Error("找不到 ollama.exe");
      return spawnDetached(bin, ["serve"], path.dirname(bin));
    },
  },
];

async function isUp(svc, timeoutMs = 2500) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const r = await fetch(`http://127.0.0.1:${svc.port}${svc.path}`, { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

const once = process.argv.includes("--once");
const INTERVAL_MS = Number(process.env.PF_WATCH_INTERVAL || 20000);
// 刚拉起来还没就绪时不要立刻又拉一个 —— 记下"上次尝试时间"，给足启动窗口
const RETRY_GRACE_MS = 45000;
const lastTry = new Map();

async function tick() {
  for (const svc of SERVICES) {
    if (await isUp(svc)) { lastTry.delete(svc.port); continue; }
    const last = lastTry.get(svc.port) || 0;
    if (Date.now() - last < RETRY_GRACE_MS) continue;   // 还在启动窗口里，再等等
    lastTry.set(svc.port, Date.now());
    try {
      const pid = svc.start();
      log(`✗ ${svc.name}(${svc.port}) 不在 → 已拉起 pid=${pid}`);
    } catch (e) {
      log(`✗ ${svc.name}(${svc.port}) 不在，且拉起失败：${e.message}`);
    }
  }
}

log(`守门狗启动，监视 ${SERVICES.map((s) => s.port).join(" / ")}，每 ${INTERVAL_MS / 1000}s 检查一次`);
await tick();
if (once) { log("--once 模式，检查一轮后退出"); process.exit(0); }
setInterval(tick, INTERVAL_MS);
