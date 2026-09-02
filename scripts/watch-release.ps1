$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$positions = @{}
Write-Host 'Мониторинг релизной сборки. Ctrl+C остановит только просмотр.'
while ($true) {
    foreach ($name in @('release-geckoview', 'release-fenix')) {
        $path = Join-Path $root "work\linux-build\logs\$name.log"
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $lines = @(Get-Content -LiteralPath $path)
        $start = if ($positions.ContainsKey($path) -and $positions[$path] -le $lines.Count) { $positions[$path] } else { 0 }
        if ($lines.Count -gt $start) {
            $lines[$start..($lines.Count - 1)] | ForEach-Object { Write-Host "[$name] $_" }
        }
        $positions[$path] = $lines.Count
    }
    $statusPath = Join-Path $root 'artifacts\release-build-status.json'
    if (Test-Path -LiteralPath $statusPath) {
        $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
        $Host.UI.RawUI.WindowTitle = "Белый лис: $($status.stage)"
        if ($status.status -eq 'complete') {
            $apk = Get-ChildItem -LiteralPath (Join-Path $root 'artifacts\apk') -Filter 'bely-lis-*-arm64-release.apk' |
                Sort-Object LastWriteTime -Descending | Select-Object -First 1
            Write-Host "ГОТОВО: $($apk.FullName)" -ForegroundColor Green
            break
        }
        if ($status.status -eq 'failed') {
            Write-Host "ОШИБКА: $($status.error)" -ForegroundColor Red
            break
        }
    }
    Start-Sleep -Seconds 5
}
