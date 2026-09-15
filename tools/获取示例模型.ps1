<#
  获取示例模型.ps1

  为什么模型不直接放进仓库：
    示例 Live2D 与 3D 形象都是**第三方素材**，版权不在本项目这里。
    Project AIRI 自己也没有把它们提交进仓库，而是在构建时下载。
    这里沿用同样的做法：仓库只放代码，模型在需要时下载到本机。

  脚本会下载 5 个模型（共约 33MB），全部来自官方公开仓库：
    public/models/hiyori/        桃瀬ひより   Live2D/CubismWebSamples
    public/models/haru/          春          Live2D/CubismWebSamples
    public/models/mao/           Mao         Live2D/CubismWebSamples
    public/models3d/seed-san/    Seed-san    vrm-c/vrm-specification
    public/models3d/vrm1-sample/ VRM 1.0 示例 vrm-c/vrm-specification

  下载走 jsDelivr（全球 CDN，国内可直连）。任何一个文件失败会自动换镜像重试：
    cdn.jsdelivr.net  →  gh-proxy.com  →  raw.githubusercontent.com

  用法：
    双击「获取示例模型.bat」，或者
    pwsh -File tools\获取示例模型.ps1
    pwsh -File tools\获取示例模型.ps1 -SkipLive2D     # 只要 3D
    pwsh -File tools\获取示例模型.ps1 -Skip3D         # 只要 Live2D
    pwsh -File tools\获取示例模型.ps1 -Force          # 已装过的也重下
#>

