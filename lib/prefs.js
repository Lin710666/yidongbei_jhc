/**
 * prefs.js —— 应用级偏好（联网、定位、全景、Blender 等开关）
 *
 * 为什么不塞进 providers.json 或 openapi.json：
 *   那两份是"某一项能力"的配置，各管各的。而这里放的是**跨功能的开关**，
 *   并且后面几个功能（位置 MCP、全景建模、Blender 动画）都要加自己的段落。
 *   混进任何一份已有的配置里，都会让那份文件的语义变得含糊。
 *
 * 与项目里其它配置一致的三条：默认关闭、原子写、坏文件不让服务起不来。
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  version: 1,

  /**
   * 联网（给模型装工具）。
   * enabled 默认 false —— 这是本项目"默认不出网"原则的一部分：
   * 一旦打开，模型生成的查询词会被发到搜索引擎，URL 会被真的抓取。
   */
  web: {
    enabled: false,
    maxSteps: 4,                 // 工具循环最多几轮
    allowFetch: true,            // 是否允许 web_fetch 抓正文（只开搜索可更保守）
    allowPanorama: true,         // 是否允许 find_panorama
  },

  /**
   * 定位（② 位置 MCP）。
   *
   * enabled 默认 **true**：浏览器定位的数据只写到本机 data/location.json，
   *   不经过任何外部服务，而且用户必须主动点按钮 + 在浏览器弹窗里授权 ——
   *   那两步本身就是同意，再加一道设置开关只是徒增摩擦。
   * allowIpFallback 默认 **false**：IP 兜底会把请求发给第三方定位服务，
   *   属于"出网"，必须显式打开（与项目"默认不出网"的原则一致）。
   */
  location: {
    enabled: true,
    allowIpFallback: false,
  },

  /** 全景景区建模（③） */
  pano: {
    enabled: true,
    maxDownloadMB: 12,           // 单张全景图下载上限
    depthRelief: true,           // 是否用深度生成起伏地形
  },

  /** Blender 动画（⑤） */
  blender: {
    enabled: false,
    host: '127.0.0.1',
    port: 9876,
  },

  /**
   * 听觉（语音识别，本地 Whisper）。
   *
   * enabled 默认 **false** —— 这是全项目里唯一会打开麦克风的开关，默认必须关。
   *   理由不只是隐私：识别一跑就要 1~2GB 内存和几秒到几十秒的 CPU/GPU，
   *   在一个"随时可能只有 4.6GB 可用内存"的机器上，让它在用户没要求时就启动
   *   是最糟的默认值。所以开关关着时 lib/stt.js 的 transcribe 会在做任何工作
   *   之前直接返回"未启用"（连临时文件都不建）。
   * language 默认 zh：这是中文项目，绝大多数输入是中文；填 auto 会走 Whisper 的
   *   语言探测，但探测本身偶有判错，反而把中文听成日文，所以不设为默认。
   */
  stt: {
    enabled: false,
    language: 'zh',
  },

  /**
   * 显存仲裁（跨子系统，见 lib/gpu.js）。
   *
   * exclusive 默认 **true** —— 与项目里其它开关的默认值相反，这里默认就开。
   *   理由是它**不改变任何功能**，只是让吃显存的任务排队、并让 Ollama 临时让位；
   *   关掉它并不会"多出"能力，只会让 8GB 卡上出现随机的爆显存失败。
   *   显存充裕（比如 24GB）的机器可以关掉，省下那几百毫秒的让位/预热开销。
   *
   * warmup 默认 true：让位之后把对话模型预热回来，否则下一次提问要冷启动
   *   （本机实测冷启动十几秒，用户会以为卡住了）。
   * warmupDelayMs：独占任务连着来时不希望"卸-装-卸-装"来回折腾，
   *   所以延迟这么久再预热；这期间若又有独占任务就跳过本次预热。
   */
  gpu: {
    exclusive: true,
    warmup: true,
    settleMs: 900,               // 卸载 Ollama 后、启动吃显存任务前的缓冲
    warmupDelayMs: 2500,
    waitTimeoutMs: 180000,       // 排队等显存的上限，超了报可操作的错
  },

  /**
   * 开屏背景（大屏宣传用）。
   *
   * 为什么放在**服务端偏好**而不是浏览器的 localStorage：
   * 展厅场景是"配置一次、多块屏都用"，如果存 localStorage，每台机器的浏览器
   * 都要重新配一遍。放服务端才能真正做到"配一次，谁打开都是这个片子"。
   *
   * video   —— `data/videos/` 里的文件名；空则自动挑（优先名字带"西湖"的）。
   *            **本机文件，离线可用**。新片子用 `npm run fetch:bili -- <BV号> 名字` 下。
   * muted   —— 是否静音。默认 false（要有声音），但受浏览器自动播放策略限制，
   *            实际是"先静音起播、用户点开屏上的 🔊 之后才出声"。
   * fit     —— 画面模式：'rotate'（逆时针转 90°，默认；适合横拍片源被封装成竖屏的文件）/
   *            'cover'（铺满裁剪）/ 'auto'（模糊铺底 + 完整显示，不裁内容）。
   *
   * 早先这里存的是 B 站 bvid（内嵌官方播放器）。已经去掉那条路：
   * 播放器自带界面压不住、必须联网、竖屏片源会被摆成中间一条。
   */
  boot: {
    video: '',
    muted: false,
    fit: 'rotate',
  },

  /**
   * 主界面舞台的背景视频（大屏宣传用）。
   *
   * main —— `data/videos/` 里的文件名；空则自动挑（优先名字带"西湖"的）。
   *         与开屏背景**共用同一份片源与画面模式**（boot.fit），
   *         因为两处播的常常就是同一个文件，画面比例问题也一模一样。
   */
  video: {
    main: '',
  },

  updatedAt: 0,
};

