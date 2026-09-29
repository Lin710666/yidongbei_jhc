/**
 * aigen.mjs —— 本地出图客户端（不依赖 ComfyUI）。
 *
 * 和 comfy.mjs 的根本差别：
 *   comfy.mjs 需要一个**常驻的 ComfyUI 服务**（用户得手动点启动器，
 *   而那个启动器上印着 MiniMax-H3，与实际用的模型不符）。
 *   aigen.mjs 直接拉起一个 Python worker，用 diffusers 加载 SDXL-Turbo 出图，
 *   不需要任何 HTTP 服务在跑。
 *
 * 为什么要常驻 worker：
 *   冷进程每次都要把权重搬上卡。实测 768x1024 / 4 步：
 *       冷进程（含首次上卡）≈ 20 秒
 *       常驻进程后续每次   ≈ 6 秒
 *   所以在内存里留一个 worker，空闲超过 idleMs 再回收（回收是为了把显存让出来）。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

/** 只有 ComfyUI 便携版的 Python 装了 CUDA 版 torch 与 diffusers。 */
export const AIGEN_PYTHON = process.env.PF_AIGEN_PYTHON
  || "E:\\ComfyUI_windows_portable\\python_embeded\\python.exe";
export const AIGEN_SCRIPT = path.join(HERE, "aigen.py");
export const AIGEN_MODEL = process.env.PF_AIGEN_MODEL || "D:\\models\\sdxl-turbo";

/** 空闲多久回收 worker（毫秒）。回收后下一次出图要重新付一次上卡成本。 */
const IDLE_MS = Number(process.env.PF_AIGEN_IDLE_MS || 5 * 60 * 1000);
/** 出图超时。4 步通常 6~20 秒，给足余量但不至于挂死。 */
const GEN_TIMEOUT_MS = Number(process.env.PF_AIGEN_TIMEOUT_MS || 180000);

export class AigenError extends Error {
  constructor(message, stage) {
    super(message);
    this.name = "AigenError";
    this.stage = stage;
  }
}

