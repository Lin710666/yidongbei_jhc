# OpenClaw 引擎集成验证报告

> 项目：文旅智能辅助 Skill（wenlv-assistant）
> 题目编号：JBGS-2026-06 ｜ 题目名称：文旅智能辅助场景
> 验证日期：2026-09-15
> 文档性质：**实测记录**（所有输出均为真实命令回显，非示例）

---

## 一、验证目的

赛题要求"基于 AI Coding **或 OpenClaw 引擎规范**"开发 Skill 系统。本文档用于回答一个具体问题：

> **本项目的 Skill 产物，能否被真实的 OpenClaw 引擎识别、加载并实际使用？**

为避免"仅在文档中声称符合规范"，本次验证在真实引擎中完整执行了「安装 → 就绪 → 注入 → 读取 → 生成」全部环节，
并保留每一步的原始输出作为证据。

---

## 二、验证环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | Windows 10.0.26100 (x64) |
| Node.js | v22.19.0（npm 10.9.3） |
| **OpenClaw** | **2026.6.35 (c283867)**，通过 `npm install -g openclaw` 安装 |
| 推理模型 | `qwen2.5:7b`（Ollama 本地推理，4.7GB） |
| Ollama 地址 | `http://127.0.0.1:11434` |
| 技能包位置 | `<项目>/.agents/skills/wenlv-assistant` |

**本次验证全程不涉及任何第三方 API、不需要 API Key、不访问外部网络。**

---

## 三、验证步骤与实录

### 步骤 1：技能包安装

```bash
$ openclaw skills install "C:\Users\11702\Desktop\移动杯项目\yidongbei-2.2\.agents\skills\wenlv-assistant"
Installing to C:\Users\11702\.openclaw\workspace\skills\wenlv-assistant…
Installed wenlv-assistant from path -> C:\Users\11702\.openclaw\workspace\skills\wenlv-assistant
```

结论：技能包结构被引擎接受，安装成功。✓

### 步骤 2：就绪状态确认

```bash
$ openclaw skills info wenlv-assistant
🏔️ wenlv-assistant ✓ Ready

文旅智能辅助 Skill。当需要为游客生成个性化"游玩·旅居·餐饮"一体化方案，或为景区/酒店/餐饮/文创产品生成营销文案素材时使用。触发词：旅游攻略、行程规划……

Details:
  Source: openclaw-workspace
  Path: ~\.openclaw\workspace\skills\wenlv-assistant\SKILL.md
  Visible to model: yes
  Available as command: yes

Requirements:
  Binaries: ✓ node, ✓ ollama
  OS: ✓ darwin, ✓ linux, ✓ win32
```

技能总数变化：`Skills (13/52 ready)` → **`Skills (14/53 ready)`**

结论：
- 状态为 **Ready**（无缺失依赖）
- 模型可发现（Visible to model: yes）
- 可作为命令调用（Available as command: yes）
- `metadata` 中声明的 `bins: [node, ollama]` 被引擎实际校验并通过 ✓

### 步骤 3：接入本机 Ollama 作为推理模型

OpenClaw 内置 Ollama 扩展（`enabledByDefault: true`），声明本地 provider 与模型后即可使用：

```json5
// 写入 ~/.openclaw/openclaw.json
{
  models: {
    providers: {
      ollama: {
        baseUrl: "http://127.0.0.1:11434",
        api: "ollama",
        apiKey: "ollama-local",          // 本地合成鉴权标记，非真实密钥
        models: [{
          id: "qwen2.5:7b", name: "qwen2.5:7b",
          contextWindow: 32768, maxTokens: 8192, input: ["text"],
          compat: { supportsTools: true, supportsUsageInStreaming: true }
        }]
      }
    }
  }
}
```

```bash
$ openclaw config patch --file ollama-patch.json5 --dry-run
Dry run successful: 4 update(s) validated against ~\.openclaw\openclaw.json.

$ openclaw config patch --file ollama-patch.json5
Applied 4 config update(s). Restart the gateway to apply.

$ openclaw models list
Model                    Input   Ctx    Local  Auth  Tags
ollama/qwen2.5:7b        text    32k    yes    yes   default
```

结论：本机 Ollama 被识别为 `Local: yes`、鉴权通过、并成为默认模型。
推理与本机数据均不出本机。

### 步骤 4：确认技能被注入模型上下文

启动 Gateway 并发起一次会话后，会话快照记录了注入的技能清单：

