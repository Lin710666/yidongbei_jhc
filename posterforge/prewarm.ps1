# prewarm.ps1 -- PosterForge boot prewarm
#
# Why PowerShell instead of .bat:
#   Processes spawned by `start /min` inside a .bat get torn down when the parent
#   (task scheduler / explorer) exits -- observed: services started, log written,
#   then the port disappeared as soon as the parent finished. Start-Process creates
#   genuinely independent processes; that behaviour is verified in this project.
#
# Why this file is pure ASCII:
#   Windows PowerShell 5.1 reads .ps1 as the system ANSI codepage (GBK here), so a
#   UTF-8 file with Chinese text gets mangled and fails to parse. Keep it ASCII.
#
# Does three things: start Ollama + warm models -> start site -> start ComfyUI

param(
  [switch]$Quiet,
  [switch]$SkipComfy
)

$ErrorActionPreference = "Continue"
$Site = "E:\deepseck\site"
$LogDir = Join-Path $Site ".work\logs"
$OllamaExe = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
$ComfyDir = "E:\ComfyUI_windows_portable"
$ComfyPy = Join-Path $ComfyDir "python_embeded\python.exe"

function Say($msg) { if (-not $Quiet) { Write-Host $msg } }

function Test-Port($port) {
  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  return [bool]$c
}

function Wait-Port($port, $seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    if (Test-Port $port) { return $true }
    Start-Sleep -Seconds 1
  }
  return (Test-Port $port)
}

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

Say "=========================================================="
Say "  PosterForge prewarm  (site + ollama + comfyui)"
Say "=========================================================="
Say ""

# ---------------------------------------------------------------- 1. Ollama
Say "[1/3] Ollama ..."
if (Test-Port 11434) {
  Say "      already running"
} elseif (Test-Path $OllamaExe) {
  Start-Process -FilePath $OllamaExe -ArgumentList "serve" -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir "ollama.log") `
    -RedirectStandardError (Join-Path $LogDir "ollama.err.log") | Out-Null
  Say "      started"
} else {
  Say "      [WARN] ollama.exe not found: $OllamaExe"
}

if (Wait-Port 11434 45) {
  Say "      port ready, warming models (kept 24h)"
  foreach ($m in @("qwen2.5:7b", "qwen2.5vl:3b")) {
    $body = @{
      model = $m
      messages = @(@{ role = "user"; content = "hi" })
      stream = $false
      keep_alive = "24h"
      options = @{ num_predict = 1 }
    } | ConvertTo-Json -Depth 6 -Compress
    try {
      Invoke-RestMethod -Uri "http://127.0.0.1:11434/api/chat" -Method Post `
        -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 180 | Out-Null
      Say "      $m warmed"
    } catch {
      Say "      [WARN] $m warmup failed: $($_.Exception.Message)"
    }
  }
} else {
  Say "      [WARN] ollama port not ready, skip warmup"
}
Say ""

# ---------------------------------------------------------------- 2. site
Say "[2/3] Site :8800 ..."
if (Test-Port 8800) {
  Say "      already running"
} else {
  Start-Process -FilePath "node" -ArgumentList "server.mjs", "--port", "8800" `
    -WorkingDirectory $Site -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir "site.log") `
    -RedirectStandardError (Join-Path $LogDir "site.err.log") | Out-Null
  if (Wait-Port 8800 30) { Say "      started" } else { Say "      [WARN] not up in 30s, see logs\site.err.log" }
}
Say ""

# ---------------------------------------------------------------- 3. ComfyUI
Say "[3/3] ComfyUI :8188 (needed for AI background) ..."
if ($SkipComfy) {
  Say "      skipped by flag"
} elseif (Test-Port 8188) {
  Say "      already running"
} elseif (Test-Path $ComfyPy) {
  Start-Process -FilePath $ComfyPy `
    -ArgumentList "-s", "ComfyUI\main.py", "--lowvram", "--use-pytorch-cross-attention",
                  "--disable-smart-memory", "--reserve-vram", "0.4", "--cache-none", "--port", "8188" `
    -WorkingDirectory $ComfyDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogDir "comfyui.log") `
    -RedirectStandardError (Join-Path $LogDir "comfyui.err.log") | Out-Null
  Say "      started (ready in ~45s)"
} else {
  Say "      [SKIP] not found: $ComfyPy"
}
Say ""

Say "=========================================================="
Say "  done.  site: http://127.0.0.1:8800"
Say "  logs:  $LogDir"
Say "=========================================================="
