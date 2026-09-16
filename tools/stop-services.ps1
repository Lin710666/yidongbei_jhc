<#
  stop-services.ps1 —— 停掉本项目用到的本地服务，但【保留 Ollama】

  被项目根目录的 stop.bat 调用。

  为什么用 PowerShell 而不是 netstat + taskkill：
      netstat 只能拿到一个 PID，按 PID 盲杀容易误伤同名进程；
      Qwen TTS 的 python 进程和别的 python 长得一模一样。
      这里改成「监听端口」+「命令行特征」双重确认，并显式列出一个保护名单，
      确保 ollama 相关的进程一个都不会被碰到。

  参数：
      -TtsHome    Qwen TTS 安装根目录（env-detect.bat 探到的，可能为空）
      -ProjectRoot 项目根目录（用于识别本项目自己的 node 进程）
      -Port       网页服务端口，默认 8000
      -TtsPort    Qwen TTS 端口，默认 7860
#>
[CmdletBinding()]
param(
  [string]$TtsHome = '',
  [string]$ProjectRoot = '',
  [int]$Port = 8000,
  [int]$TtsPort = 7860
)

$ErrorActionPreference = 'SilentlyContinue'

# 绝对不动的进程：主人的要求是「除了 ollama 以外都关掉」
$PROTECTED = @('ollama', 'ollama app', 'ollama_llama_server', 'llama-server', 'ollama_runner')

$killed = New-Object System.Collections.Generic.List[string]
$kept = New-Object System.Collections.Generic.List[string]
$touched = @{}

function Stop-One {
  param([int]$Id, [string]$Why)
  if (-not $Id -or $Id -le 4) { return }
  if ($script:touched.ContainsKey($Id)) { return }

  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$Id"
  if (-not $p) { return }

  $name = $p.Name
  $base = [IO.Path]::GetFileNameWithoutExtension($name).ToLower()
  if ($PROTECTED -contains $base) {
    $script:touched[$Id] = $true
    $script:kept.Add("$name (PID $Id) - 受保护，按要求保留")
    return
  }

  $script:touched[$Id] = $true
  try {
    Stop-Process -Id $Id -Force -ErrorAction Stop
    $script:killed.Add("$name (PID $Id) - $Why")
  } catch {
    $script:kept.Add("$name (PID $Id) - 结束失败：$($_.Exception.Message)")
  }
}

# ---------- 1. 监听网页端口的进程（本项目自己的 node server.js） ----------
foreach ($c in @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)) {
  Stop-One $c.OwningProcess "正在监听端口 $Port"
}

# ---------- 2. Qwen TTS 的 python（按命令行特征认，避免误伤别的 python） ----------
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'")) {
  $cmd = [string]$p.CommandLine
  if (-not $cmd) { continue }
  if ($cmd -like '*launch.py*' -or ($TtsHome -and $cmd -like "*$TtsHome*")) {
    Stop-One $p.ProcessId "Qwen TTS 语音服务"
  }
}

# ---------- 3. 启动语音服务的那层 cmd 窗口（否则会卡在 pause 上留下空窗口） ----------
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'")) {
  $cmd = [string]$p.CommandLine
  if ($cmd -and $cmd -like '*start-tts.bat*') {
    Stop-One $p.ProcessId "语音服务窗口"
  }
}

# ---------- 4. 还占着 TTS 端口的进程（兜底：python 已经改名或换了启动方式时用） ----------
foreach ($c in @(Get-NetTCPConnection -State Listen -LocalPort $TtsPort -ErrorAction SilentlyContinue)) {
  Stop-One $c.OwningProcess "正在监听端口 $TtsPort"
}

# ---------- 5. 本项目的 node server.js ----------
# 优先按端口认（精确）；端口认不到时，再看命令行里是不是 server.js。
# start.bat 是用 `cmd /k "node server.js"` 起的，所以这里连那层窗口一起收掉。
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'")) {
  $cmd = [string]$p.CommandLine
  if (-not $cmd) { continue }
  if ($cmd -notmatch 'server\.js') { continue }
  Stop-One $p.ProcessId "本项目的网页服务 server.js"
}
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'")) {
  $cmd = [string]$p.CommandLine
  if ($cmd -and $cmd -match 'node\s+server\.js') {
    Stop-One $p.ProcessId "网页服务窗口"
  }
}

# ---------- 输出 ----------
if ($killed.Count -eq 0) {
  Write-Host "  没有找到需要停止的进程（服务本来就没在运行）。" -ForegroundColor DarkGray
}
foreach ($k in $killed) {
  Write-Host "  [已停止] $k" -ForegroundColor Green
}
foreach ($k in $kept) {
  Write-Host "  [已保留] $k" -ForegroundColor Yellow
}

exit 0