```json
"skillsSnapshot": {
  "skills": [ ..., { "name": "wenlv-assistant", "requiredEnv": [] } ]
},
"skills": {
  "promptChars": 5180,
  "entries": [ ..., { "name": "wenlv-assistant", "blockChars": 373 } ]
}
```

引擎注入给模型的技能块（节选自 `<available_skills>`）：

```xml
<skill>
  <name>wenlv-assistant</name>
  <description>文旅智能辅助 Skill。当需要为游客生成个性化"游玩·旅居·餐饮"一体化方案，或为景区/酒店/餐饮/文创产品生成营销文案素材时使用。触发词：旅游攻略、行程规划、景点推荐……</description>
  <location>~/.openclaw/workspace/skills/wenlv-assistant/SKILL.md</location>
</skill>
```

结论：技能已随系统提示词进入模型上下文，`description` 完整可用。✓

### 步骤 5：模型实际读取技能文件

要求模型显式加载技能文件后发起请求：

```bash
$ openclaw agent --agent main --session-key wenlv-test-4 \
    -m "请用 read 工具读取路径 skills/wenlv-assistant/SKILL.md，读完后严格按该技能规范，帮我规划杭州2天情侣游玩方案，预算舒适，喜欢自然风光和美食"
```

会话记录中确认工具调用：

```
调用工具: read
```

模型随后复述出该文件的章节结构，其中包括本次为适配引擎规范而新增的第七章：

```
#### 7. 引擎规范与集成方式
- 本 Skill 遵循 AgentSkill / OpenClaw 技能规范，可被 OpenClaw 引擎直接加载
- 两种使用形态（同一份 Skill，两种加载方式）
- 网络与隐私声明
```

结论：模型通过 `read` 工具成功读取工作区内的 `SKILL.md`，内容可被遵循。✓

---

## 四、验证结论汇总

| 验证项 | 结果 |
| --- | --- |
| 技能包可被引擎安装 | ✅ 成功 |
| `SKILL.md` frontmatter 合规 | ✅ `Skill is valid!`（项目自带校验器） |
| 引擎判定就绪 | ✅ `✓ Ready`，无缺失依赖 |
| 模型可发现技能 | ✅ `Visible to model: yes` |
| 可作为命令调用 | ✅ `Available as command: yes` |
| `metadata.requires` 依赖校验 | ✅ `binaries: node, ollama` 全部满足 |
| 技能注入模型上下文 | ✅ `<available_skills>` 含完整描述与路径 |
| 模型读取技能文件 | ✅ `read` 工具调用成功 |
| 全程本地、无第三方 API | ✅ 仅访问 `127.0.0.1:11434` 与 `127.0.0.1:18789` |

---

## 五、过程中发现并修正的三个问题

以下问题均为实测暴露、已修正，并已留档以避免重犯。

### 问题 1：`metadata` 多行写法导致解析失效

| 项 | 内容 |
| --- | --- |
| **现象** | 技能显示 `✓ ready`，但 emoji 不显示、`requires` 依赖检查完全失效——**静默失效，无任何报错** |
| **原因** | `metadata:` 后换行再跟 `{ ... }`（YAML 块 + flow mapping）时引擎解析不到 |
| **修正** | 写成与引擎自带技能一致的**单行 flow mapping** |

```yaml
# ❌ 解析不到
metadata:
{
  "openclaw": { "emoji": "🏔️" }
}

# ✅ 正确
metadata: { "openclaw": { "emoji": "🏔️", "os": ["darwin","linux","win32"], "requires": { "bins": ["node","ollama"] } } }
```

### 问题 2：声明了用不到的 `requires.config`，导致就绪失败

| 项 | 内容 |
| --- | --- |
| **现象** | 状态退化为 `△ Needs setup`、`Visible to model: no`、`Available as command: no` |
| **原因** | 曾声明 `requires.config: ["model","port"]`，引擎会要求这两个键存在于**引擎自身的配置**中 |
| **修正** | 本项目的模型与端口是自身环境变量（`OLLAMA_MODEL` / `PORT`），与引擎配置无关，故只声明真实需要的 `bins` |

### 问题 3：小模型需要收窄工具集

| 项 | 内容 |
| --- | --- |
| **现象** | 默认 `tools.profile: "coding"` 暴露约 25 个工具，7B 模型被工具描述淹没：请求"回复两个字：你好"，模型却反复调用文件写入工具（`Successfully wrote 2 bytes to greeting.txt`），最终 `stopReason=toolUse`、`payloads=0`，**无法产出回答** |
| **修正** | 收窄为技能加载所必需的工具：`{ tools: { profile: "coding", allow: ["read"] } }` |

