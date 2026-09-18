/**
 * openapi.js —— "对外开放"开关与令牌（入向接口的配置）
 *
 * 这个模块管的是反方向的事：不是本项目去调别人，而是**别人来调本项目**。
 * 对应交付物里那个 airi-bridge 的角色 —— 让 AIRI 之类的外部 Agent 能用标准
 * OpenAI 接口问到本项目的文旅能力、记忆和角色卡。
 *
 * 为什么要单独存一份配置、并且默认关闭：
 *   出向（配置别人的 Key）配错了只是自己用不了；
 *   入向（把 /v1/* 开出去）配错了是**别人能读到你的记忆和角色卡**。
 *   两者风险不对称，所以入向必须显式开启 + 显式令牌，不能跟着出向一起亮。
 *
 * 默认还开了 requireToken：即使忘了设令牌，也不至于变成"谁来都能读"。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_CONFIG = {
  version: 1,
  enabled: false,        // 总开关，默认关
  requireToken: true,    // 是否强制 Bearer 令牌
  token: '',             // 开启时若为空会自动生成一个
  // 暴露哪些能力。默认只开最必要的对话与模型列表；
  // 记忆和角色卡涉及个人数据，要用户自己勾。
  expose: {
    chat: true,          // /v1/chat/completions
    models: true,        // /v1/models
    embeddings: false,   // /v1/embeddings
    speech: false,       // /v1/audio/speech（本机 Qwen TTS）
    wenlv: true,         // /api/wenlv/generate（方案 / 文案）
    memory: false,       // /api/memory/*
    cards: false,        // /api/cards/*
  },
  updatedAt: 0,
};

function maskToken(t) {
  const s = String(t || '');
  if (!s) return '';
  if (s.length <= 10) return '****';
  return `${s.slice(0, 6)}****${s.slice(-4)}`;
}

function newToken() {
  return `wl-${crypto.randomBytes(24).toString('hex')}`;
}

function createOpenAPI({ dir, file = 'openapi.json' } = {}) {
  const filePath = path.join(dir, file);
  fs.mkdirSync(dir, { recursive: true });

  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  // 只放内存、不落盘：这类计数每来一个请求就写盘不值得，重启归零也无所谓
  const stats = { requests: 0, lastAt: 0, lastPath: '' };

  function load() {
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      config = {
        ...DEFAULT_CONFIG,
        ...raw,
        expose: { ...DEFAULT_CONFIG.expose, ...(raw.expose || {}) },
      };
      // 环境变量优先：方便容器/脚本化部署时不把令牌写进文件
      if (process.env.OPENAPI_TOKEN) config.token = process.env.OPENAPI_TOKEN;
      if (process.env.OPENAPI_ENABLED === '1') config.enabled = true;
    } catch (e) {
      console.error('[openapi] 配置文件损坏，已回退为"关闭"状态：', e.message);
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
      console.error('[openapi] 配置写入失败：', e.message);
    }
  }

  function regenerateToken() {
    config.token = newToken();
    persist();
    // 明文只在生成的这一刻回传一次，之后前端只能看到打码版
    return config.token;
  }

  function update(patch = {}) {
    const p = patch || {};
    if (p.enabled !== undefined) config.enabled = Boolean(p.enabled);
    if (p.requireToken !== undefined) config.requireToken = Boolean(p.requireToken);
    if (p.expose) {
      for (const k of Object.keys(DEFAULT_CONFIG.expose)) {
        if (p.expose[k] !== undefined) config.expose[k] = Boolean(p.expose[k]);
      }
    }
    if (p.regenerateToken === true) {
      const t = regenerateToken();
      persist();
      return { ...publicConfig(), tokenPlain: t };
    }
    // 开启但没令牌时自动补一个，避免出现"开了却谁都进不来"或者"开了且无鉴权"
    if (config.enabled && config.requireToken && !config.token) config.token = newToken();
    persist();
    return publicConfig();
  }

  function publicConfig() {
    return {
      enabled: config.enabled,
      requireToken: config.requireToken,
      hasToken: Boolean(config.token),
      tokenMasked: maskToken(config.token),
      expose: { ...config.expose },
      stats: { ...stats },
      updatedAt: config.updatedAt,
    };
  }

  /**
   * 校验一次入向请求。
   * 返回 { ok, code, error }，由调用方决定怎么回 —— 这个模块不碰 res。
   */
  function authorize(req) {
    if (!config.enabled) {
      return { ok: false, code: 'FORBIDDEN', error: '本项目没有对外开放。请到「设置 → 对外开放」里打开开关。' };
    }
    if (!config.requireToken) return { ok: true };

    const h = String((req.headers && req.headers.authorization) || '');
    const m = h.match(/^Bearer\s+(.+)$/i);
    const provided = m ? m[1].trim() : '';
    if (!provided) {
      return { ok: false, code: 'UNAUTHORIZED', error: '缺少 Authorization: Bearer <令牌> 请求头。' };
    }
    // 定长比较，避免用 === 逐字节短路带来的时序侧信道
    const a = Buffer.from(provided);
    const b = Buffer.from(config.token || '');
    const same = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!same) return { ok: false, code: 'UNAUTHORIZED', error: '令牌不正确。' };
    return { ok: true };
  }

  /** 某个能力是否被允许暴露 */
  function allows(kind) {
    return config.enabled && Boolean(config.expose[kind]);
  }

  function note(pathname) {
    stats.requests += 1;
    stats.lastAt = Date.now();
    stats.lastPath = pathname;
  }

  return {
    configPath: filePath,
    getConfig: () => config,
    publicConfig,
    update,
    regenerateToken,
    authorize,
    allows,
    note,
    /** 令牌明文，仅供本机服务内部/测试使用，不要塞进任何响应体 */
    rawToken: () => config.token,
  };
}

module.exports = { createOpenAPI, DEFAULT_CONFIG, newToken, maskToken };