[CmdletBinding()]
param(
  [switch]$SkipLive2D,
  [switch]$Skip3D,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$root        = Split-Path $PSScriptRoot -Parent
$modelsDir   = Join-Path $root 'public\models'
$models3dDir = Join-Path $root 'public\models3d'

# 镜像模板：{0}=仓库  {1}=分支  {2}=文件路径。按顺序尝试，第一个成功的就用。
$script:Mirrors = @(
  'https://cdn.jsdelivr.net/gh/{0}@{1}/{2}',
  'https://gh-proxy.com/https://raw.githubusercontent.com/{0}/{1}/{2}',
  'https://raw.githubusercontent.com/{0}/{1}/{2}'
)

function Write-Step($msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "  OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "  !!  $msg" -ForegroundColor Yellow }

# 优先用系统自带的 curl.exe（Windows 10 1803+ 都有），进度干净、断点可控
$script:HasCurl = [bool](Get-Command curl.exe -ErrorAction SilentlyContinue)

function Save-Url($url, $dest) {
  if ($script:HasCurl) {
    & curl.exe -fsSL --connect-timeout 15 --max-time 300 --retry 2 --retry-delay 1 -o $dest $url 2>$null
    return ($LASTEXITCODE -eq 0 -and (Test-Path $dest) -and (Get-Item $dest).Length -gt 0)
  }
  try {
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -TimeoutSec 300
    return ((Test-Path $dest) -and (Get-Item $dest).Length -gt 0)
  } catch { return $false }
}

# 按镜像顺序下载一个文件；全部失败返回 $false
function Get-Remote($repo, $ref, $relPath, $dest) {
  $dir = Split-Path $dest -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  foreach ($tpl in $script:Mirrors) {
    $url = $tpl -f $repo, $ref, $relPath
    if (Save-Url $url $dest) { return $true }
  }
  return $false
}

# 问 jsDelivr 要仓库的完整文件清单（含大小），用来枚举 Live2D 模型目录
function Get-RepoListing($repo, $ref) {
  $api = "https://data.jsdelivr.com/v1/packages/gh/$repo@$ref" + '?structure=flat'
  $tmpJson = Join-Path ([System.IO.Path]::GetTempPath()) ("wenlv-listing-" + [guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
  if (-not (Save-Url $api $tmpJson)) { return $null }
  try {
    $raw = Get-Content $tmpJson -Raw -Encoding UTF8
    $obj = $raw | ConvertFrom-Json
    if ($obj.status) { return $null }
    return $obj.files
  } catch {
    return $null
  } finally {
    Remove-Item $tmpJson -Force -ErrorAction SilentlyContinue
  }
}

function Write-Manifest($dir, $label, $note, $tags, $extra) {
  $m = [ordered]@{ label = $label; note = $note; tags = $tags }
  if ($extra) { foreach ($k in $extra.Keys) { $m[$k] = $extra[$k] } }
  $json = $m | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText((Join-Path $dir 'manifest.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
}

New-Item -ItemType Directory -Force -Path $modelsDir, $models3dDir | Out-Null

Write-Host ''
Write-Host '==================================================' -ForegroundColor Cyan
Write-Host '  获取示例模型（第三方素材，不随仓库分发）' -ForegroundColor Cyan
Write-Host '==================================================' -ForegroundColor Cyan
Write-Host ''
if (-not $script:HasCurl) { Write-Warn2 '没找到 curl.exe，改用 Invoke-WebRequest 下载（会慢一些）' }

$failed = @()

# ---------------- Live2D ----------------
if (-not $SkipLive2D) {
  $l2dRepo = 'Live2D/CubismWebSamples'
  $l2dRef  = 'develop'
  $l2dModels = @(
    @{ id = 'hiyori'; src = 'Hiyori'; label = '桃瀬ひより' },
    @{ id = 'haru';   src = 'Haru';   label = '春' },
    @{ id = 'mao';    src = 'Mao';    label = 'Mao' }
  )

  $todo = @()
  foreach ($m in $l2dModels) {
    $target = Join-Path $modelsDir $m.id
    if ((Test-Path $target) -and (Get-ChildItem $target -Filter '*.model3.json' -ErrorAction SilentlyContinue) -and -not $Force) {
      Write-Ok "$($m.label) 已安装，跳过"
    } else {
      $todo += $m
    }
  }

  if ($todo.Count -gt 0) {
    Write-Step "读取 $l2dRepo 文件清单 ..."
    $listing = Get-RepoListing $l2dRepo $l2dRef
    if (-not $listing) {
      Write-Warn2 "拿不到 $l2dRepo 的文件清单（网络不通？），跳过 Live2D。"
      Write-Warn2 "也可以手动下载后按 public/models/README.md 的说明放置。"
      $failed += 'Live2D（清单获取失败）'
    } else {
      foreach ($m in $todo) {
        $prefix = "/Samples/Resources/$($m.src)/"
        $files = @($listing | Where-Object { $_.name.StartsWith($prefix) })
        if ($files.Count -eq 0) {
          Write-Warn2 "$($m.label)：清单里找不到 $prefix，跳过"
          $failed += $m.label
          continue
        }
        $target = Join-Path $modelsDir $m.id
        if (Test-Path $target) { Remove-Item $target -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $target | Out-Null

        Write-Step "$($m.label)：$($files.Count) 个文件 ..."
        $n = 0; $bad = 0
        foreach ($f in $files) {
          $rel  = $f.name.Substring($prefix.Length)
          $dest = Join-Path $target ($rel -replace '/', '\')
          if (Get-Remote $l2dRepo $l2dRef ($f.name.TrimStart('/')) $dest) { $n++ } else { $bad++; Write-Warn2 "  失败：$rel" }
        }
        if ($bad -gt 0) {
          Write-Warn2 "$($m.label)：$bad 个文件没下下来，模型可能不完整"
          $failed += "$($m.label)（缺 $bad 个文件）"
        }

        Write-Manifest $target $m.label `
          "Live2D Inc. 官方示例模型 $($m.src)，由本脚本从公开仓库 $l2dRepo 获取。模型版权归 Live2D Inc.，使用前请阅读 https://www.live2d.com/eula/live2d-free-material-license-agreement_cn.html" `
          @('Live2D 官方示例', '第三方素材') `
          @{ source = $l2dRepo; lipSyncParam = 'ParamMouthOpenY'; files = $n }

        Write-Ok "$($m.label) 安装完成（$n 个文件）"
      }
    }
  }
}

# ---------------- 3D / VRM ----------------
if (-not $Skip3D) {
  $vrmRepo = 'vrm-c/vrm-specification'
  $vrmRef  = 'master'
  $vrms = @(
    @{ id = 'seed-san';   src = 'samples/Seed-san/vrm/Seed-san.vrm';                                     label = 'Seed-san';       note = 'VRM 官方示例角色（VRM Consortium 提供）' },
    @{ id = 'vrm1-sample'; src = 'samples/VRM1_Constraint_Twist_Sample/vrm/VRM1_Constraint_Twist_Sample.vrm'; label = 'VRM 1.0 示例模型'; note = 'VRM 1.0 约束/扭转测试模型，用于验证骨骼与表情' }
  )

  foreach ($v in $vrms) {
    $target = Join-Path $models3dDir $v.id
    $file   = Split-Path $v.src -Leaf
    if ((Test-Path (Join-Path $target $file)) -and -not $Force) { Write-Ok "$($v.label) 已安装，跳过"; continue }

    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Write-Step "$($v.label)：下载 $file ..."
    if (-not (Get-Remote $vrmRepo $vrmRef $v.src (Join-Path $target $file))) {
      Write-Warn2 "$($v.label) 下载失败（三个镜像都试过了）"
      $failed += $v.label
      continue
    }
    Write-Manifest $target $v.label "$($v.note)，由本脚本从公开仓库 $vrmRepo 获取。" @('3D / VRM', '官方示例', '第三方素材') @{ kind = '3d'; source = $vrmRepo }
    Write-Ok "$($v.label) 安装完成（$([math]::Round((Get-Item (Join-Path $target $file)).Length / 1MB, 1)) MB）"
  }
}

Write-Host ''
if ($failed.Count -gt 0) {
  Write-Host '以下内容没能装好：' -ForegroundColor Yellow
  $failed | ForEach-Object { Write-Host "  · $_" -ForegroundColor Yellow }
  Write-Host ''
  Write-Host '可以重跑本脚本，或者照 public/models/README.md 手动下载放置。' -ForegroundColor Yellow
  exit 1
}

Write-Host '完成。启动服务后：' -ForegroundColor Green
Write-Host '  · 点舞台右上角的「形象」按钮，就能看到这几套模型'
Write-Host '  · 想换成自己的模型：Live2D 放进 public/models/<名字>/（需含 .model3.json），'
Write-Host '    3D 直接在界面里点「上传 VRM / GLB」'
Write-Host ''
