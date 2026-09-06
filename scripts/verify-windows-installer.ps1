[CmdletBinding()]
param([ValidateRange(10, 600)][int]$TimeoutSeconds = 120)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'installer-smoke-support.ps1')
# Installation is intentionally restricted to disposable GitHub-hosted runners.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Installer smoke requires a disposable GitHub-hosted Windows Actions runner.'
}
$project = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$profileRoot = [IO.Path]::GetFullPath($env:LOCALAPPDATA)
$installRoot = [IO.Path]::GetFullPath((Join-Path $profileRoot 'msfsCareerApproachCompanion'))
if (-not $installRoot.StartsWith($profileRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe installation path.' }
if (Test-Path -LiteralPath $installRoot) { throw 'Refusing to alter an existing installation.' }
$setup = Join-Path $project 'out/make/squirrel.windows/x64/msfs2024-mission-companion-windows-x64-setup.exe'
$update = Join-Path $installRoot 'Update.exe'
$results = [ordered]@{ install = $null; verification = $null; uninstall = $null; cleanup = $null }
$evidence = Join-Path $project 'out/installer-smoke.json'
$smokeDiagnosticsDirectory = Join-Path $project 'out/installer-smoke-diagnostics'
New-Item -ItemType Directory -Path $smokeDiagnosticsDirectory -Force | Out-Null
function Invoke-BoundedProcess([string]$File, [string[]]$Arguments, [string]$Phase) {
    $process = Start-Process -FilePath $File -ArgumentList $Arguments -PassThru -WindowStyle Hidden
    try {
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            & taskkill.exe /PID $process.Id /T /F | Out-Null
            $results[$Phase] = 'timeout'
            throw "$Phase timed out after $TimeoutSeconds seconds."
        }
        $process.Refresh()
        $results[$Phase] = $process.ExitCode
        Write-Host "$Phase exit code: $($process.ExitCode)"
        if ($process.ExitCode -ne 0) { throw "$Phase failed with exit code $($process.ExitCode)." }
    } finally { $process.Dispose() }
}
$smokeStartedUtc = [DateTime]::UtcNow
$previousElectronLogging = $env:ELECTRON_ENABLE_LOGGING
$previousElectronLogFile = $env:ELECTRON_LOG_FILE
$env:ELECTRON_ENABLE_LOGGING = '1'
$env:ELECTRON_LOG_FILE = Join-Path $smokeDiagnosticsDirectory 'electron-startup.log'
Push-Location $project
try {
    # Verify all build inputs before executing setup. Task4 re-runs final verification
    # after this smoke (and any signing), then uploads only that final staging output.
    & node scripts/verify-artifact.cjs --platform=win32 --arch=x64
    if ($LASTEXITCODE -ne 0) { throw 'Pre-install artifact verification failed.' }
    $versionDirectory = 'app-' + (& node -p "require('electron-winstaller').convertVersion(require('./package.json').version)")
    if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve Squirrel package version.' }
    $packages = @(Get-ChildItem -LiteralPath (Split-Path $setup) -Filter '*.nupkg' -File)
    if ($packages.Count -ne 1) { throw 'Expected one verified Squirrel package.' }
    $residueHashes = Get-SquirrelResidueHashes $packages[0].FullName $versionDirectory
    Invoke-InstallerSmokeLifecycle -Results $results -Verify {
        Invoke-BoundedProcess $setup @('--silent') 'install'
        $apps = @(Get-ChildItem -LiteralPath $installRoot -Directory -Filter 'app-*')
        if ($apps.Count -ne 1) { throw 'Expected exactly one installed application version.' }
        if ($apps[0].Name -ne $versionDirectory) { throw 'Installed version differs from verified package.' }
        $app = $apps[0].FullName
        if (-not (Test-Path -LiteralPath (Join-Path $app 'career-companion.exe'))) { throw 'Installed executable is missing.' }
        & node scripts/verify-artifact.cjs --platform=win32 --arch=x64 "--installed-dir=$app"
        $results.verification = $LASTEXITCODE
        if ($LASTEXITCODE -ne 0) { throw 'Installed runtime differs from verified portable package.' }
        $results.installedShortcuts = @(Get-InstalledShortcuts $installRoot)
    } -Uninstall {
            # Stop only processes whose executable is under this new installation.
            Get-Process -Name 'career-companion' -ErrorAction SilentlyContinue | Where-Object {
                $_.Path -and $_.Path.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)
            } | ForEach-Object {
                $installedProcess = $_
                Stop-Process -InputObject $installedProcess -Force
                if (-not $installedProcess.WaitForExit(10000)) {
                    throw "Installed process $($installedProcess.Id) did not exit after termination."
                }
            }
            if (Test-Path -LiteralPath $update) { Invoke-BoundedProcess $update @('--uninstall', '--silent') 'uninstall' }
            else { $results.uninstall = 'Update.exe missing'; throw 'Cannot verify uninstall: Update.exe missing.' }
            $deadline = [DateTime]::UtcNow.AddSeconds(20)
            do {
                try {
                    # Squirrel may leave only the exact, verified updater/snapshot residue
                    # observed in hosted CI. This is semantic uninstall, not full erasure.
                    Assert-SquirrelUninstalled $installRoot $versionDirectory $residueHashes
                    $running = @(Get-Process | Where-Object {
                        $_.Path -and $_.Path.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)
                    })
                    if ($running.Count -ne 0) { throw "Uninstall left running processes: $($running.Id -join ', ')." }
                    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
                        $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
                        try {
                            $key = $registry.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\msfsCareerApproachCompanion')
                            if ($null -ne $key) { $key.Dispose(); throw "Uninstall left its registry entry ($view)." }
                        } finally { $registry.Dispose() }
                    }
                    $shortcuts = @(Get-InstalledShortcuts $installRoot)
                    if ($results.Contains('installedShortcuts')) {
                        $shortcuts += @($results.installedShortcuts | Where-Object { Test-Path -LiteralPath $_ })
                    }
                    if ($shortcuts.Count -ne 0) { throw "Uninstall left shortcuts: $($shortcuts -join ', ')." }
                    $results.uninstallVerification = 'application removed; only verified Squirrel residue permitted'
                    break
                } catch {
                    if ([DateTime]::UtcNow -ge $deadline) { throw }
                }
                Start-Sleep -Milliseconds 250
            } while ($true)
    } -Diagnostics {
            # Collect before destructive cleanup, including the exact leftover files.
            $results.leftovers = @(Get-InstallerLeftovers $installRoot)
            $results.leftovers | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $smokeDiagnosticsDirectory 'leftovers.json')
            Write-Host "Pre-cleanup installation contents: $($results.leftovers | ConvertTo-Json -Depth 5 -Compress)"
            # Squirrel eef37460ae writes uninstall logs directly to Path.GetTempPath().
            $logRoots = @($installRoot, (Join-Path $profileRoot 'SquirrelTemp'), [IO.Path]::GetTempPath().TrimEnd('\'))
            for ($index = 0; $index -lt $logRoots.Count; $index++) {
                if (-not (Test-Path -LiteralPath $logRoots[$index])) { continue }
                foreach ($log in Get-ChildItem -LiteralPath $logRoots[$index] -Filter 'Squirrel*.log' -File -Recurse:($index -lt 2) -Force) {
                    $name = $log.FullName.Substring($logRoots[$index].Length + 1).Replace('\', '_')
                    Copy-Item -LiteralPath $log.FullName -Destination (Join-Path $smokeDiagnosticsDirectory "$index-$name")
                }
            }
            # Hooks persist subprocess output outside the installation before Squirrel deletes it.
            foreach ($directory in Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'msfs-career-squirrel-*') {
                if ($directory.CreationTimeUtc -lt $smokeStartedUtc) { continue }
                Copy-Item -LiteralPath $directory.FullName -Destination $smokeDiagnosticsDirectory -Recurse
            }
            $results.processes = @(Get-Process | Where-Object {
                $_.Path -and $_.Path.StartsWith($installRoot + '\', [StringComparison]::OrdinalIgnoreCase)
            } | Select-Object Id, ProcessName, Path)
            $results.processes | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $smokeDiagnosticsDirectory 'processes.json')
            & node scripts/verify-squirrel-lifecycle.cjs $smokeDiagnosticsDirectory
            if ($LASTEXITCODE -ne 0) { throw 'Squirrel lifecycle diagnostics report a failed or missing hook.' }
    } -Cleanup {
            # Only this absent-before-test directory can be removed; check its resolved
            # absolute boundary again before recursive cleanup, including failure paths.
            if (Test-Path -LiteralPath $installRoot) {
                $resolved = (Resolve-Path -LiteralPath $installRoot).Path
                if ($resolved -ne $installRoot -or -not $resolved.StartsWith($profileRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe cleanup path.' }
                if ((Get-Item -LiteralPath $resolved).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing reparse-point cleanup.' }
                Remove-Item -LiteralPath $resolved -Recurse -Force
            }
            $results.cleanup = 'complete'
    }
} finally {
    $env:ELECTRON_ENABLE_LOGGING = $previousElectronLogging
    $env:ELECTRON_LOG_FILE = $previousElectronLogFile
    $results | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $evidence
    Pop-Location
}
