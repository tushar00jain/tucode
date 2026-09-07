# Shared source-tree resolution for the copy scripts.
# Dot-source this; it defines functions only.

function Get-RepoRoot {
    Split-Path -Parent $PSScriptRoot
}

# The VS Code checkout to copy from. Precedence:
#   1. -VSCodeRoot argument
#   2. $env:TSCODE_VSCODE_ROOT
#   3. ../../vscode relative to this repo (sibling-checkout layout)
function Get-VSCodeRoot {
    param([string]$VSCodeRoot)

    if (-not $VSCodeRoot) { $VSCodeRoot = $env:TSCODE_VSCODE_ROOT }
    if (-not $VSCodeRoot) { $VSCodeRoot = [IO.Path]::Combine((Get-RepoRoot), '..', '..', 'vscode') }

    if (-not (Test-Path -LiteralPath $VSCodeRoot)) {
        throw "VS Code checkout not found at '$VSCodeRoot'. Pass -VSCodeRoot <path> or set TSCODE_VSCODE_ROOT."
    }

    $resolved = (Resolve-Path -LiteralPath $VSCodeRoot).ProviderPath
    if (-not (Test-Path -LiteralPath ([IO.Path]::Combine($resolved, 'src', 'vs')))) {
        throw "'$resolved' does not look like a VS Code checkout (no src/vs)."
    }
    $resolved
}

