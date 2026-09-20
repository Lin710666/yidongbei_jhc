#!/usr/bin/env node
/**
 * SKILL.md frontmatter 合规校验器（零第三方依赖）
 *
 * 对应 AgentSkill / OpenClaw 技能规范中 quick_validate.py 的校验项：
 *   1. frontmatter 必须以 --- 开头，并且有闭合的 ---
 *   2. name / description 为必需字段，不可为空
 *   3. name 仅允许小写字母、数字、连字符；不能以连字符开头/结尾；不能出现连续连字符；长度 ≤ 64
 *   4. description 不得包含尖括号 < >（规范中明确用于防提示词注入 / HTML 混淆）；长度 ≤ 1024
 *   5. frontmatter 只允许规范白名单内的字段，出现额外键会被引擎判定为不合规
 *
 * 除规范必需项外，还会做一轮「技能包完整性」检查（缺文件只告警，不判失败）。
 *
 * 用法：
 *   node scripts/validate-skill.js            # 校验本脚本所在的技能包
 *   node scripts/validate-skill.js <技能目录>  # 校验指定目录
 *
 * 退出码：0 = 通过，1 = 不合规
 */

const fs = require('fs');
const path = require('path');

// 规范要求：name 最大长度
const NAME_MAX = 64;
// 规范要求：description 最大长度
const DESC_MAX = 1024;
// 规范要求：name 仅允许小写字母、数字、连字符
const NAME_RE = /^[a-z0-9-]+$/;
// 规范白名单（出现白名单以外的键会导致引擎判定不合规）
const ALLOWED_KEYS = [
  'name',
  'description',
  'homepage',
  'license',
  'allowed-tools',
  'user-invocable',
  'disable-model-invocation',
  'command-dispatch',
  'command-tool',
  'command-arg-mode',
  'metadata',
];

/** 提取 frontmatter 区块 */
function extractFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if ((lines[0] || '').trim() !== '---') {
    return { error: 'frontmatter 缺失：文件首行必须是 ---' };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { error: 'frontmatter 格式错误：找不到闭合的 ---' };
  }
  return { lines: lines.slice(1, end) };
}

/** 简易 frontmatter 解析：顶层 key + 支持缩进/多行值（如 metadata 的 flow mapping） */
function parseEntries(fmLines) {
  const entries = {};
  let currentKey = null;
  for (const raw of fmLines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) {
      currentKey = m[1];
      entries[currentKey] = m[2];
    } else if (currentKey) {
      entries[currentKey] += '\n' + line.trim();
    }
  }
  return entries;
}

/** 去掉值两端可能的引号 */
function cleanValue(v) {
  let s = String(v == null ? '' : v).trim();
  if (s.length >= 2) {
    const a = s[0];
    const b = s[s.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) s = s.slice(1, -1);
  }
  return s;
}

/**
 * 校验一个技能目录
 * @param {string} skillDir 含 SKILL.md 的目录
 * @returns {{ok: boolean, errors: string[], warnings: string[], passes: string[], info: object}}
 */
