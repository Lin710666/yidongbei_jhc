#!/usr/bin/env node
/**
 * deploy.mjs —— 一键部署：把一个空机器变成能跑的项目。
 *
 * 设计取舍：
 *   1. **只依赖 Node 和 Python**，不引入额外包管理器。这个项目本来就只有
 *      一个 Python 依赖（Pillow 等，见 renderer/requirements.txt）和零个 npm 依赖，
 *      为了"一键部署"再去装一堆部署框架是本末倒置。
 *   2. **每步都能单独重跑**。部署失败是常态（网络、权限、端口占用），
 *      所以每步先探测"是不是已经就绪"，就绪就跳过 —— 不用从头再来。
 *   3. **不猜路径**。原代码里写死了 `E:\devenv\Scripts\python.exe` 这类本机路径，
 *      换台机器就崩。这里改成：探测 → 探测不到就问用户 → 写进 .env。
 *   4. **不静默失败**。每步失败都打清楚原因和补救办法，而不是抛一句
 *      "部署失败"让用户猜。
 *
 * 用法：
 *   node deploy.mjs            正常部署
 *   node deploy.mjs --check    只体检，不改任何东西
 *   node deploy.mjs --force    忽略"已就绪"判断，全部重做
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PF = path.join(ROOT, "posterforge");
const RD = path.join(ROOT, "renderer");
const HK = path.join(ROOT, "hikitravel");

const CHECK_ONLY = process.argv.includes("--check");
const FORCE = process.argv.includes("--force");
const IS_WIN = process.platform === "win32";

let failed = 0;
const step = (n) => console.log(`\n\x1b[36m[${n}]\x1b[0m`);
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failed++; };
const info = (m) => console.log(`    ${m}`);

/** 跑一条命令，返回 {code, out}。不抛异常 —— 调用方自己判断。 */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8", timeout: opts.timeout || 600000,
    cwd: opts.cwd || ROOT, shell: false, windowsHide: true,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return { code: r.status, out: ((r.stdout || "") + (r.stderr || "")).trim(), err: r.error };
}

/** 命令存在吗 */
function has(cmd) {
  const r = IS_WIN ? run("where", [cmd], { timeout: 10000 }) : run("which", [cmd], { timeout: 10000 });
  return r.code === 0;
}

// ---------------------------------------------------------------- 1 环境体检
step("1/6 环境检查");
const env = { node: null, python: null, uv: null, ollama: null };

info(`操作系统 ${os.type()} ${os.release()} · ${os.arch()}`);
info(`CPU ${os.cpus().length} 核 · 内存 ${Math.round(os.totalmem() / 1024 ** 3)} GB`);

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 18) { env.node = process.execPath; ok(`Node ${process.versions.node}`); }
else bad(`Node 版本太低（${process.versions.node}），需要 18 以上`);

// Python：优先用 PATH 里的，其次找常见安装位置
// 为什么不写死路径：原代码写死了 E:\devenv\Scripts\python.exe，
// 换台机器就是一句"找不到文件"，用户完全不知道为什么。
//
// **必须能用 pip 才算数。** 踩过的坑：只检查 `python --version`，
// 结果挑中一个没有 pip 的解释器，下一步 `-m pip install` 才炸，
// 报的还是 "E:\python.exe: No module named pip" 这种看不出所以然的错。
// **第一优先级：brain.config.json 里已经写着的那个。**
// 它在这台机器上跑通过（站点正用它渲染），比 PATH 里随便挑一个可靠得多。
// 踩过的坑：只看 PATH，挑中一个没 pip 的解释器，还报出
// "E:\python.exe: No module named pip" 这种查不出所以然的错。
const cfgPy = [];
try {
  const c = JSON.parse(readFileSync(path.join(PF, "brain.config.json"), "utf8"));
  if (c.python && c.python !== "python") cfgPy.push(c.python);
} catch { /* 没配置就跳过 */ }

const pyCandidates = [
  ...cfgPy,
  ...(IS_WIN
    ? ["py", "python", "python3",
       path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python312", "python.exe"),
       path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python311", "python.exe"),
       path.join(os.homedir(), "AppData", "Local", "Programs", "Python", "Python310", "python.exe"),
       "C:\\Python312\\python.exe", "C:\\Python311\\python.exe", "C:\\Python310\\python.exe"]
    : ["python3", "python", "/usr/bin/python3", "/usr/local/bin/python3"]),
];
// **没有 pip 不等于没有 Python。**
// 这台机器就是反例：Python 好好的、Pillow 也装着，但 `-m pip` 不可用 ——
// 站点渲染一切正常。所以这里只按**版本**挑，pip 有没有记下来，
// 等第 3 步真需要装东西时再拿这个信息去提示（见那里的三种办法）。
const pyNotes = [];
for (const c of pyCandidates) {
  const isPath = c.includes(path.sep);
  if (isPath && !existsSync(c)) { pyNotes.push(`${c} 不存在`); continue; }
  const v = run(c, ["--version"], { timeout: 20000 });
  if (v.code !== 0 || !/Python 3\.(9|1\d|2\d)/.test(v.out)) { pyNotes.push(`${c} 版本不合适(${(v.out || v.code).toString().trim()})`); continue; }
  if (env.python) break;                       // 已经有了，别覆盖
  env.python = c;
  env.pip = run(c, ["-m", "pip", "--version"], { timeout: 60000 }).code === 0;
}
if (env.python) {
  ok(`Python → ${env.python}${env.pip ? "（pip 可用）" : "（**没有 pip**，见第 3 步）"}`);
} else {
  bad("找不到 Python 3.9+");
  info("试过这些：");
  pyNotes.slice(0, 6).forEach((n) => info("  · " + n));
  info("装一个：https://www.python.org/downloads/（安装时务必勾选 Add python.exe to PATH）");
}