/** 深合并一层子对象，避免以后加字段时老配置缺字段而崩 */
function mergeConfig(raw) {
  const out = { ...DEFAULT_CONFIG, ...(raw || {}) };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const def = DEFAULT_CONFIG[key];
    if (def && typeof def === 'object' && !Array.isArray(def)) {
      out[key] = { ...def, ...((raw && raw[key]) || {}) };
    }
  }
  return out;
}

function createPrefs({ dir, file = 'prefs.json' } = {}) {
  const filePath = path.join(dir, file);
  fs.mkdirSync(dir, { recursive: true });

  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  function load() {
    try {
      if (!fs.existsSync(filePath)) return;
      config = mergeConfig(JSON.parse(fs.readFileSync(filePath, 'utf8')));
      // 环境变量兜底：适合演示/脚本化场景
      if (process.env.WENLV_WEB === '1') config.web.enabled = true;
      if (process.env.WENLV_WEB === '0') config.web.enabled = false;
      if (process.env.WENLV_LOCATION === '1') config.location.enabled = true;
      // 听觉模块的开关也有环境变量兜底：自动化脚本/演示时不必去改 data/prefs.json。
      // 只给 '1' 这一条"打开"的通道，不给 '0' —— 默认就是关，"关"不需要兜底；
      // 而误把 WENLV_STT 设成 '0' 却以为打开了，是个很难查的坑。
      if (process.env.WENLV_STT === '1') config.stt.enabled = true;
    } catch (e) {
      console.error('[prefs] 偏好文件损坏，已回退为默认（全部关闭）：', e.message);
      try { fs.copyFileSync(filePath, `${filePath}.corrupt`); } catch { /* 忽略 */ }
      config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }
  load();

  function persist() {
    config.updatedAt = Date.now();
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (e) {
      console.error('[prefs] 偏好写入失败：', e.message);
    }
  }

  /**
   * 更新偏好。
   * 只认识的键才写：前端传错字段名时静默忽略，而不是把脏数据存进配置文件 ——
   * 否则一个拼错的键会永远留在文件里，下次排查时非常迷惑。
   */
  const SECTIONS = { web: ['enabled', 'maxSteps', 'allowFetch', 'allowPanorama'], location: ['enabled', 'allowIpFallback'], pano: ['enabled', 'maxDownloadMB', 'depthRelief'], blender: ['enabled', 'host', 'port'], stt: ['enabled', 'language'], gpu: ['exclusive', 'warmup', 'settleMs', 'warmupDelayMs', 'waitTimeoutMs'], boot: ['video', 'muted', 'fit'], video: ['main'] };

  function update(patch = {}) {
    for (const [section, keys] of Object.entries(SECTIONS)) {
      const p = patch[section];
      if (!p || typeof p !== 'object') continue;
      for (const k of keys) {
        if (p[k] === undefined) continue;
        if (typeof DEFAULT_CONFIG[section][k] === 'boolean') config[section][k] = Boolean(p[k]);
        else if (typeof DEFAULT_CONFIG[section][k] === 'number') {
          const n = Number(p[k]);
          if (Number.isFinite(n)) config[section][k] = n;
        } else config[section][k] = p[k];
      }
    }
    persist();
    return publicConfig();
  }

  function publicConfig() {
    return JSON.parse(JSON.stringify(config));
  }

  const isWebEnabled = () => Boolean(config.web.enabled);
  const isLocationEnabled = () => Boolean(config.location.enabled);

  return {
    configPath: filePath,
    getConfig: () => config,
    publicConfig,
    update,
    isWebEnabled,
    isLocationEnabled,
  };
}

module.exports = { createPrefs, DEFAULT_CONFIG, mergeConfig };
