/**
 * comfy.mjs —— ComfyUI 客户端：提交工作流 → 轮询 → 取回图片
 *
 * 设计要点：
 *   1. 用**官方模板的真实拓扑**（节点名、插槽顺序都从
 *      comfyui_workflow_templates_json/templates/image_qwen_image_2_1_t2i.json 取出），
 *      不是凭记忆拼的图。
 *   2. `/prompt` 的 API 格式与前端工作流 JSON 不同：需要把连线改写成
 *      {"node_id": {"inputs": {...}}}，输入从别的节点取时写成 [上游节点id, 输出槽位]。
 *   3. ComfyUI 是异步的：提交拿 prompt_id，再轮询 /history/{id} 直到出结果。
 *   4. 显存不够会失败，所以超时与错误都要如实返回，不能假装成功。
 *
 * 官方模板拓扑（Qwen-Image-2.1 文生图）：
 *   UNETLoader ──────────────► KSampler.model
 *   CLIPLoader ──────────────► TextEncodeQwenImage21.clip
 *   TextEncodeQwenImage21 ───► KSampler.positive / .negative
 *   EmptyLatentImage ────────► KSampler.latent_image
 *   VAELoader ───────────────► VAEDecode.vae
 *   KSampler ────────────────► VAEDecode.samples
 *   VAEDecode ───────────────► SaveImage.images
 */

const DEFAULT_HOST = process.env.COMFY_HOST || "127.0.0.1:8188";

// 官方模板里的默认文件名（已下载到 D:\ComfyUI-models）
export const DEFAULT_MODELS = {
  unet: "qwen_image_2.1_int8_convrot.safetensors",
  clip: "qwen3vl_8b_int8_convrot.safetensors",
  vae: "qwen_image_2.1_vae_bf16.safetensors",
};

// 成本更低的备选编码器（省 ~2.8 GB 显存）
export const LIGHT_CLIP = "qwen3vl_8b_w4a8.safetensors";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ComfyError extends Error {
  constructor(stage, message, detail) {
    super(message);
    this.stage = stage;
    this.detail = detail;
  }
}

