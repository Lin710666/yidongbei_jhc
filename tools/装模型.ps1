<#
装模型.ps1 —— 把从模之屋 / BOOTH / VRoid Hub 等平台下载到的虚拟形象装进本项目。

为什么需要这个脚本
------------------
项目的 README 与 public/models3d/README.md 都写着「首次使用先跑一次
tools\获取示例模型.bat」，但仓库里的 tools 目录**从来就不存在** —— 那条指令是空的。
缺的就是这样一段"把下载来的东西接到项目上"的胶水，而这个胶水并不显然：

  · 3D 形象：文件放 public/models3d/<目录>/，**同时**要在
    backend/app/data/models3d.json 的 bundled 里登记一条。
    后端 _models3d_bundled() 会拿 url 里的目录名去比对目录是否存在 ——
    目录不在的条目会被静默丢掉，所以"只复制文件不登记"和"只登记不放文件"
    **都不会显示，而且都不报错**。
  · Live2D 形象：文件放 public/models/<目录>/，登记在
    backend/app/data/capabilities.json 的 live2d 里（后端只认目录名）。

用法
----
3D（.vrm / .glb 单文件）：
  pwsh -File tools\装模型.ps1 -File 'C:\下载\国风少女.vrm' -Label '国风少女' -Id guofeng-girl

Live2D（给一个文件夹，里面要有 *.model3.json）：
  pwsh -File tools\装模型.ps1 -Live2D 'C:\下载\古风少女' -Label '古风少女' -Id gufeng-girl

卸载（登记的那条删掉，文件也一并移除）：
  pwsh -File tools\装模型.ps1 -Label x -Id guofeng-girl -Uninstall

参数
----
  -Label      显示在「更换人物形象」里的名字（必填）
  -Id         目录名 / 清单 id。留空会从 -Label 推 ASCII 短名；推不出来必须自己给
  -Note       出处说明（建议写清来源页与授权，会一起写进「借物表.md」）
  -Tags       标签，例如 -Tags '国风','自制'
  -Author     作者 / 发布者（写进借物表）
  -Source     来源页面 URL（写进借物表）
  -Force      目录或 id 已存在时也照样覆盖
  -Uninstall  按 -Id 卸载

做完会自动验证：调一次 /api/models3d 或 /api/capabilities 把那一条打出来。
服务没在跑也没关系，脚本会提示重启后再看。注意页面资源是**自动带版本号**的，
刷新一次就能拿到新清单，不需要清缓存。
#>
[CmdletBinding()]
param(
  [string]$File,
  [string]$Live2D,
  [Parameter(Mandatory = $true)][string]$Label,
  [string]$Id = '',
  [string]$Note = '',
  [string[]]$Tags = @(),
  [string]$Author = '',
  [string]$Source = '',
  [switch]$Force,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot          # tools/ 的上一级 = 项目根
if (-not (Test-Path (Join-Path $root 'public\index.html'))) {
  throw "这里看起来不是项目根（没找到 public\index.html）：$root"
}

$M3D_JSON = Join-Path $root 'backend\app\data\models3d.json'
$CAP_JSON = Join-Path $root 'backend\app\data\capabilities.json'
$BIND_TXT = Join-Path $root '借物表.md'

# ---------------------------------------------------------------- 小工具

function Read-Utf8([string]$p) { [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8) }
function Write-Utf8([string]$p, [string]$t) {
  # 不带 BOM：这几个文件本来就是 UTF-8 无 BOM
  [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($false)))
}

