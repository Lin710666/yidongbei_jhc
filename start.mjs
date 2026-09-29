#!/usr/bin/env node
/**
 * start.mjs —— 一次把三个服务都起起来，并盯着它们别死。
 *
 * 三件事：
 *   1. 检查部署是否完成（没完成就提示先跑 deploy.mjs，而不是让你对着报错猜）
 *   2. 拉起三个服务：海报站点(8800) / 旅游规划(8001) / Ollama(11434)
 *   3. **守着它们** —— 实测这三个服务会自己死（日志里是 ^C 信号，
 *      不是崩溃），每次都要人工去拉，用户看到的就是"又打不开了"。
 *      所以启动和保活合成一个程序，不用先开这个再开那个。
 *
 * 用法：
 *   node start.mjs          前台跑（Ctrl+C 停，已起的服务不停）
 *   node start.mjs --once   只拉起，不守
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PF = path.join(ROOT, "posterforge");
const HK = path.join(ROOT, "hikitravel");
const IS_WIN = process.platform === "win32";
const ONCE = process.argv.includes("--once");
const INTERVAL = Number(process.env.WATCH_INTERVAL || 20000);
const LOG_DIR = path.join(PF, ".work", "logs");

mkdirSync(LOG_DIR, { recursive: true });
const log = (m) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${m}`; console.log(l); try { appendFileSync(path.join(LOG_DIR, "start.log"), l + "\n"); } catch {} };

/** 脱离父进程起服务：父进程退出后它要继续活 */
function detach(cmd, args, cwd) {
  const p = spawn(cmd, args, { cwd, detached: true, stdio: "ignore", windowsHide: true });
  p.unref();
  return p.pid;
}

const node = process.execPath;

// 旅游规划后端：有 uv 用 uv，没有就用 venv 里的 uvicorn
const hkBackend = path.join(HK, "backend");
const hasUv = spawnSync("uv", ["--version"], { encoding: "utf8", windowsHide: true }).status === 0;
const venvPy = path.join(hkBackend, ".venv", IS_WIN ? "Scripts" : "bin", IS_WIN ? "python.exe" : "python");

const SERVICES = [
  {
    name: "海报站点", port: 8800, url: "/api/health",
    start: () => detach(node, ["server.mjs", "--port", "8800"], PF),
  },
  {
    name: "旅游规划", port: 8001, url: "/api/health",
    start: () => hasUv
      ? detach("uv", ["run", "python", "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8001"], hkBackend)
      : detach(venvPy, ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8001"], hkBackend),
  },
  {
    name: "Ollama", port: 11434, url: "/api/tags",
    start: () => {
      const bin = [process.env.OLLAMA_BIN,
        path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe"),
        "C:\\Program Files\\Ollama\\ollama.exe", "ollama"].filter(Boolean)
        .find((p) => p === "ollama" || existsSync(p));
      if (!bin) throw new Error("找不到 ollama");
      return detach(bin, ["serve"], path.dirname(bin) || ROOT);
    },
  },
];

async function up(s) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(`http://127.0.0.1:${s.port}${s.url}`, { signal: ctl.signal, cache: "no-store" });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

// ---------------------------------------------------------------- 前置检查
if (!existsSync(path.join(PF, "server.mjs"))) {
  console.error("找不到 posterforge/server.mjs —— 目录不完整，先跑 node deploy.mjs");
  process.exit(1);
}
if (!existsSync(path.join(PF, "brain.config.json"))) {
  console.log("提示：还没跑过部署，brain.config.json 不存在。先跑 `node deploy.mjs`。\n");
}

// ---------------------------------------------------------------- 启动
log(`启动全部服务（共 ${SERVICES.length} 个）`);
const lastTry = new Map();
const GRACE = 45000;

async function tick(first) {
  for (const s of SERVICES) {
    if (await up(s)) { lastTry.delete(s.port); continue; }
    const lt = lastTry.get(s.port) || 0;
    if (!first && Date.now() - lt < GRACE) continue;   // 还在启动窗口，再等等
    lastTry.set(s.port, Date.now());
    try { log(`✗ ${s.name}(${s.port}) 不在 → 拉起 pid=${s.start()}`); }
    catch (e) { log(`✗ ${s.name}(${s.port}) 拉起失败：${e.message}`); }
  }
}

await tick(true);
if (!ONCE) {
  log(`守着三个端口，每 ${INTERVAL / 1000}s 检查一次。Ctrl+C 停止看守（已起的服务不停）。`);
  console.log(`\n  打开：\x1b[36mhttp://127.0.0.1:8800/hub.html\x1b[0m\n`);
  setInterval(() => tick(false), INTERVAL);
} else {
  log("--once：只拉起，不守");
}