// uv：HikiTravel 用 uv 管依赖。没有的话退回 pip/venv
if (has("uv")) { env.uv = "uv"; ok("uv（旅游规划后端的依赖管理器）"); }
else warn("没有 uv —— 旅游规划后端会退回 venv + pip（慢一些，但能用）");

// Ollama：没有也能跑，只是文案会退回确定性规则
const ollamaBin = IS_WIN
  ? [path.join(os.homedir(), "AppData", "Local", "Programs", "Ollama", "ollama.exe"),
     "C:\\Program Files\\Ollama\\ollama.exe"].find((p) => existsSync(p))
  : null;
if (ollamaBin || has("ollama")) { env.ollama = ollamaBin || "ollama"; ok("Ollama（本地模型）"); }
else warn("没有 Ollama —— 海报仍能生成，但文案会用内置规则而不是模型写（见 DEPLOY.md 第 4 节）");

if (CHECK_ONLY) {
  console.log(`\n体检结束${failed ? `，${failed} 项有问题` : "，环境没问题"}`);
  process.exit(failed ? 1 : 0);
}

// ---------------------------------------------------------------- 2 目录
step("2/6 运行目录");
for (const d of ["public/uploads", "public/generated", "public/copybooks", ".cache", ".work/logs"]) {
  const p = path.join(PF, d);
  if (!existsSync(p)) { mkdirSync(p, { recursive: true }); ok(`建了 ${d}`); }
}
ok("运行目录就绪");

// ---------------------------------------------------------------- 3 Python 依赖
step("3/6 Python 依赖（渲染引擎）");
// **先看能力，再看包管理器。**
//
// 踩过的坑：原来一上来就查 `-m pip --version`，没有 pip 就判"环境不合格"。
// 但这台机器的 Python 恰恰没有 pip，而 Pillow 早就装好了、站点渲染正常 ——
// 脚本却在报错。判断标准应该是"**能不能 import**"，不是"有没有 pip"。
// 依赖装法有很多种（pip / uv / 系统包 / 便携版自带），不该假设只有一种。
// **只把 Pillow 当必需，qrcode 当可选。**
// 踩过的坑：探测要求"PIL 和 qrcode 都在"，结果本机（PIL 有、qrcode 没有）
// 被判成"缺依赖"，而实际渲染完全正常 —— 二维码只是打卡卡上的可选图元。
// 判断必需依赖时把可选项也算进去，会凭空造出一个不存在的故障。
const probeMods = "import PIL;print(PIL.__version__)";
const probeQr = "import qrcode;print('+qr')";
const MODULES_OK = () => {
  const r = run(env.python || "python", ["-c", probeMods], { timeout: 60000 });
  if (r.code !== 0) return { ok: false, ver: "", why: r.out };
  const q = run(env.python || "python", ["-c", probeQr], { timeout: 60000 });
  return { ok: true, ver: r.out + (q.code === 0 ? " " + q.out : ""), qr: q.code === 0, why: r.out };
};
const req = path.join(RD, "requirements.txt");
let m = MODULES_OK();
if (m.ok && !FORCE) {
  ok(`Pillow ${m.ver.split(" ")[0]} 已装${m.qr ? " · qrcode 也有" : " · 没有 qrcode（可选，二维码不画）"}`);
} else {
  info("缺渲染依赖，尝试装…");
  const pipOK = run(env.python || "python", ["-m", "pip", "--version"], { timeout: 60000 }).code === 0;
  if (!pipOK) {
    bad("这个 Python 没有 pip，装不了依赖");
    info(`缺的是：${m.why.slice(-160)}`);
    info("三种办法，任选一种：");
    info("  · 装 pip：  " + (env.python || "python") + " -m ensurepip --upgrade");
    info("  · 换用 uv：uv pip install --python \"" + (env.python || "python") + "\" " + (existsSync(req) ? "-r " + req : "Pillow qrcode"));
    info("  · 手动装：  pip install Pillow qrcode");
    info("装完再跑一次 node deploy.mjs");
  } else if (existsSync(req)) {
    const r = run(env.python || "python", ["-m", "pip", "install", "-r", req], { timeout: 600000 });
    if (r.code === 0) ok("渲染依赖装好了");
    else bad(`装依赖失败：${r.out.slice(-300)}`);
  }
  // 装完复检一次 —— 不能只信安装命令的退出码
  if (!m.ok) {
    m = MODULES_OK();
    if (m.ok) ok(`复检通过：Pillow ${m.ver.split(" ")[0]}`);
  }
}