function Esc-Json([string]$s) {
  if ($null -eq $s) { return '' }
  return $s.Replace('\', '\\').Replace('"', '\"').Replace("`r", '').Replace("`n", '\n')
}

function New-Slug([string]$s) {
  $t = $s.ToLowerInvariant()
  $t = [regex]::Replace($t, '[^a-z0-9]+', '-').Trim('-')
  return $t
}

function Tag-Json([string[]]$list) {
  # 清单里 tags 是一行一个，缩进 8 格
  return (($list | ForEach-Object { '        "' + (Esc-Json $_) + '"' }) -join ",`n")
}

<#
写回 JSON 清单的唯一入口。

这个脚本改的是**组员维护**的数据文件，写坏了整个形象列表都会挂，
所以这里三层保险：
  1. 先归一化几个"删条目"时最容易留下的毛病（双逗号、`[ , ]`）
  2. **先校验再写** —— JSON 不合法就根本不落盘，宁可报错什么都不改
  3. 落盘前留一份 .bak，写完确认没问题再删

（踩过的坑：删条目之后留下过 `"bundled": [],,` —— 双逗号。当时是先写后查，
  于是坏文件真的落到盘上了，只能手工修。所以现在改成先查后写。）
#>
function Write-Json-Checked([string]$path, [string]$text) {
  $text = [regex]::Replace($text, ',\s*,', ',')          # 双逗号
  $text = [regex]::Replace($text, ',\s*\]', "`n  ]")     # 尾巴多余的逗号
  try {
    $null = $text | ConvertFrom-Json
  } catch {
    throw "生成出来的 JSON 不合法，**没有写入任何东西**（$path）：$($_.Exception.Message)"
  }
  $bak = "$path.bak"
  Copy-Item -LiteralPath $path -Destination $bak -Force
  try {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
    $null = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
    Remove-Item -LiteralPath $bak -Force -ErrorAction SilentlyContinue
  } catch {
    Copy-Item -LiteralPath $bak -Destination $path -Force
    throw "写入后校验失败，已回滚到备份：$($_.Exception.Message)"
  }
}

function Inline-Json([string[]]$list) {
  return (($list | ForEach-Object { '"' + (Esc-Json $_) + '"' }) -join ', ')
}

# 清单里每一条都是"没有嵌套对象的对象"（只有数组），所以 [^{}] 这个模式能
# 精确圈住一整条，不会误伤邻居。加 id 限定后就是"找到这一条"。
function Find-Entry([string]$text, [string]$id) {
  return [regex]::Match($text, '(?s)\{[^{}]*?"id"\s*:\s*"' + [regex]::Escape($id) + '"[^{}]*?\}')
}

# ---------------------------------------------------------------- 参数

# -Tags 做个归一化。
#
# 坑：`pwsh -File tools\装模型.ps1 -Tags '国风','测试'` 这种调用方式里，
# -File **不会**把 '国风','测试' 当数组 —— 它是原样一个字面量字符串传进来，
# 连引号都在。结果 tags 里变成一条 "'国风','测试'"（实测踩过）。
# 所以这里统一拆一次（分隔符 , ， 、 + 去掉包裹的引号），让
#   · 从 .bat / pwsh -File 调用（字符串）
#   · 在 PowerShell 里直接调用（真数组）
# 两种都对。
$Tags = @($Tags) |
  ForEach-Object { $_ -split '[,，、]' } |
  ForEach-Object { $_.Trim().Trim("'").Trim('"').Trim() } |
  Where-Object { $_ }

if (-not $Id) {
  $Id = New-Slug $Label
  if (-not $Id) {
    throw "从「$Label」推不出 ASCII 短名，请用 -Id 指定，例如 -Id guofeng-girl"
  }
}

$mode = if ($File) { '3d' } elseif ($Live2D) { 'live2d' } else { $null }
if (-not $Uninstall -and -not $mode) {
  throw "要么给 -File（.vrm/.glb），要么给 -Live2D（文件夹）"
}

# ---------------------------------------------------------------- 卸载

if ($Uninstall) {
  $removed = @()
  foreach ($p in @("public\models3d\$Id", "public\models\$Id")) {
    $abs = Join-Path $root $p
    if (Test-Path $abs) { Remove-Item -LiteralPath $abs -Recurse -Force; $removed += $p }
  }
  foreach ($j in @($M3D_JSON, $CAP_JSON)) {
    $raw = Read-Utf8 $j
    $m = Find-Entry $raw $Id
    if ($m.Success) {
      $start = $m.Index
      $end = $m.Index + $m.Length
      # 顺手把后面的逗号也吃掉，免得留下 [ , ] 这种坏 JSON
      while ($end -lt $raw.Length -and $raw[$end] -match '[\s,]') { $end++ }
      $new = $raw.Substring(0, $start) + $raw.Substring($end)
      $new = $new -replace ',\s*\]', "`n  ]"          # 尾巴多余的逗号
      # 删空了就把数组收回成一行 []，别留个 "[ \n ]" 的空壳（纯粹为了 diff 好看）
      $new = [regex]::Replace($new, '"bundled"\s*:\s*\[\s*\]', '"bundled": [],')
      $new = [regex]::Replace($new, '"live2d"\s*:\s*\[\s*\]', '"live2d": [],')
      Write-Json-Checked $j $new
      $removed += (Split-Path -Leaf $j)
    }
  }
  if ($removed) { "已卸载 $Id :"; $removed | ForEach-Object { "  $_" } } else { "没找到 $Id 的痕迹" }
  return
}

# ---------------------------------------------------------------- 安装

$relDir = $null
$where  = $null

if ($mode -eq '3d') {
  if (-not (Test-Path -LiteralPath $File)) { throw "找不到文件：$File" }
  $ext = [System.IO.Path]::GetExtension($File).ToLowerInvariant()
  if ($ext -ne '.vrm' -and $ext -ne '.glb') {
    throw "网页端只认 .vrm / .glb 两种（.$ext 得先转格式：Blender 导出 glTF-Binary 即可）"
  }
  $leaf   = Split-Path -Leaf $File
  $relDir = "public/models3d/$Id"
  $absDir = Join-Path $root ($relDir -replace '/', '\')
  if ((Test-Path $absDir) -and -not $Force) { throw "$relDir 已存在；要覆盖请加 -Force" }
  New-Item -ItemType Directory -Path $absDir -Force | Out-Null
  Copy-Item -LiteralPath $File -Destination (Join-Path $absDir $leaf) -Force

  $fmt   = if ($ext -eq '.vrm') { 'vrm' } else { 'glb' }
  $bytes = (Get-Item -LiteralPath (Join-Path $absDir $leaf)).Length
  $url   = "/models3d/$Id/$leaf"
  $tagList = @($Tags); if (-not $tagList.Count) { $tagList = @('3D / ' + $fmt.ToUpperInvariant(), '本地导入') }

  # 目录里留一张 manifest.json（给人看的；后端不读它）
  $mf = "{`n  `"label`": `"$(Esc-Json $Label)`",`n  `"note`": `"$(Esc-Json $Note)`",`n  `"tags`": [ $(Inline-Json $tagList) ],`n  `"kind`": `"3d`"`n}`n"
  Write-Utf8 (Join-Path $absDir 'manifest.json') $mf

  $entry = "    {`n"
  $entry += "      `"id`": `"$(Esc-Json $Id)`",`n"
  $entry += "      `"label`": `"$(Esc-Json $Label)`",`n"
  $entry += "      `"note`": `"$(Esc-Json $Note)`",`n"
  $entry += "      `"tags`": [`n$(Tag-Json $tagList)`n      ],`n"
  $entry += "      `"kind`": `"3d`",`n"
  $entry += "      `"format`": `"$fmt`",`n"
  $entry += "      `"url`": `"$url`",`n"
  $entry += "      `"preview`": null,`n"
  $entry += "      `"bundled`": true,`n"
  $entry += "      `"bytes`": $bytes`n"
  $entry += "    }"

  $raw = Read-Utf8 $M3D_JSON
  $old = Find-Entry $raw $Id
  if ($old.Success) {
    if (-not $Force) { throw "models3d.json 里已经有 id=$Id 了；要替换请加 -Force" }
    $raw = $raw.Substring(0, $old.Index) + $entry + $raw.Substring($old.Index + $old.Length)
  } elseif ($raw -match '"bundled"\s*:\s*\[\s*\]') {
    $raw = [regex]::Replace($raw, '"bundled"\s*:\s*\[\s*\]', "`"bundled`": [`n$entry`n  ]", 1)
  } else {
    $m = [regex]::Match($raw, '"bundled"\s*:\s*\[')
    if (-not $m.Success) { throw "models3d.json 里找不到 bundled 数组" }
    $at = $m.Index + $m.Length
    $raw = $raw.Substring(0, $at) + "`n$entry," + $raw.Substring($at)
  }
  Write-Json-Checked $M3D_JSON $raw
  $where = 'backend/app/data/models3d.json'
}

if ($mode -eq 'live2d') {
  if (-not (Test-Path -LiteralPath $Live2D)) { throw "找不到文件夹：$Live2D" }
  $srcDir = (Resolve-Path -LiteralPath $Live2D).Path
  $relDir = "public/models/$Id"
  $absDir = Join-Path $root ($relDir -replace '/', '\')
  if ((Test-Path $absDir) -and -not $Force) { throw "$relDir 已存在；要覆盖请加 -Force" }
  New-Item -ItemType Directory -Path $absDir -Force | Out-Null

  # 只搬模型本身要用的东西，跳过压缩包与说明文档。
  #
  # ⚠ 这里**不能跳过 .png / .jpg**：Live2D 的纹理就是 png，跳掉模型直接废。
  #   （第一版把 png/jpg 当"说明图"一起跳了，那样装出来的模型加载不出贴图。）
  #   预览图那点体积不值得冒这个险，全留着。
  $skip = '\.(zip|rar|7z|txt|md|url|lnk|psd|exe|dll)$'
  $copied = 0
  foreach ($f in (Get-ChildItem -LiteralPath $srcDir -Recurse -File)) {
    $rel = $f.FullName.Substring($srcDir.Length + 1)
    if ($rel -match $skip) { continue }
    $dest = Join-Path $absDir $rel
    $d = Split-Path -Parent $dest
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
    $copied++
  }

  $m3 = Get-ChildItem -LiteralPath $absDir -Recurse -Filter '*.model3.json' -File |
        Sort-Object { $_.FullName.Length } | Select-Object -First 1
  if (-not $m3) {
    throw "在 $Live2D 里没找到 *.model3.json —— 这可能不是 Live2D 模型（是不是下成了 MMD 的 .pmx？）"
  }
  $entryRel = ($m3.FullName.Substring($absDir.Length + 1)) -replace '\\', '/'
  $entryUrl = "/models/$Id/$entryRel"
  $texCount = (Get-ChildItem -LiteralPath $absDir -Recurse -File -Include '*.png', '*.jpg' |
               Where-Object { $_.Name -notmatch '^texture' -or $true } | Measure-Object).Count

  $tagList = @($Tags); if (-not $tagList.Count) { $tagList = @('Live2D', '本地导入') }

  $entry = "    {`n"
  $entry += "      `"id`": `"$(Esc-Json $Id)`",`n"
  $entry += "      `"label`": `"$(Esc-Json $Label)`",`n"
  $entry += "      `"note`": `"$(Esc-Json $Note)`",`n"
  $entry += "      `"tags`": [`n$(Tag-Json $tagList)`n      ],`n"
  $entry += "      `"entry`": `"$entryUrl`",`n"
  $entry += "      `"preview`": null,`n"
  $entry += "      `"expressions`": [],`n"
  $entry += "      `"motionGroups`": [],`n"
  $entry += "      `"motionCount`": 0,`n"
  $entry += "      `"hasLipSync`": true,`n"
  $entry += "      `"textureCount`": $texCount`n"
  $entry += "    }"

  $raw = Read-Utf8 $CAP_JSON
  $old = Find-Entry $raw $Id
  if ($old.Success) {
    if (-not $Force) { throw "capabilities.json 里已经有 id=$Id 了；要替换请加 -Force" }
    $raw = $raw.Substring(0, $old.Index) + $entry + $raw.Substring($old.Index + $old.Length)
  } else {
    $m = [regex]::Match($raw, '"live2d"\s*:\s*\[')
    if (-not $m.Success) { throw "capabilities.json 里找不到 live2d 数组" }
    $at = $m.Index + $m.Length
    $rest = $raw.Substring($at)
    $sep = if ([regex]::IsMatch($rest, '^\s*\]')) { '' } else { ',' }
    $raw = $raw.Substring(0, $at) + "`n$entry$sep" + $rest
  }
  Write-Json-Checked $CAP_JSON $raw
  $where = 'backend/app/data/capabilities.json'
  "复制了 $copied 个模型文件（跳过压缩包与说明文档，纹理全留）"
}

# ---------------------------------------------------------------- 借物表

if (Test-Path $BIND_TXT) {
  $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm'
  $author = if ($Author) { $Author } else { '**待填**' }
  $srcurl = if ($Source) { $Source } else { '**待填**' }
  $block = @"


---

## 追加：$Label（id = $Id）

| 项 | 值 |
|---|---|
| 模型名 | $Label |
| 模型 ID | $Id |
| 模型文件 | $relDir |
| 作者 / 发布者 | $author |
| 来源页面 | $srcurl |
| 导入时间 | $stamp |

> ⚠️ **授权情况待确认**，上面两栏请自己补齐。装之前先在模型的发布页看清三条：
> 是否允许修改 / 是否允许二次配布 / 是否允许商用。
> 本项目的既有做法是：允许随仓库分发的放 public/；不允许的（例如洛天依）把目录
> 加进 .gitignore，只留本机演示。
"@
  Write-Utf8 $BIND_TXT ((Read-Utf8 $BIND_TXT).TrimEnd() + $block + "`n")
}

# ---------------------------------------------------------------- 验证

""
"装好了：$Label  (id=$Id)"
"  文件  : $relDir"
"  清单  : $where"
"  借物表: 已追加一条（出处与授权请自己补）"
""
$ok = $false
foreach ($u in @('http://127.0.0.1:8000/api/models3d', 'http://127.0.0.1:8000/api/capabilities')) {
  try {
    $j = Invoke-RestMethod -Uri $u -TimeoutSec 8
    $hit = $null
    if ($j.bundled) { $hit = $j.bundled | Where-Object { $_.id -eq $Id } }
    if (-not $hit -and $j.live2d) { $hit = $j.live2d | Where-Object { $_.id -eq $Id } }
    if ($hit) { "  OK  $u 里已经有它了：" + ($hit | ConvertTo-Json -Depth 4 -Compress); $ok = $true }
  } catch { }
}
if (-not $ok) {
  "  ⚠ 接口里还没看到。刚复制完文件的话，重启服务（start.bat）再刷新页面即可。"
  "    页面资源自动带版本号，刷新一次就拿到新清单，不用清缓存。"
}
