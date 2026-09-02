param([switch]$Remove)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = $root.Replace('\', '/')
$config = Get-Content -LiteralPath (Join-Path $root 'config\automation.json') -Raw | ConvertFrom-Json
$taskName = $config.taskName

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Задача удалена: $taskName"
    return
}
if (-not $config.enabled) {
    throw 'Сначала установите enabled=true в config/automation.json'
}
foreach ($command in @('git', 'node', 'npm')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Команда не найдена: $command"
    }
}
$gh = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
if (-not (Test-Path -LiteralPath $gh)) {
    $ghCommand = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $ghCommand) {
        throw 'GitHub CLI не найден'
    }
    $gh = $ghCommand.Source
}
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
if (-not (Test-Path -LiteralPath $wsl)) {
    throw 'WSL не найден'
}
& git -C $root rev-parse --is-inside-work-tree *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'Текущая папка ещё не является Git-репозиторием'
}
& git -C $root remote get-url origin *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'Не настроен Git remote origin'
}
& $gh auth status
if ($LASTEXITCODE -ne 0) {
    throw 'Сначала выполните gh auth login'
}
foreach ($path in @('keys\white-fox-release.jks', '.env.signing.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $path))) {
        throw "Не найден локальный файл подписи: $path"
    }
}

$runner = Join-Path $PSScriptRoot 'auto-release.ps1'
$arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $runner + '"'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $root
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$logon.Delay = 'PT5M'
$dailyTime = [DateTime]::ParseExact($config.dailyCheckTime, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
$daily = New-ScheduledTaskTrigger -Daily -At $dailyTime
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 12) -DisallowStartIfOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $daily) -Settings $settings -Principal $principal -Description 'Проверка stable Firefox Android, безопасная сборка и публикация Белого лиса' -Force | Out-Null
Write-Host "Задача установлена: $taskName"
Write-Host 'Запуск: через 5 минут после входа в Windows и ежедневно.'
