#!/usr/bin/env node
/**
 * 技能打包器：把技能目录打包成可分发的 .skill 文件（零第三方依赖）
 *
 * 对应 AgentSkill / OpenClaw 规范中 package_skill.py 的行为：
 *   1. 【打包前先校验】frontmatter 不合规则拒绝打包
 *   2. 排除 .git / node_modules / __pycache__ 等目录
 *   3. 条目按名称的 POSIX 词法顺序排序 —— 保证同一份技能在任何平台产出的
 *      .skill 字节级一致，便于哈希比对与发布审计（可复现构建）
 *   4. 不跟随符号链接（防止把技能目录外的文件包进来）
 *   5. 输出为 zip 格式的 .skill 文件
 *
 * 这里的 zip 是手写的（只用 Node 内置模块，store 模式不压缩），
 * 目的是保持项目「零第三方依赖」的特性。
 *
 * 用法：
 *   node scripts/package-skill.js              # 打包本技能，输出到项目 dist/
 *   node scripts/package-skill.js <技能目录> [输出目录]
 *
 * 退出码：0 = 成功，1 = 校验失败或打包失败
 */

const fs = require('fs');
const path = require('path');
const { validateSkillDir } = require('./validate-skill');

// 打包时应跳过的目录 / 文件
const SKIP = new Set(['.git', '.svn', '.hg', 'node_modules', '__pycache__', '.DS_Store', 'Thumbs.db']);

// ---- CRC32（zip 校验用） ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- 极简 ZIP 写入器（store 模式，无压缩，固定时间戳以保证可复现） ----
const DOS_TIME = 0;                                      // 00:00:00
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;    // 固定 2026-01-01

function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);

    // 本地文件头（30 字节 + 文件名）
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // 签名
    lh.writeUInt16LE(20, 4);           // 解压所需版本
    lh.writeUInt16LE(0x0800, 6);       // 标志位：文件名 UTF-8
    lh.writeUInt16LE(0, 8);            // 压缩方式 0 = store
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); // 压缩后大小
    lh.writeUInt32LE(data.length, 22); // 原始大小
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);           // 扩展字段长度
    localParts.push(lh, nameBuf, data);

    // 中央目录项（46 字节 + 文件名）
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);           // 创建版本
    ch.writeUInt16LE(20, 6);           // 解压所需版本
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);           // 扩展字段
    ch.writeUInt16LE(0, 32);           // 注释
    ch.writeUInt16LE(0, 34);           // 起始磁盘号
    ch.writeUInt16LE(0, 36);           // 内部属性
    ch.writeUInt32LE(0, 38);           // 外部属性
    ch.writeUInt32LE(offset, 42);      // 本地文件头偏移
    centralParts.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }

  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);       // 中央目录结束记录
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, central, eocd]);
}

/** 递归收集文件，跳过排除项，不跟随符号链接 */
function collectFiles(dir, base) {
  base = base || '';
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) {
      console.log(`  ! 跳过符号链接：${rel}`);
      continue;
    }
    if (entry.isDirectory()) out.push(...collectFiles(abs, rel));
    else if (entry.isFile()) out.push({ name: rel, abs });
  }
  return out;
}

function main() {
  const skillDir = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const outDir = path.resolve(process.argv[3] || path.join(__dirname, '..', '..', '..', '..', 'dist'));

  console.log('技能打包（.skill = zip 格式）');
  console.log(`技能目录：${skillDir}`);

  // 规范要求：打包前必须先校验
  const result = validateSkillDir(skillDir);
  if (!result.ok) {
    console.log('\n  \u2717 校验未通过，拒绝打包：');
    result.errors.forEach((e) => console.log(`      ${e}`));
    process.exitCode = 1;
    return;
  }
  console.log('  \u2713 校验通过（frontmatter 符合规范）');

  const name = result.info.name || path.basename(skillDir);
  const files = collectFiles(skillDir).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const entries = files.map((f) => ({ name: f.name, data: fs.readFileSync(f.abs) }));

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, name + '.skill');
  const zip = buildZip(entries);
  fs.writeFileSync(outPath, zip);

  console.log(`  \u2713 已打包 ${entries.length} 个文件`);
  entries.forEach((e) => console.log(`      ${e.name}  (${e.data.length} 字节)`));
  console.log(`\n输出：${outPath}  (${zip.length} 字节)`);
  console.log('提示：条目顺序固定、时间戳固定，因此同一份技能重复打包结果字节一致（可复现构建）。');
}

main();