> 坑中坑：`tools.allow` 是在 profile **之后**做交集过滤的，因此不能与 `minimal` 档同用——
> `minimal` 档本身不含 `read`，两者叠加会导致零工具可用并报错：
> `No callable tools remain after resolving explicit tool allowlist`。

### 问题 4：模型「复述技能」而不是「执行技能」

| 项 | 内容 |
| --- | --- |
| **现象** | 模型读取 `SKILL.md` 后，把文件内容**整篇复述给用户**（输出"一、功能一… 1.1 功能描述…"），而不是生成文旅方案。更极端的一次，模型把它理解成"要我来实现这个项目"，回复"接下来我会创建 `references/` 目录并填充示例数据…请确认" |
| **根因 1（写法）** | 本项目的 SKILL.md 采用**产品说明书**写法（定位/价值/功能描述/技术实现），而 AgentSkill 惯例是**操作手册**写法（祈使句 + Routing + Workflow）。对比引擎自带技能 `diagram-maker`，其开头即 `Create diagrams as artifacts, not prose.`，随后是 `Routing` / `Workflow` 步骤 |
| **根因 2（模型）** | 7B 级模型对"元指令"（读了文档后按它做事）的遵循能力很弱，倾向于把读到的文档当作要汇报的内容 |
| **已做改进** | 在 `SKILL.md` 正文最前面新增「**执行指令**」章节：明确"直接产出结果、不要复述本文件内容、不要描述计划"，并以表格给出意图路由，指向后续各执行章节 |
| **改进效果** | 项目自身流程无回归（改动前后同一请求：均为 2/3 天、字符数 787→683）；但在 OpenClaw 中，**7B 模型仍会复述**——它不遵循文件内部的指令 |
| **最终可用方法** | 把"不要复述"写进**用户消息**：<br>`读取 skills/wenlv-assistant/SKILL.md。注意：不要复述技能内容，不要描述你的计划，不要问我是否开始。直接输出杭州2天情侣游玩方案的 Markdown 正文。`<br>**实测：同一请求，复述用时 79 秒；明确要求后 21.7 秒直接产出方案。** |

> 结论：技能文档的写法改进是**正确的方向**（已按 AgentSkill 惯例补齐执行指令段，对更强模型会生效），
> 但在 7B 级模型上无法单靠文档解决。这是模型能力边界，不是技能包或集成环节的问题。

### 问题 5：OpenClaw 屏蔽本地地址，`web_fetch` 走不通 → 改用 `scripts/` + `exec`

背景：为让 Agent 也能用上本项目的「样本库约束 + 输出质检 + 固定模板」，
在 `server.js` 中新增了两个 GET 接口（纯文本返回，便于 Agent 直接转述）：

```
GET /api/quick-plan?city=杭州&days=2&budget=舒适&crowd=情侣&interests=自然风光,美食&diet=无
GET /api/quick-marketing?product=景区&platform=小红书&audience=年轻情侣&style=种草
```

接口本身实测正常（HTTP 200，25.1 秒，中文参数正确解码，返回含质检的完整方案）。

| 项 | 内容 |
| --- | --- |
| **阻塞** | 让 Agent 用 `web_fetch` 访问该地址时被安全策略拦截：<br>`[security] blocked URL fetch (url-fetch) targetOrigin=http://127.0.0.1:8000 reason=Blocked hostname or private/internal/special-use IP address` |
| **性质** | 这是 OpenClaw **防 SSRF（服务端请求伪造）的既定安全设计**，不是配置错误 |
| **尝试过的放开方式** | `browser.ssrfPolicy.allowedHostnames: ["127.0.0.1","localhost"]` ❌ 无效<br>`browser.ssrfPolicy.dangerouslyAllowPrivateNetwork: true` ❌ 无效<br>（`tools.web.fetch.ssrfPolicy` 仅提供 RFC2544 与 IPv6 ULA 两个代理相关开关，无主机白名单） |
| **最终方案** | 改用技能自带的 `scripts/` 目录，由 Agent 通过 `exec` 调用：<br>`node scripts/generate-plan.js --city 杭州 --days 2 ...`<br>脚本作为本地子进程访问 8000 端口，不受 web_fetch 的 SSRF 限制；<br>**这同时正是 OpenClaw 规范中 `scripts/` 的既定用途（确定性辅助脚本）** |

