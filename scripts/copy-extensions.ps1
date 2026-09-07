<#
.SYNOPSIS
Copies VS Code's data-only extensions into resources/extensions.

.DESCRIPTION
tscode has no extension host, so only extensions that ship pure data are useful -
grammars, colour themes, file icon themes. "Data-only" is exactly "no main entry
point in package.json"; anything narrower loses a theme that carries no grammar,
which is how the default file icon theme went missing. They are copied verbatim so
the stock extension scanner reads them exactly as upstream does.

Prints counts only - never file contents.

.PARAMETER VSCodeRoot
The VS Code checkout. Defaults to $env:TSCODE_VSCODE_ROOT, then ../../vscode.

.PARAMETER Destination
Where the extension folders are written. Defaults to <repo-root>/resources/extensions.
#>
[CmdletBinding()]
param(
    [string]$VSCodeRoot,
    [string]$Destination
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. ([IO.Path]::Combine($PSScriptRoot, 'vscode-source.ps1'))

$extensionsRoot = [IO.Path]::Combine((Get-VSCodeRoot $VSCodeRoot), 'extensions')
if (-not $Destination) { $Destination = [IO.Path]::Combine((Get-RepoRoot), 'resources', 'extensions') }

function Test-DataOnlyExtension {
    param([IO.DirectoryInfo]$Folder)

    # Upstream's test fixtures do carry a main today, so this only guards the future.
    if ($Folder.Name -like '*-test' -or $Folder.Name -like '*-tests') { return $false }

    $manifestPath = [IO.Path]::Combine($Folder.FullName, 'package.json')
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { return $false }

    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    -not ($manifest.PSObject.Properties.Name -contains 'main')
}

if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
New-Item -ItemType Directory -Path $Destination -Force | Out-Null

$copied = [System.Collections.Generic.List[string]]::new()
foreach ($folder in (Get-ChildItem -LiteralPath $extensionsRoot -Directory | Sort-Object Name)) {
    if (-not (Test-DataOnlyExtension -Folder $folder)) { continue }
    $files = @(Get-SourceFilesUnder -SourceRoot $extensionsRoot -Relative $folder.Name)
    Copy-SourceFiles -SourceRoot $extensionsRoot -TargetRoot $Destination -RelativePaths $files | Out-Null
    $copied.Add($folder.Name)
}

$files = Get-ChildItem -LiteralPath $Destination -Recurse -File
$bytes = ($files | Measure-Object -Property Length -Sum).Sum

Write-Host "Extensions copied: $($copied.Count)"
Write-Host ("  " + ($copied -join ', '))
Write-Host "Files: $($files.Count)"
Write-Host ("Size:  {0:N1} MB" -f ($bytes / 1MB))
