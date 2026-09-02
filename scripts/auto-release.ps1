param(
    [switch]$CheckOnly,
    [switch]$Force,
    [switch]$NoPublish,
    [switch]$PublishCurrent
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$env:GIT_CONFIG_COUNT = '1'
$env:GIT_CONFIG_KEY_0 = 'safe.directory'
$env:GIT_CONFIG_VALUE_0 = $root.Replace('\', '/')
$config = Get-Content -LiteralPath (Join-Path $root 'config\automation.json') -Raw | ConvertFrom-Json
$automation = Join-Path $root 'artifacts\automation'
New-Item -ItemType Directory -Force -Path $automation | Out-Null
$statusPath = Join-Path $automation 'status.json'
$candidatePath = Join-Path $automation 'candidate.json'
$distro = $config.wslDistribution
$wslProject = '/mnt/c/Users/alex/Downloads/Firefox ru'
$wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
$gh = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
if (-not (Test-Path -LiteralPath $gh)) {
    $ghCommand = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $ghCommand) {
        throw 'GitHub CLI was not found'
    }
    $gh = $ghCommand.Source
}
$mutex = [Threading.Mutex]::new($false, 'Local\WhiteFoxAutoRelease')
$locked = $false
$backup = $null

function Write-Status {
    param([string]$State, [string]$Stage, [string]$Message)
    [ordered]@{
        state = $State
        stage = $Stage
        message = $Message
        time = (Get-Date).ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding utf8
}

function Invoke-Checked {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw ("Command failed with exit code {0}: {1}" -f $LASTEXITCODE, $File)
    }
}

try {
    $locked = $mutex.WaitOne(0)
    if (-not $locked) {
        throw 'Another White Fox release check is already running'
    }
    Write-Status 'running' 'check' 'Checking Mozilla stable release'
    Invoke-Checked 'node' @(
        (Join-Path $root 'scripts\check-upstream.mjs'),
        '--output', $candidatePath
    )
    $candidate = Get-Content -LiteralPath $candidatePath -Raw | ConvertFrom-Json
    $current = Get-Content -LiteralPath (Join-Path $root 'config\upstream.json') -Raw | ConvertFrom-Json
    $isNew = $candidate.revision -ne $current.revision
    $shouldUpdate = $isNew -and -not $PublishCurrent

    if ($CheckOnly) {
        [ordered]@{
            currentVersion = $current.version
            availableVersion = $candidate.version
            updateAvailable = $isNew
            tag = $candidate.tag
            revision = $candidate.revision
        } | ConvertTo-Json
        Write-Status 'complete' 'check' 'Version check completed'
        return
    }
    if (-not $isNew -and -not $PublishCurrent) {
        Write-Status 'complete' 'no-update' "Firefox Android $($current.version) is current"
        return
    }
    if (-not $config.enabled -and -not $Force) {
        throw 'Automation is disabled in config/automation.json; use -Force for a manual run'
    }
    foreach ($path in @('keys\white-fox-release.jks', '.env.signing.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $root $path))) {
            throw "Required local signing file is missing: $path"
        }
    }

    $publish = $config.autoPublish -and -not $NoPublish
    if ($publish) {
        Invoke-Checked 'git' @('-C', $root, 'rev-parse', '--is-inside-work-tree')
        if ($config.requireCleanGit) {
            $changes = & git -C $root status --porcelain
            if ($LASTEXITCODE -ne 0 -or $changes) {
                throw 'Git working tree must be clean before an automatic release'
            }
        }
        Invoke-Checked 'git' @('-C', $root, 'remote', 'get-url', 'origin')
        Invoke-Checked $gh @('auth', 'status')
    }

    if ($shouldUpdate) {
        $backup = Join-Path $automation ('rollback-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        New-Item -ItemType Directory -Force -Path $backup | Out-Null
        foreach ($path in @('README.md', 'config\upstream.json', 'config\source-hashes.json', 'config\branding-source-hashes.json')) {
            $destination = Join-Path $backup $path
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
            Copy-Item -LiteralPath (Join-Path $root $path) -Destination $destination
        }

        Write-Status 'running' 'source' "Preparing Firefox Android $($candidate.version)"
        $cache = Join-Path $root 'work\upstream-cache.git'
        if (-not (Test-Path -LiteralPath $cache)) {
            Invoke-Checked 'git' @('init', '--bare', $cache)
            Invoke-Checked 'git' @('-C', $cache, 'remote', 'add', 'origin', $candidate.repository)
        }
        $cacheRemote = & git -C $cache remote get-url origin
        if ($LASTEXITCODE -ne 0 -or $cacheRemote -ne $candidate.repository) {
            throw 'Unexpected upstream cache remote'
        }
        Invoke-Checked 'git' @(
            '-C', $cache, 'fetch', '--force', '--depth', '1', 'origin',
            "refs/tags/$($candidate.tag):refs/tags/$($candidate.tag)"
        )
        $bundle = Join-Path $automation 'upstream.bundle'
        Remove-Item -LiteralPath $bundle -Force -ErrorAction SilentlyContinue
        Invoke-Checked 'git' @('-C', $cache, 'bundle', 'create', $bundle, "refs/tags/$($candidate.tag)")
        Invoke-Checked $wsl @(
            '-d', $distro, '--user', 'root', '--exec', 'bash',
            "$wslProject/scripts/build-session.sh", 'update-source',
            $candidate.version, $candidate.revision, $candidate.tag,
            "$wslProject/artifacts/automation/upstream.bundle"
        )
        Invoke-Checked $wsl @(
            '-d', $distro, '--exec', 'python3',
            "$wslProject/scripts/pin-upstream.py", $wslProject,
            '/mnt/ru-browser-build/firefox-source',
            "$wslProject/artifacts/automation/candidate.json"
        )
        Invoke-Checked 'node' @((Join-Path $root 'scripts\fetch-inputs.mjs'))
        Invoke-Checked 'npm' @('test')
        Invoke-Checked 'node' @((Join-Path $root 'scripts\prepare-overlay.mjs'))
        Invoke-Checked $wsl @(
            '-d', $distro, '--exec', 'python3',
            "$wslProject/scripts/validate-branding.py"
        )
        Invoke-Checked $wsl @(
            '-d', $distro, '--exec', 'python3', '-m', 'unittest',
            'discover', '-s', "$wslProject/test", '-p', 'test_*.py'
        )

        Write-Status 'running' 'build' "Building Firefox Android $($candidate.version)"
        Invoke-Checked $wsl @(
            '-d', $distro, '--user', 'root', '--exec', 'bash',
            "$wslProject/scripts/build-session.sh", 'release'
        )
    }

    $version = if ($shouldUpdate) { $candidate.version } else { $current.version }
    $apk = Join-Path $root "artifacts\apk\bely-lis-$version-arm64-release.apk"
    foreach ($path in @($apk, (Join-Path $root 'artifacts\apk\SHA256SUMS.release'), (Join-Path $root 'artifacts\apk\build-report.release.json'))) {
        if (-not (Test-Path -LiteralPath $path)) {
            throw "Release output is missing: $path"
        }
    }

    if ($publish) {
        Write-Status 'running' 'publish' "Publishing White Fox $version"
        if ($shouldUpdate) {
            Invoke-Checked 'git' @('-C', $root, 'add', 'README.md', 'config/upstream.json', 'config/source-hashes.json', 'config/branding-source-hashes.json')
            Invoke-Checked 'git' @('-C', $root, 'commit', '-m', "Firefox Android $version")
            Invoke-Checked 'git' @('-C', $root, 'push', 'origin', 'HEAD')
        }
        $tag = "v$version-$($config.releaseTagSuffix)"
        & $gh release view $tag *> $null
        if ($LASTEXITCODE -eq 0) {
            throw "GitHub release already exists: $tag"
        }
        $notes = Join-Path $automation "release-$version.md"
        @(
            "# Белый лис $version"
            ""
            "Основа: Firefox Android $version."
            ""
            "> Не используйте эту сборку как основной браузер. Она содержит дополнительный российский корневой сертификат. Рекомендуется отдельный профиль Android или Второе пространство."
            ""
            "APK предназначен для ARM64. Перед установкой сверьте SHA-256."
        ) | Set-Content -LiteralPath $notes -Encoding utf8
        Invoke-Checked $gh @(
            'release', 'create', $tag,
            $apk,
            (Join-Path $root 'artifacts\apk\SHA256SUMS.release'),
            (Join-Path $root 'artifacts\apk\build-report.release.json'),
            (Join-Path $root 'artifacts\apk\signature.release.txt'),
            '--title', "Белый лис $version",
            '--notes-file', $notes
        )
    }
    Write-Status 'complete' 'done' "White Fox $version release completed"
} catch {
    if ($backup) {
        foreach ($path in @('README.md', 'config\upstream.json', 'config\source-hashes.json', 'config\branding-source-hashes.json')) {
            $saved = Join-Path $backup $path
            if (Test-Path -LiteralPath $saved) {
                Copy-Item -LiteralPath $saved -Destination (Join-Path $root $path) -Force
            }
        }
    }
    Write-Status 'failed' 'stopped' $_.Exception.Message
    throw
} finally {
    if ($locked) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