# Path of $Full relative to $Base, with forward slashes. $null when $Full is outside $Base.
function Get-RelativeUnderRoot {
    param([string]$Base, [string]$Full)

    $normalizedBase = [IO.Path]::GetFullPath($Base).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $normalizedFull = [IO.Path]::GetFullPath($Full)
    if (-not $normalizedFull.StartsWith($normalizedBase, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    $normalizedFull.Substring($normalizedBase.Length) -replace '\\', '/'
}

function ConvertTo-NativePath {
    param([string]$Root, [string]$Relative)
    [IO.Path]::Combine($Root, ($Relative -replace '/', '\'))
}

# Source extensions we vendor as text and rewrite to LF, so the destination matches
# .gitattributes' `* text=auto eol=lf` whatever the source checkout hands out. A Windows
# clone with core.eol at its default of native serves CRLF, and CRLF everywhere would make
# every vendored file differ from its counterpart - which fails silently, as "everything is
# hand-written, refresh nothing".
#
# .txt is deliberately absent: upstream marks LICENSE.txt and ThirdPartyNotices.txt
# eol=crlf, and ships binary fixtures under that extension. Media - .png, .gif, .mp3, .ttf,
# .woff, .wasm - is copied byte-for-byte by falling through this list.
#
# The shell-integration scripts are here for a second reason on top of that one: bash, zsh
# and fish read them as init files on a Unix host, where a trailing CR is part of the token
# and every line breaks. Upstream marks .ps1 and .sh eol=lf for the same reason.
$script:LfExtensions = @(
    '.ts', '.js', '.mjs', '.css', '.json', '.html', '.md', '.scm', '.svg'
    '.sh', '.zsh', '.fish', '.ps1', '.psd1', '.psm1', '.ps1xml'
    '.vscodeignore', '.code-snippets', '.tmLanguage'  # text the bundled extensions carry
    '.ahp-version'  # a dotfile, so this is its whole name, not a suffix; contents are one hash
)

# CRLF collapsed to LF. A lone CR is data, not a line ending, so it survives.
function ConvertTo-LfBytes {
    param([byte[]]$Bytes)

    $at = [Array]::IndexOf($Bytes, [byte]13)
    if ($at -lt 0) { return , $Bytes }

    $out = [byte[]]::new($Bytes.Length)
    $read = 0
    $write = 0
    while ($at -ge 0) {
        $run = $at - $read
        if ($run -gt 0) { [Buffer]::BlockCopy($Bytes, $read, $out, $write, $run); $write += $run }
        if ($at + 1 -lt $Bytes.Length -and $Bytes[$at + 1] -eq 10) { $read = $at + 1 }
        else { $out[$write++] = 13; $read = $at + 1 }
        $at = [Array]::IndexOf($Bytes, [byte]13, $read)
    }
    $tail = $Bytes.Length - $read
    if ($tail -gt 0) { [Buffer]::BlockCopy($Bytes, $read, $out, $write, $tail); $write += $tail }

    $result = [byte[]]::new($write)
    [Buffer]::BlockCopy($out, 0, $result, 0, $write)
    , $result
}

# A file's bytes as they belong in the destination. Both the copy and the comparison below
# read through here, so the two can never disagree about what "the same file" means.
function Get-PortableBytes {
    param([string]$Path)

    $bytes = [IO.File]::ReadAllBytes($Path)
    if (-not ($script:LfExtensions -contains [IO.Path]::GetExtension($Path))) { return , $bytes }
    # An extension is a claim, not proof - upstream ships binary fixtures under text names,
    # and stripping CR bytes from one corrupts it.
    if ([Array]::IndexOf($bytes, [byte]0) -ge 0) { return , $bytes }
    ConvertTo-LfBytes $bytes
}

function Get-ContentHash {
    param([byte[]]$Bytes)

    $md5 = [Security.Cryptography.MD5]::Create()
    try { [Convert]::ToBase64String($md5.ComputeHash($Bytes)) } finally { $md5.Dispose() }
}

# A destination file is ours, not upstream's, when it has no counterpart in the source
# tree (the tauri/ transports) or its content differs from that counterpart (a stock file
# replaced in place, as the nls stub replaces stock's loader). Neither may be overwritten
# or swept away by a re-copy.
function Test-HandWritten {
    param([string]$SourceFile, [string]$TargetFile)

    if (-not (Test-Path -LiteralPath $TargetFile -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath $SourceFile -PathType Leaf)) { return $true }

    $source = Get-PortableBytes $SourceFile
    $target = Get-PortableBytes $TargetFile
    if ($source.Length -ne $target.Length) { return $true }
    (Get-ContentHash $source) -ne (Get-ContentHash $target)
}

# Copies source-relative paths, refusing to overwrite hand-written destinations.
# Emits the relative paths it refused.
function Copy-SourceFiles {
    param([string]$SourceRoot, [string]$TargetRoot, [string[]]$RelativePaths)

    $protected = [System.Collections.Generic.List[string]]::new()
    foreach ($rel in $RelativePaths) {
        $source = ConvertTo-NativePath $SourceRoot $rel
        $target = ConvertTo-NativePath $TargetRoot $rel

        if (Test-HandWritten -SourceFile $source -TargetFile $target) {
            $protected.Add($rel)
            continue
        }

        $targetDir = Split-Path -Parent $target
        if (-not (Test-Path -LiteralPath $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
        [IO.File]::WriteAllBytes($target, (Get-PortableBytes $source))
    }
    $protected
}

# Source-relative paths of every file under $SourceRoot/$Relative.
function Get-SourceFilesUnder {
    param([string]$SourceRoot, [string]$Relative)

    $dir = ConvertTo-NativePath $SourceRoot $Relative
    Get-ChildItem -LiteralPath $dir -Recurse -File -Force |
        ForEach-Object { Get-RelativeUnderRoot -Base $SourceRoot -Full $_.FullName }
}

# Deletes copies left behind by an earlier run with different settings. A file survives
# if this run wrote it or if it is hand-written.
function Remove-StaleCopies {
    param([string]$SourceRoot, [string]$TargetRoot, [string]$Root, [System.Collections.Generic.HashSet[string]]$Written)

    if (-not (Test-Path -LiteralPath $Root)) { return 0 }

    $removed = 0
    foreach ($file in (Get-ChildItem -LiteralPath $Root -Recurse -File -Force)) {
        $rel = Get-RelativeUnderRoot -Base $TargetRoot -Full $file.FullName
        if ($Written.Contains($rel)) { continue }
        if (Test-HandWritten -SourceFile (ConvertTo-NativePath $SourceRoot $rel) -TargetFile $file.FullName) { continue }
        Remove-Item -LiteralPath $file.FullName -Force
        $removed++
    }

    Get-ChildItem -LiteralPath $Root -Recurse -Directory -Force |
        Sort-Object { $_.FullName.Length } -Descending |
        Where-Object { -not (Get-ChildItem -LiteralPath $_.FullName -Force) } |
        Remove-Item -Force

    $removed
}

# VS Code layering markers for "knows what it runs on", plus test trees. Matched as
# wildcards so a layer we have not seen (electron-utility, and whatever comes next) is
# pruned too rather than slipping through a name list.
$script:PrunedDirNames = @('node', 'electron-*', 'test')

# $Keep holds full paths of files that sit under a pruned directory yet import nothing
# unportable, so the directory name lies about them. A kept file keeps its directory alive;
# everything beside it still goes.
function Remove-NonPortableDirectories {
    param([string]$Root, [string[]]$Keep = @())

    $kept = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($path in $Keep) { [void]$kept.Add([IO.Path]::GetFullPath($path)) }

    $removed = 0
    $candidates = @(Get-ChildItem -LiteralPath $Root -Recurse -Directory -Force |
        Where-Object { $name = $_.Name; $script:PrunedDirNames | Where-Object { $name -like $_ } } |
        Sort-Object { $_.FullName.Length } -Descending)

    foreach ($dir in $candidates) {
        if (-not (Test-Path -LiteralPath $dir.FullName)) { continue }

        $files = @(Get-ChildItem -LiteralPath $dir.FullName -Recurse -File -Force)
        $doomed = @($files | Where-Object { -not $kept.Contains($_.FullName) })

        if ($doomed.Count -eq $files.Count) {
            $removed += $files.Count
            Remove-Item -LiteralPath $dir.FullName -Recurse -Force
            continue
        }

        foreach ($file in $doomed) { Remove-Item -LiteralPath $file.FullName -Force }
        $removed += $doomed.Count
    }
    $removed
}
