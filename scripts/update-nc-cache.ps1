# Fetch danh sách "phim mới cập nhật" của NguonC bằng IP máy nhà (Cloudflare không chặn),
# rồi đẩy lên nhánh nc-cache để workflow GitHub đọc thay vì gọi trực tiếp (bị 403).
$ErrorActionPreference = "Stop"

$repo = "vinh1712/nhotphim-sync"
$branch = "nc-cache"
$path = "nc-latest.json"
$gh = "C:\Program Files\GitHub CLI\gh.exe"
$log = Join-Path $env:TEMP "nhotphim-nc-cache.log"

function Write-Log([string]$message) {
  Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date).ToString("o"), $message)
}

# gh ghi lỗi ra stderr; với ErrorActionPreference=Stop PowerShell có thể coi đó là
# exception nên phải bọc từng lời gọi, không dùng 2>$null.
function Invoke-Gh([string[]]$ghArgs) {
  try {
    $out = & $gh @ghArgs 2>&1
    return [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Out = ($out -join "`n") }
  } catch {
    return [pscustomobject]@{ Ok = $false; Out = $_.Exception.Message }
  }
}

try {
  $resp = Invoke-WebRequest -Uri "https://phim.nguonc.com/api/films/phim-moi-cap-nhat?page=1" -Headers @{
    "User-Agent"      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    "Accept"          = "application/json, text/plain, */*"
    "Accept-Language" = "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
    "Referer"         = "https://phim.nguonc.com/"
    "Origin"          = "https://phim.nguonc.com"
  } -TimeoutSec 30
  if ($resp.StatusCode -ne 200) { throw "HTTP $($resp.StatusCode)" }

  $data = $resp.Content | ConvertFrom-Json
  if (-not $data.items -or @($data.items).Count -eq 0) { throw "Không có items" }

  $payload = @{
    _fetched_at = (Get-Date).ToUniversalTime().ToString("o")
    items       = @($data.items)
  } | ConvertTo-Json -Depth 12 -Compress
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))

  # Tạo nhánh cache nếu chưa có (không đụng main).
  $branchCheck = Invoke-Gh @("api", "repos/$repo/branches/$branch", "--silent")
  if (-not $branchCheck.Ok) {
    $mainOut = (Invoke-Gh @("api", "repos/$repo/git/ref/heads/main", "--jq", ".object.sha")).Out
    $mainSha = $mainOut -split "`n" | Where-Object { $_ -match '^[0-9a-f]{40}$' } | Select-Object -First 1
    if (-not $mainSha) { throw "Không lấy được SHA của main" }
    $created = Invoke-Gh @("api", "--method", "POST", "repos/$repo/git/refs", "-f", "ref=refs/heads/$branch", "-f", "sha=$mainSha", "--silent")
    if (-not $created.Ok) { throw "Tạo nhánh $branch lỗi: $($created.Out)" }
  }

  # PowerShell coi "$path?ref" là TÊN BIẾN, phải dùng ${} hoặc nối chuỗi.
  $existingUrl = "repos/$repo/contents/${path}?ref=${branch}"
  $existing = Invoke-Gh @("api", $existingUrl, "--jq", ".sha")
  # Chỉ nhận đúng 40 hex — tránh lỗi "Invalid request" khi gh in thêm dòng stderr.
  $existingSha = $existing.Out -split "`n" | Where-Object { $_ -match '^[0-9a-f]{40}$' } | Select-Object -First 1
  $ghArgs = @(
    "api", "--method", "PUT", "repos/$repo/contents/$path",
    "-f", "message=NC cache $((Get-Date).ToUniversalTime().ToString('o'))",
    "-f", "content=$b64",
    "-f", "branch=$branch"
  )
  if ($existingSha) { $ghArgs += @("-f", "sha=$existingSha") }
  $saved = Invoke-Gh $ghArgs
  if (-not $saved.Ok) {
    throw "Ghi $path lên $branch lỗi: $($saved.Out)"
  }

  Write-Log ("OK items={0} bytes={1}" -f @($data.items).Count, $payload.Length)
} catch {
  Write-Log ("ERR " + $_.Exception.Message)
  exit 1
}
