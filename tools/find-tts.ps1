<#
  find-tts.ps1 —— 探测本机 Qwen TTS WebUI 装在哪

  为什么需要它：Qwen TTS WebUI 是个独立安装的第三方程序，每台机器装的位置都不一样
  （本项目作者机器上在 C:\...\Desktop\qwen-tts-webui，队友机器上在 E:\声音\qwen_tts_webui-licyk-...）。
  start.bat / stop.bat / 检测并安装依赖.bat 都需要知道它在哪，所以统一由这个脚本去找。

  被 tools\env-detect.bat 调用：把找到的路径打印到标准输出，找不到就什么都不打印。
  判定「这个目录就是 Qwen TTS」的条件（两个文件都得在）：
      <目录>\core\launch.py
      <目录>\python\python.exe

  查找顺序：
      1. 环境变量 QWEN_TTS_HOME
      2. Desktop / Desktop\声音 / Documents / Downloads / Desktop\AI
         以及各盘符根目录、<盘>:\声音、<盘>:\AI、<盘>:\tools
         先找名字像 qwen + tts 的目录，再按特征文件认
#>

$ErrorActionPreference = 'SilentlyContinue'

function Test-TtsHome([string]$Path) {
  if (-not $Path) { return $false }
  return (Test-Path -LiteralPath (Join-Path $Path 'core\launch.py')) -and
         (Test-Path -LiteralPath (Join-Path $Path 'python\python.exe'))
}

# ---------- 1. 环境变量优先 ----------
if (Test-TtsHome $env:QWEN_TTS_HOME) {
  Write-Output $env:QWEN_TTS_HOME
  exit 0
}

# ---------- 2. 逐个候选父目录找 ----------
$roots = New-Object System.Collections.Generic.List[string]
foreach ($p in @(
    (Join-Path $env:USERPROFILE 'Desktop'),
    (Join-Path $env:USERPROFILE 'Desktop\声音'),
    (Join-Path $env:USERPROFILE 'Desktop\AI'),
    (Join-Path $env:USERPROFILE 'Documents'),
    (Join-Path $env:USERPROFILE 'Downloads')
  )) {
  if ($p) { $roots.Add($p) }
}
foreach ($d in @('C', 'D', 'E', 'F', 'G', 'H')) {
  $roots.Add("${d}:\")
  $roots.Add("${d}:\声音")
  $roots.Add("${d}:\AI")
  $roots.Add("${d}:\tools")
}

# 系统目录整批跳过：既不可能装在这里，又会让扫描慢十几倍
$skipNames = @('Windows', 'Program Files', 'Program Files (x86)', 'ProgramData',
  '$Recycle.Bin', 'System Volume Information', 'PerfLogs', 'Recovery', 'Users',
  'MSOCache', 'Intel', 'AMD', 'NVIDIA', 'Documents and Settings', 'node_modules')

$seenRoot = @{}
foreach ($r in $roots) {
  if (-not $r) { continue }
  if ($seenRoot.ContainsKey($r)) { continue }
  $seenRoot[$r] = $true
  if (-not (Test-Path -LiteralPath $r)) { continue }

  $children = @(Get-ChildItem -LiteralPath $r -Directory |
    Where-Object { $skipNames -notcontains $_.Name -and -not $_.Name.StartsWith('$') })

  # 2a) 名字里同时有 qwen 和 tts 的，优先 ------ 命中概率最高，先试
  foreach ($c in ($children | Where-Object { $_.Name -match 'qwen' -and $_.Name -match 'tts' })) {
    if (Test-TtsHome $c.FullName) { Write-Output $c.FullName; exit 0 }
    foreach ($g in @(Get-ChildItem -LiteralPath $c.FullName -Directory)) {
      if (Test-TtsHome $g.FullName) { Write-Output $g.FullName; exit 0 }
    }
  }

  # 2b) 名字看不出来，就按特征文件认（例如装在 E:\声音\ 下面的乱码目录名）
  foreach ($c in $children) {
    if (Test-TtsHome $c.FullName) { Write-Output $c.FullName; exit 0 }
  }
  foreach ($c in $children) {
    foreach ($g in @(Get-ChildItem -LiteralPath $c.FullName -Directory)) {
      if (Test-TtsHome $g.FullName) { Write-Output $g.FullName; exit 0 }
    }
  }
}

# 找不到：什么都不输出，调用方据此提示用户手动指定路径
exit 0
