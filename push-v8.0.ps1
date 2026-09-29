# push-v8.0.ps1 —— 把 v8.0 推到 GitHub，Token 不落盘
#
# 为什么单独写这个：
#   1. 推送需要 Personal Access Token。让用户把 Token 贴在对话里 = 暴露；
#      写进 git remote = 留在 .git/config 里，容易随目录一起被打包带走。
#   2. 这个仓库**不是空的** —— 已经有 13 个分支（v7.0/v7.1/v7.2…）和 238MB 内容。
#      推错分支或误强推会覆盖别人的工作，所以这里把"推到哪个分支"做成显式选择。
#
# 用法： 右键本文件 → 使用 PowerShell 运行
#    或  pwsh -File push-v8.0.ps1

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Say($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }

Say ""
Say "==================================================" Cyan
Say "  推送 v8.0 到 GitHub" Cyan
Say "==================================================" Cyan
Say ""

# ---------------------------------------------------------------- 前置检查
$repo = 'Lin710666/yidongbei_jhc'
$branch = (git rev-parse --abbrev-ref HEAD).Trim() -replace '^heads/', ''
if ($branch -ne 'v8.0') { Say "  当前分支是 $branch，不是 v8.0。先切过去再跑。" Red; exit 1 }

$dirty = git status --porcelain
if ($dirty) { Say "  工作区有未提交的改动，先提交再推：" Yellow; $dirty | ForEach-Object { Say "    $_" }; exit 1 }

Say "  仓库    https://github.com/$repo"
Say "  分支    $branch"
Say "  提交    $(git log --oneline -1)"
Say "  文件    $((git ls-files | Measure-Object -Line).Lines) 个"
Say ""

# ---------------------------------------------------------------- 远端现状
Say "  正在查远端已有的分支…" Gray
$existing = @()
try {
  $r = Invoke-WebRequest "https://api.github.com/repos/$repo/branches" -UseBasicParsing -TimeoutSec 25 `
        -Headers @{ 'User-Agent' = 'push-script' }
  $existing = ($r.Content | ConvertFrom-Json) | ForEach-Object { $_.name }
  Say "  远端有 $($existing.Count) 个分支：$($existing -join ', ')" Gray
} catch {
  Say "  查不到远端分支（网络？）—— 不影响推送，但请自己确认目标分支没被占用。" Yellow
}

if ($existing -contains 'v8.0') {
  Say ""
  Say "  ⚠ 远端已经有 v8.0 分支了。" Yellow
  Say "    继续推会覆盖它。如果那是别人推的，先问清楚。" Yellow
  $ans = Read-Host "  确认覆盖远端 v8.0 吗？输入 yes 继续"
  if ($ans -ne 'yes') { Say "  已取消。" Gray; exit 0 }
  $force = '--force-with-lease'
} else {
  $force = ''
}

# ---------------------------------------------------------------- Token
Say ""
Say "  需要一个有 repo 权限的 Token：https://github.com/settings/tokens" Cyan
Say "  （输入时不显示字符，这是正常的）" Gray
$secure = Read-Host "  粘贴 Token" -AsSecureString
$token = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ([string]::IsNullOrWhiteSpace($token)) { Say "  没输入 Token，取消。" Red; exit 1 }
if ($token.Length -lt 20) { Say "  Token 太短，不像是有效的，取消。" Red; exit 1 }

# ---------------------------------------------------------------- 推送
# Token 只放在**这一次**的 URL 里，用完立刻把 remote 恢复成不带凭据的形式。
# 这样 .git/config 里始终不会有明文 Token。
Say ""
Say "  推送中…" Gray
$clean = "https://github.com/$repo.git"
$withToken = "https://x-access-token:$token@github.com/$repo.git"
$ok = $false
try {
  git remote set-url origin $withToken
  git push $force -u origin v8.0
  if ($LASTEXITCODE -eq 0) { $ok = $true }

  if ($ok) {
    Say "  分支推好了，接着推标签 v8.0…" Gray
    git push $force origin v8.0
  }
} catch {
  Say "  推送失败：$($_.Exception.Message)" Red
} finally {
  # 无论成败都要把凭据从配置里拿掉
  git remote set-url origin $clean
  $token = $null
  $secure = $null
  [GC]::Collect()
}

Say ""
if ($ok) {
  Say "  完成。" Green
  Say "  分支  https://github.com/$repo/tree/v8.0" Green
  Say "  标签  https://github.com/$repo/releases/tag/v8.0" Green
  Say ""
  Say "  remote 已恢复成不含凭据的形式，Token 没有留在 .git/config 里。" Gray
} else {
  Say "  没推成功。常见原因：" Yellow
  Say "    · Token 没有 repo 权限，或已过期" Yellow
  Say "    · 网络（本机若有系统代理，git 可能需要 NO_PROXY）" Yellow
  Say "    · 远端 v8.0 已存在且不是 fast-forward（重跑本脚本可确认覆盖）" Yellow
}
Say ""
Read-Host "  按回车关闭"