async function jget(url, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function jpost(url, body, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`返回非 JSON（HTTP ${r.status}）: ${text.slice(0, 300)}`);
    }
    if (!r.ok) {
      // ComfyUI 的校验失败会带 node_errors，这是最有价值的排错信息
      const errs = data?.error;
      const nodeErrs = data?.node_errors;
      let msg = errs?.message || `HTTP ${r.status}`;
      if (nodeErrs && Object.keys(nodeErrs).length) {
        msg += " | 节点错误: " + JSON.stringify(nodeErrs).slice(0, 600);
      }
      throw new Error(msg);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

/** 探活 + 环境信息 */
export async function systemStats(host = DEFAULT_HOST) {
  const s = await jget(`http://${host}/system_stats`, 8000);
  const d = s.devices?.[0] || {};
  return {
    ok: true,
    version: s.system?.comfyui_version,
    python: (s.system?.python_version || "").split(" ")[0],
    device: d.name,
    vramTotalGB: d.vram_total ? +(d.vram_total / 1024 ** 3).toFixed(1) : null,
    vramFreeGB: d.vram_free ? +(d.vram_free / 1024 ** 3).toFixed(1) : null,
  };
}

export async function isUp(host = DEFAULT_HOST) {
  try {
    await systemStats(host);
    return true;
  } catch {
    return false;
  }
}

/** 检查模型文件是否在 ComfyUI 可见列表里 —— 提前发现"文件没放对位置" */
export async function checkModels(host = DEFAULT_HOST, models = DEFAULT_MODELS) {
  const info = await jget(`http://${host}/object_info`, 60000);
  const list = (node, field) => info?.[node]?.input?.required?.[field]?.[0] || [];
  const unets = list("UNETLoader", "unet_name");
  const clips = list("CLIPLoader", "clip_name");
  const vaes = list("VAELoader", "vae_name");
  return {
    unet: { want: models.unet, found: unets.includes(models.unet), available: unets },
    clip: { want: models.clip, found: clips.includes(models.clip), available: clips },
    vae: { want: models.vae, found: vaes.includes(models.vae), available: vaes },
    hasTextEncode: !!info["TextEncodeQwenImage21"],
  };
}

/**
 * 构造 Qwen-Image-2.1 文生图的 API 格式工作流。
 * 节点 id 沿用官方模板（451/452/453/454/456/457/458 + 900 SaveImage），
 * 便于把提交结果与官方模板对照排查。
 */
export function buildQwenT2IWorkflow({
  prompt,
  negativePrompt = "",
  width = 1024,
  height = 1024,
  steps = 25,
  cfg = 1,
  seed = 0,
  sampler = "euler",
  scheduler = "simple",
  filenamePrefix = "posterforge_bg",
  models = DEFAULT_MODELS,
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new ComfyError("build", "prompt 不能为空");
  }
  return {
    // 模型加载
    "451": {
      class_type: "UNETLoader",
      inputs: { unet_name: models.unet, weight_dtype: "default" },
    },
    "453": {
      class_type: "CLIPLoader",
      inputs: { clip_name: models.clip, type: "qwen_image", device: "default" },
    },
    "454": {
      class_type: "VAELoader",
      inputs: { vae_name: models.vae },
    },
    // 文本编码（Qwen 专用节点，输出 positive/negative 两路）
    "452": {
      class_type: "TextEncodeQwenImage21",
      inputs: {
        clip: ["453", 0],
        prompt: String(prompt),
        negative_prompt: String(negativePrompt || ""),
        resolution: Math.max(width, height), // 官方模板用长边作为 resolution
        // images 是 COMFY_AUTOGROW_V3 输入。纯文生图不给参考图，留空。
        images: {},
      },
    },
    // 空 latent
    "456": {
      class_type: "EmptyLatentImage",
      inputs: { width, height, batch_size: 1 },
    },
    // 采样
    "458": {
      class_type: "KSampler",
      inputs: {
        model: ["451", 0],
        positive: ["452", 0],
        negative: ["452", 1],
        latent_image: ["456", 0],
        seed,
        steps,
        cfg,
        sampler_name: sampler,
        scheduler,
        denoise: 1,
      },
    },
    // 解码
    "457": {
      class_type: "VAEDecode",
      inputs: { samples: ["458", 0], vae: ["454", 0] },
    },
    // 保存（官方模板用 SaveImageAdvanced，这里用更通用且输出能直接被 /view 取的 SaveImage）
    "900": {
      class_type: "SaveImage",
      inputs: { images: ["457", 0], filename_prefix: filenamePrefix },
    },
  };
}

/** 提交工作流，返回 prompt_id */
export async function queuePrompt(workflow, host = DEFAULT_HOST) {
  const data = await jpost(`http://${host}/prompt`, { prompt: workflow, client_id: "posterforge" });
  if (data.node_errors && Object.keys(data.node_errors).length) {
    throw new ComfyError("queue", "工作流校验失败", JSON.stringify(data.node_errors).slice(0, 800));
  }
  if (!data.prompt_id) {
    throw new ComfyError("queue", "未返回 prompt_id", JSON.stringify(data).slice(0, 400));
  }
  return data.prompt_id;
}

/** 轮询直到出结果；返回图片引用列表 */
export async function waitForResult(promptId, { host = DEFAULT_HOST, timeoutMs = 900000, intervalMs = 1500, onTick } = {}) {
  const t0 = Date.now();
  let lastNote = "";
  while (Date.now() - t0 < timeoutMs) {
    const hist = await jget(`http://${host}/history/${promptId}`, 15000);
    const entry = hist?.[promptId];
    if (entry) {
      const st = entry.status || {};
      if (st.status_str === "error" || st.completed === false) {
        const msgs = (st.messages || []).map((m) => JSON.stringify(m)).join(" | ");
        throw new ComfyError("execute", "ComfyUI 执行报错", msgs.slice(0, 900));
      }
      const images = [];
      for (const [nodeId, out] of Object.entries(entry.outputs || {})) {
        for (const img of out.images || []) {
          images.push({ nodeId, ...img });
        }
      }
      if (images.length) return { images, elapsedMs: Date.now() - t0 };
      if (st.status_str === "success") {
        throw new ComfyError("execute", "执行成功但没有图片输出", JSON.stringify(entry.outputs).slice(0, 400));
      }
    }
    // 进度可观测，便于判断是"在跑"还是"卡住了"
    try {
      const q = await jget(`http://${host}/queue`, 8000);
      const running = (q.queue_running || []).length;
      const pending = (q.queue_pending || []).length;
      const note = `队列 运行中 ${running} / 等待 ${pending}`;
      if (note !== lastNote) {
        lastNote = note;
        onTick?.({ note, elapsedMs: Date.now() - t0 });
      }
    } catch {
      /* 队列查询失败不影响主流程 */
    }
    await sleep(intervalMs);
  }
  throw new ComfyError("timeout", `等待超时（${Math.round(timeoutMs / 1000)} 秒）`, lastNote);
}

/** 取回图片二进制 */
export async function fetchImage(img, host = DEFAULT_HOST) {
  const url = `http://${host}/view?filename=${encodeURIComponent(img.filename)}` +
    `&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${encodeURIComponent(img.type || "output")}`;
  const r = await fetch(url);
  if (!r.ok) throw new ComfyError("fetch", `取图失败 HTTP ${r.status}`, url);
  return { buffer: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get("content-type") || "image/png" };
}

/**
 * 一步到位：文生图 → 返回第一张图的 Buffer。
 * 这是站点「AI 背景」开关背后真正执行的函数。
 */
export async function generateImage(opts, { host = DEFAULT_HOST, timeoutMs = 900000, onTick } = {}) {
  const workflow = buildQwenT2IWorkflow(opts);
  const promptId = await queuePrompt(workflow, host);
  const { images, elapsedMs } = await waitForResult(promptId, { host, timeoutMs, onTick });
  const first = images[0];
  const { buffer, contentType } = await fetchImage(first, host);
  return { buffer, contentType, promptId, filename: first.filename, elapsedMs, imageCount: images.length };
}

/** 中断当前执行（用户点取消，或超时后清理） */
export async function interrupt(host = DEFAULT_HOST) {
  try {
    await jpost(`http://${host}/interrupt`, {}, 8000);
    return true;
  } catch {
    return false;
  }
}