function validateSkillDir(skillDir) {
  const errors = [];
  const warnings = [];
  const passes = [];
  const info = {};

  const skillPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) {
    errors.push(`未找到 SKILL.md（技能包根目录必须有该文件）：${skillPath}`);
    return { ok: false, errors, warnings, passes, info };
  }

  const text = fs.readFileSync(skillPath, 'utf8');
  const fm = extractFrontmatter(text);
  if (fm.error) {
    errors.push(fm.error);
    return { ok: false, errors, warnings, passes, info };
  }
  passes.push('frontmatter 格式正确（首行为 --- 且有闭合 ---）');

  const entries = parseEntries(fm.lines);

  // ---- 白名单检查 ----
  const unexpected = Object.keys(entries).filter((k) => !ALLOWED_KEYS.includes(k));
  if (unexpected.length) {
    errors.push(
      `frontmatter 出现白名单以外的字段：${unexpected.join(', ')}\n` +
      `      允许的字段为：${ALLOWED_KEYS.join(', ')}`
    );
  } else {
    passes.push(`未出现白名单以外的字段（共 ${Object.keys(entries).length} 个字段）`);
  }

  // ---- name ----
  const name = cleanValue(entries.name);
  info.name = name;
  if (!name) {
    errors.push('name 为必需字段且不可为空');
  } else if (!NAME_RE.test(name)) {
    errors.push(`name 只能包含小写字母、数字与连字符，当前为 "${name}"`);
  } else if (name.startsWith('-') || name.endsWith('-')) {
    errors.push(`name 不能以连字符开头或结尾，当前为 "${name}"`);
  } else if (name.includes('--')) {
    errors.push(`name 不能包含连续连字符，当前为 "${name}"`);
  } else if (name.length > NAME_MAX) {
    errors.push(`name 长度 ${name.length} 超过上限 ${NAME_MAX}`);
  } else {
    passes.push(`name 合规：${name}（长度 ${name.length}/${NAME_MAX}）`);
  }

  // ---- description ----
  const desc = cleanValue(entries.description);
  info.descriptionLength = [...desc].length;
  if (!desc) {
    errors.push('description 为必需字段且不可为空');
  } else {
    const len = [...desc].length;
    if (/[<>]/.test(desc)) {
      errors.push('description 不能包含尖括号 < 或 >（规范用于防止提示词注入 / HTML 混淆）');
    }
    if (len > DESC_MAX) {
      errors.push(`description 长度 ${len} 超过上限 ${DESC_MAX}`);
    }
    if (!/[<>]/.test(desc) && len <= DESC_MAX) {
      passes.push(`description 合规：${len} 字符 / 上限 ${DESC_MAX}，且不含尖括号`);
    }
  }

  // ---- 技能包完整性（告警级，不判失败） ----
  const needFiles = [
    ['manifest.json', '权限声明文件（原生代码 Skill 必需，缺少会被沙箱限制）'],
    ['license.txt', '技能包许可与数据来源说明'],
  ];
  for (const [f, why] of needFiles) {
    if (fs.existsSync(path.join(skillDir, f))) {
      passes.push(`存在 ${f}`);
    } else {
      warnings.push(`缺少 ${f} —— ${why}`);
    }
  }
  for (const d of ['references', 'scripts']) {
    const p = path.join(skillDir, d);
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      const n = fs.readdirSync(p).length;
      if (n === 0) warnings.push(`${d}/ 目录为空`);
      else passes.push(`存在 ${d}/（${n} 项）`);
    } else {
      warnings.push(`缺少 ${d}/ 目录（规范约定的目录结构）`);
    }
  }

  // ---- manifest.json 可解析性 ----
  const mfPath = path.join(skillDir, 'manifest.json');
  if (fs.existsSync(mfPath)) {
    try {
      const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
      const net = mf.permissions && mf.permissions.network && mf.permissions.network.allow;
      if (Array.isArray(net)) {
        passes.push(
          net.length === 0
            ? 'manifest.json 可解析，且声明不需要外部网络（network.allow 为空）'
            : `manifest.json 可解析，声明可访问域名：${net.join(', ')}`
        );
      } else {
        warnings.push('manifest.json 未声明 permissions.network.allow');
      }
    } catch (e) {
      errors.push(`manifest.json 不是合法 JSON：${e.message}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings, passes, info };
}

module.exports = { validateSkillDir, ALLOWED_KEYS, NAME_MAX, DESC_MAX };

// ---- CLI ----
if (require.main === module) {
  const skillDir = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  console.log('SKILL.md 合规校验（AgentSkill / OpenClaw 规范）');
  console.log(`技能目录：${skillDir}\n`);

  const r = validateSkillDir(skillDir);
  r.passes.forEach((p) => console.log(`  \u2713 ${p}`));
  r.warnings.forEach((w) => console.log(`  ! ${w}`));
  r.errors.forEach((e) => console.log(`  \u2717 ${e}`));

  console.log('');
  if (r.ok) {
    console.log(r.warnings.length ? 'Skill is valid!（有告警，见上）' : 'Skill is valid!');
  } else {
    console.log(`校验未通过：${r.errors.length} 项错误`);
  }
  process.exitCode = r.ok ? 0 : 1;
}
