<#
  fetch-tts-model.ps1 —— 让 Qwen TTS 把语音模型下载下来

  为什么需要它：Qwen TTS 的模型是「第一次合成时按需下载」的，光启动服务不会下。
  所以「检测并安装依赖.bat」检测到模型缺失时，会调这个脚本发一次极短的合成请求，
  把下载触发起来（下载中接口不返回，这里会一直等到下完）。

  前提：Qwen TTS 服务已经起在 -Url 上。

  用法：
      pwsh -File tools\fetch-tts-model.ps1
      pwsh -File tools\fetch-tts-model.ps1 -Model "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
#>
[CmdletBinding()]
param(
  [string]$Url = 'http://127.0.0.1:7860',
  [string]$Model = 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
  [int]$TimeoutSec = 3600
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$payload = @{
  model_name  = $Model
  text        = '你好，这是一次用于下载语音模型的测试合成。'
  instruct    = '用温柔亲切的年轻女声说话，语速稍慢、吐字清晰。'
  language    = 'Chinese'
  segment_gen = $false
} | ConvertTo-Json -Compress

$endpoint = "$($Url.TrimEnd('/'))/qwenapi/v1/custom-voice"

Write-Host "  正在请求合成（首次会把模型下载到本机，可能要好几分钟）..." -ForegroundColor Cyan
Write-Host "  模型：$Model"
Write-Host "  接口：$endpoint"

$sw = [Diagnostics.Stopwatch]::StartNew()
try {
  $resp = Invoke-RestMethod -Uri $endpoint -Method Post `
    -ContentType 'application/json; charset=utf-8' `
    -Body ([Text.Encoding]::UTF8.GetBytes($payload)) `
    -TimeoutSec $TimeoutSec
  $sw.Stop()
  $n = @($resp.audio_files_base64).Count
  Write-Host "  OK  合成成功，用时 $([math]::Round($sw.Elapsed.TotalSeconds,1)) 秒，返回 $n 段音频" -ForegroundColor Green
  exit 0
} catch {
  $sw.Stop()
  Write-Host "  !!  失败，用时 $([math]::Round($sw.Elapsed.TotalSeconds,1)) 秒" -ForegroundColor Red
  Write-Host "      $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "      常见原因：显存不够（先关掉别的大模型再试）、网络不通、模型名拼错。" -ForegroundColor Yellow
  exit 1
}
