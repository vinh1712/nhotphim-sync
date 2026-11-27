# Fire auto-sync via GitHub CLI (already authenticated via keyring).
# Used by Task Scheduler because GitHub `schedule` currently creates no runs.
$ErrorActionPreference = "Stop"

$gh = "C:\Program Files\GitHub CLI\gh.exe"
$log = Join-Path $env:TEMP "nhotphim-sync-dispatch.log"

function Write-Log([string]$message) {
  Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date).ToString("o"), $message)
}

try {
  # NguonC chặn IP GitHub runner -> lấy danh sách bằng IP máy nhà, đẩy lên nhánh nc-cache.
  # Nếu bước này hỏng thì vẫn dispatch; auto-sync sẽ bỏ qua NguonC như cũ.
  $cacheScript = Join-Path $PSScriptRoot "update-nc-cache.ps1"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $cacheScript 2>&1 | Out-Null
  Write-Log ("CACHE exit=" + $LASTEXITCODE)

  $output = & $gh workflow run auto-sync.yml --repo vinh1712/nhotphim-sync 2>&1
  Write-Log ("OK " + ($output -join " "))
} catch {
  Write-Log ("ERR " + $_.Exception.Message)
  exit 1
}
