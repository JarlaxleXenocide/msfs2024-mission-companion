# Keep installer failures visible even when uninstall, evidence collection or cleanup fails.
function Invoke-InstallerSmokeLifecycle {
    param([System.Collections.IDictionary]$Results, [scriptblock]$Verify, [scriptblock]$Uninstall,
          [scriptblock]$Diagnostics, [scriptblock]$Cleanup)
    $Results.errors = @()
    $firstFailure = $null
    foreach ($phase in @('Verify', 'Uninstall', 'Diagnostics', 'Cleanup')) {
        try { & (Get-Variable -Name $phase -ValueOnly) }
        catch {
            if ($null -eq $firstFailure) { $firstFailure = $_ }
            $Results.errors += [ordered]@{ phase = $phase; message = $_.Exception.Message; detail = ($_ | Out-String) }
            Write-Warning "$phase failed: $($_.Exception.Message)"
        }
    }
    if ($null -ne $firstFailure) { throw $firstFailure }
}

function Get-InstallerLeftovers([string]$Root) {
    if (-not (Test-Path -LiteralPath $Root)) { return }
    # Do not follow reparse points; record them as evidence instead.
    foreach ($entry in Get-ChildItem -LiteralPath $Root -Force -Recurse) {
        [ordered]@{
            path = $entry.FullName.Substring($Root.TrimEnd('\').Length + 1).Replace('\', '/')
            directory = $entry.PSIsContainer
            length = $(if ($entry.PSIsContainer) { $null } else { $entry.Length })
            attributes = $entry.Attributes.ToString()
        }
    }
}

function Assert-SquirrelUninstalled {
    param([string]$Root, [string]$VersionDirectory, [System.Collections.IDictionary]$ExpectedHashes)
    if ($VersionDirectory -notmatch '^app-[0-9][0-9A-Za-z.-]*$') { throw 'Invalid installed version directory.' }
    if (-not (Test-Path -LiteralPath $Root)) { return }
    if ((Get-Item -LiteralPath $Root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Uninstall left a reparse point.' }
    $allowed = @('Update.exe', "$VersionDirectory/squirrel.exe", "$VersionDirectory/v8_context_snapshot.bin")
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($Root)
    $markerFound = $false
    while ($pending.Count -gt 0) {
        foreach ($entry in Get-ChildItem -LiteralPath $pending.Dequeue() -Force) {
            $relative = $entry.FullName.Substring($Root.TrimEnd('\').Length + 1).Replace('\', '/')
            if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Uninstall left a reparse point: $relative" }
            if ($entry.PSIsContainer) {
                if ($relative -ne $VersionDirectory) { throw "Uninstall left unexpected directory: $relative" }
                $pending.Enqueue($entry.FullName)
            } elseif ($relative -eq '.dead') {
                if ([IO.File]::ReadAllText($entry.FullName) -ne ' ') { throw 'Invalid Squirrel uninstall marker.' }
                $markerFound = $true
            } else {
                if ($relative -notin $allowed -or -not $ExpectedHashes.Contains($relative)) { throw "Uninstall left unexpected file: $relative" }
                $sha = [Security.Cryptography.SHA256]::Create()
                try { $actual = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($entry.FullName))).Replace('-', '') }
                finally { $sha.Dispose() }
                if ($actual -ne $ExpectedHashes[$relative]) { throw "Uninstall residue differs from verified package: $relative" }
            }
        }
    }
    if (-not $markerFound) { throw 'Uninstall did not leave the Squirrel .dead marker.' }
}

function Get-SquirrelResidueHashes([string]$Package, [string]$VersionDirectory) {
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Package)
    try {
        $hashes = @{}
        foreach ($name in @('squirrel.exe', 'v8_context_snapshot.bin')) {
            $entry = $archive.GetEntry("lib/net45/$name")
            if ($null -eq $entry) { throw "Verified package lacks $name" }
            $stream = $entry.Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $hashes["$VersionDirectory/$name"] = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
            finally { $sha.Dispose(); $stream.Dispose() }
        }
        $hashes['Update.exe'] = $hashes["$VersionDirectory/squirrel.exe"]
        return $hashes
    } finally { $archive.Dispose() }
}

function Get-InstalledShortcuts([string]$Root) {
    $shell = New-Object -ComObject WScript.Shell
    try {
        foreach ($folder in @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('StartMenu'))) {
            if (-not (Test-Path -LiteralPath $folder)) { continue }
            foreach ($file in Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File -Recurse) {
                $shortcut = $shell.CreateShortcut($file.FullName)
                try {
                    if ($shortcut.TargetPath.StartsWith($Root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { $file.FullName }
                } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
            }
        }
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}
