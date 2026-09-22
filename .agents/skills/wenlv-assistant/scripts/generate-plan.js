#!/usr/bin/env node
/**
 * 生成「个性化文旅方案」—— 供 Agent 引擎（OpenClaw 等）通过 exec 调用的确定性脚本
 *
 * 作用：把 Agent 传来的结构化参数，转交给本项目本地服务（server.js）生成方案。
 *      这样 Agent 也能用上本项目的「样本库约束 + 输出质检 + 固定输出模板」，
 *      而不是让模型自由发挥。
 *
 * 用法示例：
 *   node scripts/generate-plan.js --city 杭州 --days 2 --budget 舒适 --crowd 情侣 \
 *        --interests 自然风光,美食 --diet 无
 *
 * 输出：纯文本（含质检提示 + Markdown 方案正文），适合 Agent 直接转述给用户。
 * 退出码：0 成功 / 1 失败（本地服务未启动或生成出错）
 */

const ENDPOINT = process.env.WENLV_ENDPOINT || 'http://127.0.0.1:8000';

const DEFAULTS = {
  city: '杭州',
  days: '2',
  budget: '舒适',
  crowd: '朋友',
  interests: '',
  diet: '无',
};

function parseArgs(argv) {
  const out = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--([a-zA-Z-]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2] !== undefined ? m[2] : argv[i + 1];
    if (val === undefined || String(val).startsWith('--')) continue;
    if (m[2] === undefined) i++;
    if (Object.prototype.hasOwnProperty.call(out, key)) out[key] = String(val);
  }
  return out;
}

/**
 * 把整段文本写到 stdout，并等它真的写完（而不是写完就退出）。
 *
 * 背景：Node 官方文档里写着，stdout 写**文件**时是同步的、写 **TTY** 时在
 * Windows 上是异步的、写**管道**时在 Windows 上也是**异步**的。
 * 而 Agent 引擎（OpenClaw 的 exec）拿到的正是管道 —— 脚本写完就结束、
 * 事件循环里没别的活，理论上存在"缓冲区还没发完进程就退了"这一类竞态。
 *
 * 说明：本地实测（同一请求、新旧两种写法各跑多次、文件与管道两种捕获方式）
 * **从未复现出截断**，输出始终完整。所以这里不是修 bug，只是把这个
 * 平台行为用一行 `await` 兜住 —— 代价为零，也不改变任何可观察行为。
 */
function writeStdout(text) {
  return new Promise((resolve, reject) => {
    process.stdout.write(text, (err) => (err ? reject(err) : resolve()));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const qs = new URLSearchParams({
    city: args.city,
    days: args.days,
    budget: args.budget,
    crowd: args.crowd,
    interests: args.interests,
    diet: args.diet,
  });
  const url = `${ENDPOINT}/api/quick-plan?${qs.toString()}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(180000) });
    const text = await res.text();
    if (!res.ok) {
      console.error(`【生成失败】服务返回 HTTP ${res.status}\n${text}`);
      process.exitCode = 1;
      return;
    }
    await writeStdout(text);
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      console.error('【生成失败】本地模型超过 180 秒未返回，请稍后重试。');
    } else {
      console.error(
        '【生成失败】无法连接本地文旅服务。\n' +
        `请确认服务已启动：在本项目目录双击 start.bat（或运行 node server.js），` +
        `默认地址 ${ENDPOINT}。`
      );
    }
    process.exitCode = 1;
  }
}

main();
