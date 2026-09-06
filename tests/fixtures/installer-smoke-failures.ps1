$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$helper = Join-Path $PSScriptRoot '../../scripts/installer-smoke-support.ps1'
if (-not (Test-Path $helper)) { throw 'Missing smoke failure-preservation support.' }
. $helper
$fixture = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
try {
    New-Item -ItemType Directory -Path (Join-Path $fixture 'app-1.2.3') -Force | Out-Null
    Set-Content (Join-Path $fixture 'app-1.2.3/career-companion.exe') 'surviving runtime'
    $results = [ordered]@{}
    $events = [Collections.Generic.List[string]]::new()
    $caught = $null
    try {
        Invoke-InstallerSmokeLifecycle -Results $results -Verify {
            throw 'original verification failure'
        } -Uninstall {
            throw 'uninstall left an application version installed'
        } -Diagnostics {
            $events.Add('diagnostics')
            $results.leftovers = @(Get-InstallerLeftovers $fixture)
        } -Cleanup {
            $events.Add('cleanup')
            throw 'cleanup access denied'
        }
    } catch { $caught = $_.Exception.Message }
    if ($caught -ne 'original verification failure') { throw "Primary failure was lost: $caught" }
    if ($results.errors.Count -ne 3) { throw 'Secondary failures were lost.' }
    if (($events -join ',') -ne 'diagnostics,cleanup') { throw 'Diagnostics did not precede cleanup.' }
    if (-not ($results.leftovers | Where-Object { $_.path -eq 'app-1.2.3/career-companion.exe' -and $_.length -gt 0 })) { throw 'Surviving runtime was not recorded.' }
    $results = [ordered]@{}
    try {
        Invoke-InstallerSmokeLifecycle -Results $results -Verify {} -Uninstall { throw 'uninstall failure' } -Diagnostics { throw 'diagnostic failure' } -Cleanup {}
        throw 'Uninstall failure was swallowed'
    } catch {
        if ($_.Exception.Message -ne 'uninstall failure') { throw }
    }
    if ($results.errors.Count -ne 2) { throw 'Diagnostic failure missing.' }
    $results = [ordered]@{}
    Invoke-InstallerSmokeLifecycle -Results $results -Verify {} -Uninstall {} -Diagnostics {} -Cleanup {}
    if ($results.errors.Count -ne 0) { throw 'Successful lifecycle failed.' }
} finally {
    # Unique fixture directory created above; never touch the installed application.
    if (Test-Path -LiteralPath $fixture) { Remove-Item -LiteralPath $fixture -Recurse -Force }
}
