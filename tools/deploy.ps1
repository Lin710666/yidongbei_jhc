<#
  一键部署.ps1 —— 文旅智能辅助 v5.0

  把"从 clone 到能跑"的全过程收成一条命令。做四件事：
    1. 检查 Node.js（服务本体只用 Node 内置模块，所以这是**唯一**硬依赖）
    2. 建 Python 虚拟环境并按 requirements.txt 装可选功能依赖
    3. 下载示例素材（Live2D 形象、VRM、可选的 Whisper / TripoSR / 深度权重）
    4. 起服务并打开浏览器

  为什么用 PowerShell 而不是 .bat：
    这套流程要判断"装没装、版本够不够、失败了要不要继续"，.bat 写这些很痛苦
    （没有真正的函数与错误处理）。而 .bat 里写中文还有编码坑（cmd 默认 GBK，
    UTF-8 的中文会变乱码）。所以逻辑放这里，外面只留一个纯 ASCII 的 .bat 启动器。

  设计原则：**每一步失败都不阻断后面的步骤**。
  这是个"可选功能很多"的项目 —— 没装 torch 不该导致整个服务起不来，
  只该让「深度估计」那个折叠区提示缺包。所以这里一律"警告并继续"。

  参数：
    -SkipPython    跳过 Python 依赖（只要对话/形象/导航这些核心功能）
    -SkipModels    跳过下载示例模型（你已经有自己的素材）
    -SkipWhisper   跳过 Whisper 权重（926MB，而且默认关闭）
    -SkipStart     装完不启动（只准备环境）
    -Full          连 Whisper 权重也一起下
