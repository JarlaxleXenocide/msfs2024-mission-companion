$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot '../../scripts/installer-smoke-support.ps1')
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('squirrel-residue-' + [guid]::NewGuid().ToString())
$versionDirectory = 'app-0.1.1'
try {
    New-Item -ItemType Directory -Path (Join-Path $fixture $versionDirectory) -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $fixture '.dead'), ' ')
    $expected = @{}
    foreach ($path in @('Update.exe', 'app-0.1.1/squirrel.exe', 'app-0.1.1/v8_context_snapshot.bin')) {
        [IO.File]::WriteAllText((Join-Path $fixture $path), "verified bytes for $path")
        $sha = [Security.Cryptography.SHA256]::Create(); try { $expected[$path] = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes((Join-Path $fixture $path)))).Replace('-', '') } finally { $sha.Dispose() }
    }
    Assert-SquirrelUninstalled -Root $fixture -VersionDirectory $versionDirectory -ExpectedHashes $expected
    foreach ($unexpected in @('career-companion.exe', 'resources/app.asar', 'other.dll', 'Squirrel-UpdateSelf.log')) {
        $path = Join-Path $fixture "$versionDirectory/$unexpected"
        $parent = Split-Path $path
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
        [IO.File]::WriteAllText($path, 'unexpected runtime')
        $rejected = $false
        try { Assert-SquirrelUninstalled -Root $fixture -VersionDirectory $versionDirectory -ExpectedHashes $expected } catch { $rejected = $true }
        if (-not $rejected) { throw "Accepted unexpected residue: $unexpected" }
        Remove-Item -LiteralPath $path -Force
        if ($unexpected -eq 'resources/app.asar') { Remove-Item -LiteralPath $parent -Force }
    }
    [IO.File]::AppendAllText((Join-Path $fixture 'Update.exe'), 'changed')
    $rejected = $false
    try { Assert-SquirrelUninstalled -Root $fixture -VersionDirectory $versionDirectory -ExpectedHashes $expected } catch { $rejected = $true }
    if (-not $rejected) { throw 'Accepted changed updater bytes' }
    [IO.File]::WriteAllText((Join-Path $fixture 'Update.exe'), 'verified bytes for Update.exe')
    Remove-Item -LiteralPath (Join-Path $fixture '.dead')
    $rejected = $false
    try { Assert-SquirrelUninstalled -Root $fixture -VersionDirectory $versionDirectory -ExpectedHashes $expected } catch { $rejected = $true }
    if (-not $rejected) { throw 'Accepted residue without .dead marker' }
    [IO.File]::WriteAllText((Join-Path $fixture '.dead'), ' ')
    $link = Join-Path $fixture 'linked-runtime'
    New-Item -ItemType Junction -Path $link -Target (Join-Path $fixture $versionDirectory) | Out-Null
    $rejected = $false
    try { Assert-SquirrelUninstalled -Root $fixture -VersionDirectory $versionDirectory -ExpectedHashes $expected } catch { $rejected = $_.Exception.Message -match 'reparse point' }
    if (-not $rejected) { throw 'Accepted reparse point residue' }
    [IO.Directory]::Delete($link)
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $package = Join-Path $fixture 'verified.nupkg'
    $archive = [IO.Compression.ZipFile]::Open($package, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in @('squirrel.exe', 'v8_context_snapshot.bin')) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $fixture "$versionDirectory/$name"), "lib/net45/$name") | Out-Null
        }
    } finally { $archive.Dispose() }
    $packageHashes = Get-SquirrelResidueHashes $package $versionDirectory
    if ($packageHashes['Update.exe'] -ne $expected["$versionDirectory/squirrel.exe"] -or
        $packageHashes["$versionDirectory/squirrel.exe"] -ne $expected["$versionDirectory/squirrel.exe"] -or
        $packageHashes["$versionDirectory/v8_context_snapshot.bin"] -ne $expected["$versionDirectory/v8_context_snapshot.bin"]) { throw 'Residue hashes did not come from package entries.' }
    $results = [ordered]@{}
    $smokeDiagnosticsDirectory = Join-Path $fixture 'diagnostics'
    New-Item -ItemType Directory -Path $smokeDiagnosticsDirectory | Out-Null
    Invoke-InstallerSmokeLifecycle -Results $results -Verify {} -Uninstall {} -Diagnostics {
        'diagnostic evidence' | Set-Content (Join-Path $smokeDiagnosticsDirectory 'evidence.txt')
    } -Cleanup {}
    if (-not (Test-Path (Join-Path $smokeDiagnosticsDirectory 'evidence.txt'))) { throw 'Caller diagnostic path was shadowed' }
} finally {
    if (Test-Path -LiteralPath $fixture) {
        if ((Resolve-Path -LiteralPath $fixture).Path -ne [IO.Path]::GetFullPath($fixture)) { throw 'Unsafe fixture cleanup' }
        Remove-Item -LiteralPath $fixture -Recurse -Force
    }
}


