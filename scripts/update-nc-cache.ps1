# Fetch danh sách + chi tiết "phim mới cập nhật" của NguonC bằng IP máy nhà
# (Cloudflare không chặn), rồi đẩy lên nhánh nc-cache để workflow GitHub đọc thay
# vì gọi trực tiếp (bị 403). Detail được lưu theo slug trong key "details" để
# auto-sync điền đúng SV1 (link) thay vì mượn link của nguồn khác.
$ErrorActionPreference = "Stop"

$repo = "vinh1712/nhotphim-sync"
$branch = "nc-cache"
$path = "nc-latest.json"
$repoUrl = "https://github.com/$repo.git"
$log = Join-Path $env:TEMP "nhotphim-nc-cache.log"
$work = Join-Path $env:TEMP "nhotphim-nc-cache-repo"

function Write-Log([string]$message) {
  Add-Content -Path $log -Value ("{0} {1}" -f (Get-Date).ToString("o"), $message)
}

function Assert-Exit([string]$step) {
  if ($LASTEXITCODE -ne 0) { throw ("{0} lỗi (exit {1})" -f $step, $LASTEXITCODE) }
}

try {
  $headers = @{
    "User-Agent"      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    "Accept"          = "application/json, text/plain, */*"
    "Accept-Language" = "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
    "Referer"         = "https://phim.nguonc.com/"
    "Origin"          = "https://phim.nguonc.com"
  }

  # -UseBasicParsing bắt buộc trên Windows PowerShell 5.1 chạy non-interactive,
  # nếu không IE engine sẽ hiện prompt thiết lập và throw ngay ở đây.
  $resp = Invoke-WebRequest -Uri "https://phim.nguonc.com/api/films/phim-moi-cap-nhat?page=1" -Headers $headers -TimeoutSec 30 -UseBasicParsing
  if ($resp.StatusCode -ne 200) { throw "HTTP $($resp.StatusCode)" }

  $data = $resp.Content | ConvertFrom-Json
  $items = @($data.items)
  if (-not $items.Count) { throw "Không có items" }

  # Fetch detail từng phim ngay trên máy nhà. Runner chỉ đọc JSON này.
  $details = @{}
  $okDetail = 0
  foreach ($it in $items) {
    $slug = [string]$it.slug
    if (-not $slug) { continue }

    $detailUrl = "https://phim.nguonc.com/api/film/" + [uri]::EscapeDataString($slug)
    try {
      $dresp = Invoke-WebRequest -Uri $detailUrl -Headers $headers -TimeoutSec 30 -UseBasicParsing
      if ($dresp.StatusCode -ne 200) { throw "HTTP $($dresp.StatusCode)" }
      $dj = $dresp.Content | ConvertFrom-Json
      if ($dj -and $dj.movie) {
        $details[$slug] = $dj
        $okDetail++
      } else {
        Write-Log ("WARN detail {0}: không có movie" -f $slug)
      }
    } catch {
      Write-Log ("WARN detail {0}: {1}" -f $slug, $_.Exception.Message)
    }
    Start-Sleep -Milliseconds 150
  }
  if (-not $okDetail) { throw "Không fetch được detail nào -> không ghi cache" }

  $payload = @{
    _fetched_at = (Get-Date).ToUniversalTime().ToString("o")
    items       = $items
    details     = $details
  } | ConvertTo-Json -Depth 30 -Compress

  # Dùng git thay vì gh CLI (máy nhà không necessarily có gh). Clone riêng nhánh
  # cache vào temp, ghi file rồi push — không đụng code đang chạy trên main.
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }

  $heads = & git ls-remote --heads $repoUrl "refs/heads/$branch"
  Assert-Exit "git ls-remote"
  $hasBranch = [bool]($heads | Where-Object { $_ -match 'refs/heads/' })

  if ($hasBranch) {
    & git clone --quiet --branch $branch --single-branch --depth 1 $repoUrl $work | Out-Null
    Assert-Exit "git clone $branch"
  } else {
    & git clone --quiet --single-branch --depth 1 $repoUrl $work | Out-Null
    Assert-Exit "git clone main"
    & git -C $work checkout --quiet -b $branch | Out-Null
    Assert-Exit "git checkout -b $branch"
  }

  $target = Join-Path $work $path
  [IO.File]::WriteAllText($target, $payload, (New-Object Text.UTF8Encoding($false)))

  & git -C $work add -- $path | Out-Null
  Assert-Exit "git add"
  $status = & git -C $work status --porcelain -- $path
  if ($status) {
    $msg = "NC cache " + (Get-Date).ToUniversalTime().ToString("o")
    & git -C $work -c user.name="nhotphim-bot" -c user.email="bot@users.noreply.github.com" commit -q -m $msg | Out-Null
    Assert-Exit "git commit"
    & git -C $work push --quiet origin "HEAD:$branch" | Out-Null
    Assert-Exit "git push"
  } else {
    Write-Log "Không có thay đổi để push"
  }

  Write-Log ("OK items={0} details={1} bytes={2}" -f $items.Count, $okDetail, $payload.Length)
} catch {
  Write-Log ("ERR {0} (line {1})" -f $_.Exception.Message, $_.InvocationInfo.ScriptLineNumber)
  exit 1
}
