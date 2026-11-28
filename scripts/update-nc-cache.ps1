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

# Anon key là public key (web cũng dùng để đọc movies). Cho phép override bằng env.
$sbUrl = "https://tlbumpjugtltznzuwqwt.supabase.co"
$sbAnon = if ($env:SUPABASE_ANON_KEY) { $env:SUPABASE_ANON_KEY } else { "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRsYnVtcGp1Z3RsdHpuenV3cXd0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgyNjc0NDksImV4cCI6MjA5Mzg0MzQ0OX0.EMgx5_nREnfjZaIaLwU9q_KknbnqdxA2fbic_G_Xfdc" }

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
    # Không gửi Origin: NguonC trả 502 cho một số slug khi có header này.
  }

  # -UseBasicParsing bắt buộc trên Windows PowerShell 5.1 chạy non-interactive.
  # Ghi ra file rồi đọc lại bằng UTF-8: PS 5.1 tự đo charset sai, làm tên phim
  # bị mojibake ("Cá»™ng...") -> findNcSlugFromCache khớp tên không được.
  $tmpList = Join-Path $env:TEMP "nhotphim-nc-list.json"
  $listUrl = "https://phim.nguonc.com/api/films/phim-moi-cap-nhat?page=1"
  $gotList = $false
  for ($attempt = 1; $attempt -le 3 -and -not $gotList; $attempt++) {
    try {
      if (Test-Path -LiteralPath $tmpList) { Remove-Item -LiteralPath $tmpList -Force }
      Invoke-WebRequest -Uri $listUrl -Headers $headers -TimeoutSec 30 -UseBasicParsing -OutFile $tmpList
      if (-not (Test-Path -LiteralPath $tmpList)) { throw "Không tải được danh sách NguonC" }
      $gotList = $true
    } catch {
      if ($attempt -eq 3) { throw }
      Write-Log ("WARN list attempt {0}: {1}" -f $attempt, $_.Exception.Message)
      Start-Sleep -Milliseconds (1000 * $attempt)
    }
  }

  $data = [IO.File]::ReadAllText($tmpList, [Text.Encoding]::UTF8) | ConvertFrom-Json
  $items = @($data.items)
  if (-not $items.Count) { throw "Không có items" }

  # Ngoài page 1, nạp thêm detail cho các phim bộ đang chiếu đã có ophim_slug
  # trong DB — để SV1 vẫn có link khi phim được sync nhờ mốc đổi của KK/VodPhim.
  $extraSlugs = @()
  try {
    $done = [uri]::EscapeDataString("Hoàn thành")
    $q = "$sbUrl/rest/v1/movies?select=id,ophim_slug&type=neq.movie&epstatus=neq.$done&ophim_slug=not.is.null&order=id.desc&limit=40"
    $sbHeaders = @{ apikey = $sbAnon; "Authorization" = "Bearer $sbAnon" }
    $rows = Invoke-WebRequest -Uri $q -Headers $sbHeaders -TimeoutSec 30 -UseBasicParsing
    foreach ($row in ($rows.Content | ConvertFrom-Json)) {
      $s = [string]$row.ophim_slug
      if ($s) { $extraSlugs += $s }
    }
  } catch {
    Write-Log ("WARN không lấy được slug từ DB: {0}" -f $_.Exception.Message)
  }

  $slugTargets = [ordered]@{}
  foreach ($it in $items) {
    $s = [string]$it.slug
    if ($s) { $slugTargets[$s] = 1 }
  }
  foreach ($s in $extraSlugs) { if ($s) { $slugTargets[$s] = 1 } }
  Write-Log ("slug targets: page1={0} + DB={1} -> {2}" -f $items.Count, $extraSlugs.Count, $slugTargets.Count)

  # Fetch detail từng phim ngay trên máy nhà. Runner chỉ đọc JSON này.
  $details = @{}
  $okDetail = 0
  foreach ($slug in $slugTargets.Keys) {
    if (-not $slug) { continue }

    $detailUrl = "https://phim.nguonc.com/api/film/" + [uri]::EscapeDataString($slug)
    $tmpDetail = Join-Path $env:TEMP "nhotphim-nc-detail.json"
    $got = $false
    # 502/timeout ở NguonC là tạm thời — thử lại vài lượt ngay trên máy nhà để
    # cache đầy đủ, không để runner phải tự gọi (403 Cloudflare).
    for ($attempt = 1; $attempt -le 3 -and -not $got; $attempt++) {
      try {
        if (Test-Path -LiteralPath $tmpDetail) { Remove-Item -LiteralPath $tmpDetail -Force }
        Invoke-WebRequest -Uri $detailUrl -Headers $headers -TimeoutSec 30 -UseBasicParsing -OutFile $tmpDetail
        if (-not (Test-Path -LiteralPath $tmpDetail)) { throw "Không tải được detail $slug" }
        $dj = [IO.File]::ReadAllText($tmpDetail, [Text.Encoding]::UTF8) | ConvertFrom-Json
        if (-not $dj -or -not $dj.movie) { throw "không có movie" }
        $details[$slug] = $dj
        $okDetail++
        $got = $true
      } catch {
        $msg = $_.Exception.Message
        if ($attempt -eq 3 -or $msg -match '404') {
          Write-Log ("WARN detail {0}: {1}" -f $slug, $msg)
        } else {
          Start-Sleep -Milliseconds (800 * $attempt)
        }
      }
    }
    Start-Sleep -Milliseconds 150
  }
  # Không bỏ cuộc vì vài detail lỗi: danh sách vẫn hữu ích để cập nhật mốc, và
  # runner có thể dùng lại detail cũ (đã validate tên/năm) khi bị Cloudflare chặn.
  if (-not $okDetail) { Write-Log "WARN không fetch được detail nào -> chỉ ghi danh sách" }

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

  # Giữ lại detail từ bản cache trước cho những slug lỗi lần này (link tập cũ
  # vẫn dùng được) — chỉ ghi đè bằng detail vừa fetch thành công.
  if (Test-Path -LiteralPath $target) {
    try {
      $oldPayload = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8) | ConvertFrom-Json
      if ($oldPayload.details) {
        foreach ($prop in $oldPayload.details.PSObject.Properties) {
          if (-not $details.ContainsKey($prop.Name)) { $details[$prop.Name] = $prop.Value }
        }
      }
    } catch {
      Write-Log ("WARN không đọc được detail cache cũ: {0}" -f $_.Exception.Message)
    }
  }
  # Payload được tạo trước khi clone; cập nhật lại key details sau khi đã gộp.
  $payloadObj = $payload | ConvertFrom-Json
  $payloadObj.details = [pscustomobject]$details
  $payload = $payloadObj | ConvertTo-Json -Depth 30 -Compress

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