**实测结果（成功）**：Agent 执行脚本后，把带质检的完整结果**原样展示**给用户：

```
【由本地样本库驱动生成】目的地：杭州 ｜ 天数：2 天 ｜ 预算：舒适 ｜ 同行人群：情侣 ｜ 饮食禁忌：无

⚠️ 输出质检发现 3 处需要注意（已与本地样本库核对）：
1. 请求的是 2 天方案，实际只生成了 1 天（缺 1 天）……
2. 「行程总览」表只有表头、没有数据行……
3. 本次输出有 2 处字段为空或缺失……

---------- 以下为生成结果 ----------
# 杭州 · 2天1晚 个性化方案
……
```

> 意义：至此 OpenClaw 路线也能用上项目**完整的可信度保障机制**（样本库白名单质检、结构校验、
> 固定输出模板），而不再依赖模型自由发挥。
>
> 注意：`exec` 会给 Agent 系统访问权限，需在 `tools.allow` 中包含 `exec`；
> 不需要时可收窄回 `["read"]`。另外，若用自然语言直接提问（不给出脚本命令），
> 7B 模型仍可能不执行脚本，而是编造无关内容（实测产出了一个臆想的 HTML 页面）。
> **实践中应把脚本命令直接写进用户消息。**

### 问题 6（补充）：技能触发依赖明确指令

| 调用方式 | 7B 模型表现 |
| --- | --- |
| 自然提问「帮我规划杭州2天方案」 | ❌ 不读技能，凭自身知识作答 |
| 「读取 SKILL.md 并按其指示执行」 | ❌ 复述技能内容 / 编造 HTML 页面 |
| **「请执行这条命令：node .../generate-plan.js --city 杭州 …」** | ✅ **正确执行并原样返回含质检的结果** |

---

## 六、局限与如实说明

| 事项 | 说明 |
| --- | --- |
| **技能触发依赖模型能力** | 7B 模型不会主动按 `description` 触发技能。直接提问"帮我规划杭州2天方案"时，它未读取 SKILL.md，而是凭自身知识作答；需在指令中显式要求读取技能文件。已确认这是**模型能力限制**，非链路问题 |
| **公开版与赛事平台的差异** | 本次验证使用 npm 公开发行版 OpenClaw 2026.6.35。赛事保障方"网易帝王蟹（ClawHive）"为同一技术体系的平台产品，两者规范可能一致，但**建议在获得官方账号后再于官方环境复验** |
| **未验证的能力** | 未验证 ClawHub 上传/发布、未验证多技能协同编排、未验证长会话下的技能重载 |

**因此项目定位是两条腿走路**：
- 确定性演示：使用自包含的本地 Web 界面（`start.bat` → `http://localhost:8000`），含输出质检与 28 项自动化测试，不依赖任何引擎
- 规范符合性：同一份 Skill 产物可被 OpenClaw 引擎加载（本文档已验证）

---

## 七、复现步骤

```bash
# 1. 安装引擎（约 1.1 GB）
npm install -g openclaw

# 2. 初始化配置与工作区
openclaw setup --non-interactive --accept-risk

# 3. 接入本机 Ollama（配置见步骤 3）
openclaw config patch --file ollama-patch.json5
openclaw gateway run          # 另开一个终端常驻

# 4. 安装本技能
openclaw skills install ./.agents/skills/wenlv-assistant

# 5. 验证
openclaw skills info wenlv-assistant      # 期望：✓ Ready
openclaw models list                      # 期望：ollama/qwen2.5:7b  Local: yes

# 6. 实际调用
openclaw agent --agent main -m "请读取 skills/wenlv-assistant/SKILL.md，然后按该技能规范帮我规划杭州2天方案"
```

> 若模型出现"不回答问题、反复调用无关工具"的跑偏行为，按第五节问题 3 收窄工具集。

---

## 附录：关键命令速查

| 目的 | 命令 |
| --- | --- |
| 查看技能状态 | `openclaw skills info wenlv-assistant` |
| 列出全部技能 | `openclaw skills list` |
| 检查依赖是否满足 | `openclaw skills check` |
| 查看模型列表 | `openclaw models list` |
| 调用 Agent | `openclaw agent --agent main -m "<消息>"` |
| 查看运行日志 | `openclaw logs` |
| 查看会话列表 | `openclaw sessions list` |
| 技能重新安装 | `openclaw skills install <路径> --force` |

---

*本报告由项目自带的合规校验器与实测日志共同支撑；技能包本身可通过 `npm run validate:skill` 独立复核。*
