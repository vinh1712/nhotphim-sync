# Kích hoạt auto-sync 30 phút/lượt (khung :00/:30) từ Task Scheduler.
# GitHub `schedule` chạy không đều nên dùng workflow_dispatch làm lịch chính.
# Ưu tiên gh CLI; nếu máy không có gh thì dùng trực tiếp GitHub REST API với
# token lấy từ git credential helper (đã đăng nhập github.com) hoặc env biến.
$ErrorActionPreference = "Stop"

$repo = "vinh1712/nhotphim-sync"
$workflow = "auto-sync.yml"
$log = Join-Path $env:TEMP "nhotphim-sync-dispatch.log"

function Write-Log([string]$message) {
  Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date).ToString("o"), $message)
}

function Get-GhPath {
  $cmd = Get-Command gh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @(
    "C:\Program Files\GitHub CLI\gh.exe",
    "$env:LOCALAPPDATA\Programs\GitHub CLI\gh.exe",
    "$env:ProgramFiles (x86)\GitHub CLI\gh.exe"
  )) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  return ""
}

function Get-GitToken {
  if ($env:NHOTPHIM_GH_TOKEN) { return $env:NHOTPHIM_GH_TOKEN }
  try {
    $query = "protocol=https`nhost=github.com`n`n"
    $creds = $query | & git credential fill 2>$null
    $line = $creds | Where-Object { $_ -like 'password=*' } | Select-Object -First 1
    if ($line) { return $line.Substring(9) }
  } catch {
    Write-Log ("WARN không đọc được git credential: {0}" -f $_.Exception.Message)
  }
  return ""
}

function Invoke-Dispatch {
  $gh = Get-GhPath
  if ($gh) {
    $argsGh = @("workflow", "run", $workflow, "--repo", $repo)
    if ($env:NHOTPHIM_FORCE_SWEEP -eq "1") { $argsGh += @("--field", "force_sweep=true") }
    $output = & $gh @argsGh 2>&1
    Write-Log ("OK gh " + ($output -join " "))
    return
  }

  $token = Get-GitToken
  if (-not $token) {
    throw "Không có gh CLI và cũng không lấy được token GitHub (git credential / NHOTPHIM_GH_TOKEN)"
  }
  $headers = @{
    Authorization = "Bearer $token"
    Accept = "application/vnd.github+json"
    "X-GitHub-Api-Version" = "2022-11-28"
    "User-Agent" = "nhotphim-dispatch"
  }
  $inputs = @{ dry_run = "false" }
  if ($env:NHOTPHIM_FORCE_SWEEP -eq "1") { $inputs.force_sweep = "true" }
  $body = @{ ref = "main"; inputs = $inputs } | ConvertTo-Json
  $uri = "https://api.github.com/repos/$repo/actions/workflows/$workflow/dispatches"
  $null = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body -TimeoutSec 30
  Write-Log "OK REST dispatch (204)"
}

try {
  # NguonC chặn IP runner -> lấy danh sách bằng IP máy nhà, đẩy lên nhánh nc-cache.
  # Cache lỗi VẪN phải dispatch: auto-sync có fallback dùng detail cũ đã validate.
  # Phải bọc riêng: với $ErrorActionPreference=Stop, stderr của native command khi
  # redirect 2>&1 có thể throw và nhảy thẳng vào catch ngoài -> không dispatch.
  $cacheScript = Join-Path $PSScriptRoot "update-nc-cache.ps1"
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cacheScript 2>&1 | Out-Null
    Write-Log ("CACHE exit=" + $LASTEXITCODE)
  } catch {
    Write-Log ("CACHE ERR " + $_.Exception.Message)
  }

  Invoke-Dispatch
} catch {
  Write-Log ("ERR " + $_.Exception.Message)
  exit 1
}
