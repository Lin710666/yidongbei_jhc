/**
 * warmup.js —— 把本机 Ollama 的模型提前加载进显存（预热）
 *
 * 为什么需要它：
 *   Ollama 默认 5 分钟不活动就把模型从显存卸掉，下次提问要重新从磁盘加载。
 *   本机实测（qwen2.5:7b 约 5GB，显卡 8GB）：
 *     冷启动首字 70.2 秒   ← 模型刚被卸载，正在加载
 *     热启动首字  0.2 秒   ← 模型还在显存里
 *   差 350 倍。答辩演示时用户隔几分钟回来问一句就干等一分多钟，观感很差。
 *   所以由 start.bat 在后台提前加载好，网页打开时模型已经在显存里了。
 *
 * 本脚本无论如何都以正常方式结束：预热失败不该影响启动流程。
 */
const OLLAMA = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '')
const KEEP_ALIVE = process.env.WENLV_KEEP_ALIVE || '30m'

/**
 * 预热必须用和应用一样的 num_ctx。
 * Ollama 按 (模型, 上下文长度) 维护各自的 runner，num_ctx 对不上就等于换了一个实例，
 * 权重要重新加载一遍——那样预热就完全白做了（实测过一次，这个问题很隐蔽）。
 * 角色卡里 小文 / 小柚 都是 8192，阿杭是 16384，这里对齐常见的 8192。
 */
const WARM_NUM_CTX = Number(process.env.WENLV_WARM_NUM_CTX || 8192)

const log = (m) => console.log(`[预热] ${m}`)

async function listModels() {
  const r = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(8000) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return ((await r.json()).models || []).map((m) => m.name)
}

/** 和 start.bat / lib/ollama.js 用同一套挑选优先级，避免预热了 A、实际用 B */
function pickChatModel(names) {
  return (
    names.find((n) => /^qwen2\.5:7b/.test(n)) ||
    names.find((n) => /^qwen3/.test(n)) ||
    names.find((n) => /^qwen2\.5/.test(n)) ||
    names[0]
  )
}

async function warm(model, label) {
  const t0 = Date.now()
  // 向量模型不是生成式模型，只能走 /api/embed，走 /api/generate 会 400
  const isEmbed = /embed/i.test(model)
  const url = isEmbed ? `${OLLAMA}/api/embed` : `${OLLAMA}/api/generate`
  const payload = isEmbed
    ? { model, input: 'hi', keep_alive: KEEP_ALIVE }
    : {
        model,
        prompt: 'hi',
        stream: false,
        keep_alive: KEEP_ALIVE,
        options: { num_predict: 1, num_ctx: WARM_NUM_CTX },   // 只要它把权重读进显存，不需要真的生成
      }
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(300000),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const d = await r.json()
  // /api/generate 会给 load_duration；/api/embed 不给，就只能报总耗时
  const load = d.load_duration ? `（其中加载 ${(d.load_duration / 1e9).toFixed(1)} 秒）` : ''
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  log(`${label}模型 ${model} 就绪：用时 ${secs} 秒${load}，保活 ${KEEP_ALIVE}`)
}

async function main() {
  let names
  try {
    names = await listModels()
  } catch (e) {
    log(`连不上本机 Ollama（${e.message}），跳过预热。其它功能不受影响。`)
    return
  }
  if (!names.length) {
    log('本机一个模型都没有，跳过预热。请先运行项目根目录的「检测并安装依赖.bat」。')
    return
  }

  const chatModel = pickChatModel(names)
  log(`开始预热对话模型 ${chatModel}（首次加载要 20~60 秒，这个窗口可以最小化，别关）`)
  try {
    await warm(chatModel, '对话')
  } catch (e) {
    log(`对话模型预热失败：${e.message}（不影响启动，只是第一次提问要等加载）`)
    return
  }

  // 向量模型只有 274MB，顺手加载，第一次做记忆语义检索就不用等
  const embed = names.find((n) => /embed/i.test(n))
  if (embed && embed !== chatModel) {
    try {
      await warm(embed, '向量')
    } catch (e) {
      log(`向量模型预热失败：${e.message}（不影响对话）`)
    }
  }

  log('预热完成。现在去网页提问，第一个字会立刻出来。')
}

main().catch((e) => log(`预热过程出异常：${e.message}（不影响启动）`))