/** 模型文件是否就位（缺文件时给明确提示，而不是等加载到一半才炸） */
export function checkModel(modelDir = AIGEN_MODEL) {
  const need = [
    "model_index.json",
    "unet/diffusion_pytorch_model.fp16.safetensors",
    "text_encoder/model.fp16.safetensors",
    "text_encoder_2/model.fp16.safetensors",
    "vae/diffusion_pytorch_model.fp16.safetensors",
  ];
  const missing = need.filter((f) => !existsSync(path.join(modelDir, f.replace(/\//g, path.sep))));
  return {
    dir: modelDir,
    exists: existsSync(modelDir),
    missing,
    ready: missing.length === 0,
  };
}

/** 环境是否具备出图条件 */
export function envCheck() {
  const problems = [];
  if (!existsSync(AIGEN_PYTHON)) problems.push(`找不到出图用的 Python：${AIGEN_PYTHON}`);
  if (!existsSync(AIGEN_SCRIPT)) problems.push(`找不到 aigen.py：${AIGEN_SCRIPT}`);
  const m = checkModel();
  if (!m.ready) problems.push(`模型文件不全（${m.dir}）：缺 ${m.missing.join("、")}`);
  return { ok: problems.length === 0, problems, model: m };
}

/* ------------------------------------------------------------------ worker */

let worker = null;          // { proc, ready }
let pending = null;         // { resolve, reject }
let idleTimer = null;
let lastError = null;

function killIdleTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function scheduleIdleKill() {
  killIdleTimer();
  idleTimer = setTimeout(() => {
    if (worker) {
      console.log("[aigen] worker 空闲超时，回收以释放显存");
      stopWorker();
    }
  }, IDLE_MS);
  // 不要因为这个定时器把进程吊住
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

export function stopWorker() {
  killIdleTimer();
  const w = worker;
  worker = null;
  if (pending) {
    pending.reject(new AigenError("worker 被停止", "stopped"));
    pending = null;
  }
  if (w?.proc && !w.proc.killed) {
    try { w.proc.stdin.write(JSON.stringify({ cmd: "exit" }) + "\n"); } catch { /* ignore */ }
    setTimeout(() => { try { w.proc.kill(); } catch { /* ignore */ } }, 1500);
  }
  return true;
}

function startWorker() {
  const env = envCheck();
  if (!env.ok) throw new AigenError(env.problems.join("；"), "env");

  const proc = spawn(AIGEN_PYTHON, [AIGEN_SCRIPT, "--serve"], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const state = { proc, ready: false };
  worker = state;

  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { console.warn("[aigen] 非 JSON 输出:", line.slice(0, 200)); continue; }

      if (msg.ready && msg.fatal === undefined) state.ready = true;

      if (pending) {
        const p = pending;
        pending = null;
        if (msg.ok) p.resolve(msg);
        else p.reject(new AigenError(msg.error || msg.fatal || "出图失败", "generate"));
      }
    }
  });

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (d) => {
    const s = String(d).trim();
    if (s) console.log("[aigen]", s.split("\n").slice(-2).join(" | "));
  });

  proc.on("exit", (code) => {
    if (worker === state) worker = null;
    if (pending) {
      const p = pending;
      pending = null;
      p.reject(new AigenError(`worker 退出（code=${code}）：${lastError || "无 stderr"}`, "crashed"));
    }
  });
  proc.on("error", (e) => {
    lastError = e.message;
    if (worker === state) worker = null;
  });

  return state;
}

/** 确保 worker 已就绪（已就绪则直接返回） */
async function ensureWorker() {
  if (worker?.ready) { scheduleIdleKill(); return worker; }
  const state = startWorker();
  // 等 ready 行；startWorker 里收到 ready 会置 state.ready
  const t0 = Date.now();
  while (!state.ready) {
    if (Date.now() - t0 > 240000) throw new AigenError("worker 启动超时（模型加载过慢）", "startup");
    if (worker !== state) throw new AigenError("worker 启动过程中退出", "startup");
    await new Promise((r) => setTimeout(r, 200));
  }
  scheduleIdleKill();
  return state;
}

/** 出图。prompt/out 必填，其余可选。 */
export async function generateImage({ prompt, out, width = 768, height = 1024, steps = 4, seed = 0 }) {
  if (!prompt) throw new AigenError("缺少 prompt", "input");
  if (!out) throw new AigenError("缺少输出路径", "input");
  await mkdir(path.dirname(out), { recursive: true });

  await ensureWorker();
  scheduleIdleKill();

  const msg = { cmd: "gen", prompt, out, width, height, steps, seed };
  const result = await new Promise((resolve, reject) => {
    pending = { resolve, reject };
    try {
      worker.proc.stdin.write(JSON.stringify(msg) + "\n");
    } catch (e) {
      pending = null;
      reject(new AigenError("写入 worker 失败：" + e.message, "ipc"));
      return;
    }
    setTimeout(() => {
      if (pending) {
        pending = null;
        reject(new AigenError(`出图超时（${GEN_TIMEOUT_MS}ms）`, "timeout"));
      }
    }, GEN_TIMEOUT_MS);
  });

  return result;
}

/** 中断：直接把 worker 杀掉（下一次出图会重新拉起） */
export function interrupt() {
  if (!worker) return false;
  stopWorker();
  return true;
}

/** 状态：给前端与健康检查用 */
export async function status() {
  const env = envCheck();
  return {
    running: env.ok && worker?.ready === true,
    // ready 表示"环境可用"（Python、脚本、模型文件都在位），与 worker 是否热着无关。
    // 注意别写成 env.ready —— envCheck() 返回的是 {ok, problems, model}，
    // ready 在 env.model 上。写错会恒为 undefined，于是 worker 空闲回收后
    // 前端那句 if (!data.ready) 会误报"本地出图环境不可用"。
    ready: env.ok,
    modelReady: env.model.ready,
    workerUp: worker?.ready === true,
    engine: "diffusers/SDXL-Turbo",
    modelDir: env.model.dir,
    missing: env.model.missing,
    problems: env.problems,
    python: AIGEN_PYTHON,
    message: env.ok
      ? (worker?.ready ? "本地出图就绪（已预热）" : "本地出图就绪（首次出图需加载模型，约 20 秒）")
      : env.problems.join("；"),
  };
}

/** 预热：把模型加载进 worker，避免用户第一次点 AI 背景时等 20 秒 */
export async function preload() {
  try {
    await ensureWorker();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