#>
[CmdletBinding()]
param(
  [switch]$SkipPython,
  [switch]$SkipModels,
  [switch]$SkipWhisper,
  [switch]$SkipStart,
  [switch]$Full
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$script:Warnings = @()

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Step($n, $total, $msg) {
  Write-Host ''
  Write-Host "[$n/$total] $msg" -ForegroundColor Cyan
}
function Ok($msg)   { Write-Host "      OK   $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "      注意 $msg" -ForegroundColor Yellow; $script:Warnings += $msg }
function Fail($msg) { Write-Host "      缺   $msg" -ForegroundColor Red; $script:Warnings += $msg }

Write-Host ''
Write-Host '==================================================' -ForegroundColor White
Write-Host '  文旅智能辅助 · AIRI 网页版   v5.0' -ForegroundColor White
Write-Host '  一键部署' -ForegroundColor White
Write-Host '==================================================' -ForegroundColor White
Say ''
Say "  安装目录：$Root"
Say '  全程只写本机，不往任何云服务传数据。'

$TOTAL = 4

# ---------------------------------------------------------------- 1. Node
Step 1 $TOTAL 'Node.js（唯一的硬依赖）'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail '没检测到 Node.js。请到 https://nodejs.org 装 18 或更高版本，然后重新运行本脚本。'
  Say ''
  Say '  Node 是唯一必须的依赖 —— 服务本体只用 Node 内置模块，不需要 npm install。' -ForegroundColor DarkGray
  Read-Host '按回车退出'
  exit 1
}
$ver = (& node -v) -replace '^v', ''
$major = [int]($ver -split '\.')[0]
if ($major -lt 18) {
  Fail "当前 Node $ver，本项目要求 18 或更高。"
} else {
  Ok "Node v$ver"
}

# Node 依赖：本来就是零。这里只是把这件事明确说出来，
# 免得看到没有 node_modules 以为装漏了。
Ok 'Node 第三方依赖：无（package.json 的 dependencies 是空的，符合设计）'

# ------------------------------------------------------------ 2. Python
Step 2 $TOTAL 'Python 可选功能依赖'
if ($SkipPython) {
  Warn '按参数要求跳过。深度估计 / 图片转 3D / 本地听觉 会用不了，其余功能正常。'
} else {
  $pyExe = Join-Path $Root 'tools\py\Scripts\python.exe'
  $sysPy = Get-Command python -ErrorAction SilentlyContinue
  if (-not (Test-Path $pyExe)) {
    if (-not $sysPy) {
      Fail '没检测到 Python。这三个可选功能需要 Python 3.10+，装好后重新运行本脚本。'
    } else {
      Say '      正在创建虚拟环境 tools\py …'
      & python -m venv (Join-Path $Root 'tools\py') 2>&1 | Out-Null
      if (Test-Path $pyExe) { Ok '虚拟环境已创建' } else { Fail '虚拟环境创建失败' }
    }
  } else {
    Ok "已存在：$pyExe"
  }

  if (Test-Path $pyExe) {
    $req = Join-Path $Root 'requirements.txt'
    if (Test-Path $req) {
      Say '      正在安装 requirements.txt（国内走清华镜像，首次约几百 MB）…'
      Say '      这一步最慢，可以放着不管。' -ForegroundColor DarkGray
      # 先升级 pip：老 pip 解析 torch 这类大包时经常失败
      & $pyExe -m pip install --quiet --upgrade pip -i https://pypi.tuna.tsinghua.edu.cn/simple 2>&1 | Out-Null
      & $pyExe -m pip install -r $req -i https://pypi.tuna.tsinghua.edu.cn/simple
      if ($LASTEXITCODE -eq 0) {
        Ok 'Python 依赖装好了'
      } else {
        Warn 'Python 依赖有失败项。核心功能不受影响；缺哪个功能就单独补：'
        Say "      $pyExe -m pip install <包名> -i https://pypi.tuna.tsinghua.edu.cn/simple" -ForegroundColor DarkGray
      }
    }
  }
}

# -------------------------------------------------------------- 3. 素材
Step 3 $TOTAL '示例素材'
if ($SkipModels) {
  Warn '按参数要求跳过下载。没有素材时形象区会显示"还没有可用的模型"并给出获取办法。'
} else {
  # 示例模型：Live2D 官方样例 + VRM 规范样例
  $l2dDir = Join-Path $Root 'public\models'
  $have = @()
  if (Test-Path $l2dDir) { $have = Get-ChildItem $l2dDir -Directory -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name }
  if ($have.Count -gt 0) {
    Ok "示例模型已存在（$($have.Count) 个）"
  } else {
    $bat = Join-Path $Root 'tools\获取示例模型.bat'
    if (Test-Path $bat) {
      Say '      正在下载 Live2D / VRM 示例模型（约 33MB，走 jsDelivr）…'
      & cmd /c "`"$bat`"" 2>&1 | Out-Null
      Ok '示例模型下载流程结束（详见 public/models/）'
    } else {
      # 没有 .bat 就退回 Node 脚本
      & node (Join-Path $Root 'tools\fetch-live2d-samples.js') 2>&1 | Out-Null
      Ok '已用 Node 脚本补齐 Live2D 官方样例'
    }
  }

  # 可选的大权重：一律只提示，不擅自下（Whisper 926MB、TripoSR 1.6GB）
  $modelsDir = Join-Path $Root 'models'
  $hasWhisper = (Test-Path (Join-Path $modelsDir 'whisper'))
  if ($hasWhisper) {
    Ok 'Whisper 权重已存在'
  } elseif ($SkipWhisper -and -not $Full) {
    Say '      跳过 Whisper 权重（听觉功能默认关闭，要用时再 npm run fetch:whisper）' -ForegroundColor DarkGray
  } else {
    Say '      未下载 Whisper 权重（926MB）。需要本地听觉时执行：npm run fetch:whisper' -ForegroundColor DarkGray
  }
  Say '      其它可选权重按需下载：npm run fetch:triposr（1.6GB）/ npm run fetch:depth（95MB）' -ForegroundColor DarkGray
}

# -------------------------------------------------------------- 4. 启动
Step 4 $TOTAL '启动'
if ($SkipStart) {
  Warn '按参数要求不启动。手动启动：双击 start.bat，或 node server.js'
} else {
  $port = 8000
  $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($busy) {
    Warn "端口 $port 已被占用（PID $($busy.OwningProcess -join ',')）。可能是本服务已经在跑，直接打开即可。"
  } else {
    Say "      正在启动服务（端口 $port）…"
    Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $Root -WindowStyle Hidden
    # 等服务真的起来再开浏览器，否则会看到"无法访问"
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 500
      try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ok = $true; break }
      } catch { }
    }
    if ($ok) { Ok '服务已就绪' } else { Warn '服务启动较慢或失败，请手动跑 node server.js 看报错' }
  }
  Start-Process "http://localhost:$port"
  Ok "已打开 http://localhost:$port"
}

# -------------------------------------------------------------- 收尾
Write-Host ''
Write-Host '==================================================' -ForegroundColor White
if ($script:Warnings.Count -eq 0) {
  Write-Host '  部署完成，没有需要处理的问题。' -ForegroundColor Green
} else {
  Write-Host "  部署完成，但有 $($script:Warnings.Count) 处需要留意：" -ForegroundColor Yellow
  $script:Warnings | ForEach-Object { Write-Host "    · $_" -ForegroundColor Yellow }
  Write-Host ''
  Write-Host '  这些都不影响核心功能（对话 / 形象 / 导航 / 角色卡 / 记忆 / TTS）。' -ForegroundColor DarkGray
}
Write-Host '==================================================' -ForegroundColor White
Write-Host ''
Write-Host '  常用命令：'
Write-Host '    start.bat            启动服务'
Write-Host '    stop.bat             停止服务'
Write-Host '    npm test             跑全部自检（约 700 项）'
Write-Host '    npm run test:cdp     用真实浏览器验一遍界面'
Write-Host '    npm run fetch:bili -- <BV号> 名字    从 B 站下载背景视频'
Write-Host ''
Write-Host '  需要自己装 Ollama（对话用）与 Qwen TTS（语音用）：见 docs/部署教程.md'
Write-Host ''
Read-Host '按回车关闭本窗口'