// ---------------------------------------------------------------- 4 旅游规划后端
step("4/6 旅游规划后端依赖");
if (existsSync(path.join(HK, "backend", "pyproject.toml")) || existsSync(path.join(HK, "backend", "requirements.txt"))) {
  const venv = path.join(HK, "backend", ".venv");
  if (existsSync(venv) && !FORCE) ok(".venv 已存在");
  else if (env.uv) {
    info("uv sync（第一次要几分钟）…");
    const r = run("uv", ["sync"], { cwd: path.join(HK, "backend"), timeout: 900000 });
    if (r.code === 0) ok("后端依赖装好了"); else bad(`uv sync 失败：${r.out.slice(-300)}`);
  } else {
    info("venv + pip（没有 uv，会慢一些）…");
    run(env.python || "python", ["-m", "venv", venv], { timeout: 180000 });
    const pip = path.join(venv, IS_WIN ? "Scripts" : "bin", IS_WIN ? "pip.exe" : "pip");
    const r = run(pip, ["install", "-r", "requirements.txt"], { cwd: path.join(HK, "backend"), timeout: 900000 });
    if (r.code === 0) ok("后端依赖装好了"); else bad(`pip 装依赖失败：${r.out.slice(-300)}`);
  }
} else warn("找不到后端依赖清单，跳过");

// ---------------------------------------------------------------- 5 前端构建
step("5/6 旅游规划前端");
const distIndex = path.join(HK, "frontend", "dist", "index.html");
if (existsSync(distIndex) && !FORCE) ok("已经构建过了（frontend/dist 有产物）");
else if (has("npm")) {
  info("npm install + build（第一次要几分钟）…");
  const cwd = path.join(HK, "frontend");
  const a = run("npm", ["install"], { cwd, timeout: 900000 });
  if (a.code !== 0) bad(`npm install 失败：${a.out.slice(-300)}`);
  else {
    const b = run("npm", ["run", "build"], { cwd, timeout: 900000 });
    if (b.code === 0) ok("前端构建好了"); else bad(`npm run build 失败：${b.out.slice(-300)}`);
  }
} else bad("没有 npm —— 装 Node.js 时会自带（https://nodejs.org）");

// ---------------------------------------------------------------- 6 配置
step("6/6 生成配置");
const cfgPath = path.join(PF, "brain.config.json");
const example = path.join(PF, "brain.config.example.json");
if (!existsSync(cfgPath)) {
  let cfg = {};
  if (existsSync(example)) { copyFileSync(example, cfgPath); cfg = JSON.parse(readFileSync(cfgPath, "utf8")); }
  // 把探测到的 Python 写进去 —— 原代码写死了本机路径，换机器就崩
  cfg.python = env.python || "python";
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
  ok("生成了 brain.config.json（已填入探测到的 Python 路径）");
} else {
  // 已存在也要校正 python 路径 —— 从别人机器上拷过来的配置多半是错的
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    if (cfg.python !== env.python && env.python) {
      cfg.python = env.python;
      writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
      ok("更新了 brain.config.json 里的 Python 路径");
    } else ok("brain.config.json 已是本机路径");
  } catch { warn("brain.config.json 读不出来，没动它"); }
}

// HikiTravel 的 .env：STATIC_DIR 不设的话它不服务前端
const hkEnv = path.join(HK, "backend", ".env");
const hkExample = path.join(HK, "backend", ".env.example");
if (!existsSync(hkEnv)) {
  const dist = path.join(HK, "frontend", "dist").replace(/\\/g, "/");
  const body = [
    "# 由 deploy.mjs 生成",
    "# 不设 STATIC_DIR 的话，后端起来也不服务前端页面（打开是 404）",
    `STATIC_DIR=${dist}`,
    "# 别让系统代理拦本机请求（本机代理会导致 502 / SSL EOF）",
    "NO_PROXY=127.0.0.1,localhost",
    "",
  ].join("\n");
  writeFileSync(hkEnv, body, "utf8");
  ok("生成了 hikitravel/backend/.env");
} else ok("hikitravel/backend/.env 已存在");

// ---------------------------------------------------------------- 汇总
console.log("\n" + "─".repeat(56));
if (failed) {
  console.log(`\x1b[31m部署没成功，${failed} 步有问题。\x1b[0m`);
  console.log("上面每步都写了原因。修完再跑一次 `node deploy.mjs` —— 已经就绪的会跳过。");
} else {
  console.log("\x1b[32m部署完成。\x1b[0m");
  console.log("\n启动：");
  console.log(IS_WIN ? "  双击  启动全部.bat" : "  ./start-all.sh");
  console.log("  或    node start.mjs");
  console.log("\n打开：http://127.0.0.1:8800/hub.html");
}
console.log("─".repeat(56) + "\n");
process.exit(failed ? 1 : 0);
