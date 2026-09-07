<#
.SYNOPSIS
Copies the VS Code sources tscode needs into src/vs.

.DESCRIPTION
Walks the transitive import closure of the entry points below, resolving VS Code's
".js" ESM specifiers back to the ".ts" files on disk. vs/base and vs/editor come
along wholesale on top of the walk - all of both is wanted.

Prints counts only - never file contents.

.PARAMETER VSCodeRoot
The VS Code checkout. Defaults to $env:TSCODE_VSCODE_ROOT, then ../../vscode.

.PARAMETER Destination
Where src/vs is written. Defaults to <repo-root>/src.
#>
[CmdletBinding()]
param(
    [string]$VSCodeRoot,
    [string]$Destination
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. ([IO.Path]::Combine($PSScriptRoot, 'vscode-source.ps1'))

$vscodeRoot = Get-VSCodeRoot $VSCodeRoot
$srcRoot = [IO.Path]::Combine($vscodeRoot, 'src')
if (-not $Destination) { $Destination = [IO.Path]::Combine((Get-RepoRoot), 'src') }

# The real closure root: our own boot file, which lives in the destination tree and is never
# copied. Its ./vs/... specifiers point into the copied tree, and because both trees are
# rooted at src/ they resolve against the VS Code checkout unchanged.
$localEntryPoints = @(
    'main.ts'

    # Ours, and reached from main.ts - but the walk stops at a file that resolves in the
    # destination tree, so what it imports from upstream needs it named as a root of its own.
    # The markdown preview is the only upstream reader of contrib/markdown's colours and
    # stylesheet, which nothing else in the closure reaches.
    'vs/workbench/contrib/markdown/tauri/markdownPreview.contribution.ts'
)

# Upstream roots, kept so the walk still covers what main.ts reaches only lazily.
$entryPoints = @(
    'vs/workbench/browser/workbench.ts'
    'vs/workbench/contrib/files/browser/files.contribution.ts'
    'vs/workbench/contrib/search/browser/search.contribution.ts'
    'vs/workbench/contrib/scm/browser/scm.contribution.ts'
    'vs/workbench/services/textMate/browser/textMateTokenizationFeature.contribution.ts'
    'vs/platform/extensionManagement/common/extensionsScannerService.ts'
    'vs/editor/editor.all.ts'

    # BaseConfigurationResolverService, which configurationResolver/tauri/
    # configurationResolverService.ts extends. Upstream's importers are the browser and
    # electron-browser subclasses this port replaces, so the walk never reaches it on its own.
    'vs/workbench/services/configurationResolver/browser/baseConfigurationResolverService.ts'

    # The terminal, entered where terminal.all.ts enters it. The contributions are listed
    # one by one rather than through terminal.all.ts because three of them - chat,
    # chatAgentTools and voice - are cut, and an entry point cannot be cut.
    'vs/workbench/contrib/terminal/browser/terminal.contribution.ts'
    'vs/workbench/contrib/terminal/browser/terminalView.ts'
    # BaseTerminalProfileResolverService, which tauri/terminalProfileResolverService.ts
    # extends. Upstream's only importer is the electron-browser subclass this port replaces,
    # so the walk never reaches it on its own.
    'vs/workbench/contrib/terminal/browser/terminalProfileResolverService.ts'
    'vs/workbench/contrib/terminal/common/environmentVariable.contribution.ts'
    'vs/workbench/contrib/terminal/common/terminalExtensionPoints.contribution.ts'
    'vs/workbench/contrib/terminalContrib/accessibility/browser/terminal.accessibility.contribution.ts'
    'vs/workbench/contrib/terminalContrib/autoReplies/browser/terminal.autoReplies.contribution.ts'
    'vs/workbench/contrib/terminalContrib/developer/browser/terminal.developer.contribution.ts'
    'vs/workbench/contrib/terminalContrib/environmentChanges/browser/terminal.environmentChanges.contribution.ts'
    'vs/workbench/contrib/terminalContrib/find/browser/terminal.find.contribution.ts'
    'vs/workbench/contrib/terminalContrib/commandGuide/browser/terminal.commandGuide.contribution.ts'
    'vs/workbench/contrib/terminalContrib/history/browser/terminal.history.contribution.ts'
    'vs/workbench/contrib/terminalContrib/inlineHint/browser/terminal.initialHint.contribution.ts'
    'vs/workbench/contrib/terminalContrib/links/browser/terminal.links.contribution.ts'
    'vs/workbench/contrib/terminalContrib/notification/browser/terminal.notification.contribution.ts'
    'vs/workbench/contrib/terminalContrib/zoom/browser/terminal.zoom.contribution.ts'
    'vs/workbench/contrib/terminalContrib/stickyScroll/browser/terminal.stickyScroll.contribution.ts'
    'vs/workbench/contrib/terminalContrib/quickAccess/browser/terminal.quickAccess.contribution.ts'
    'vs/workbench/contrib/terminalContrib/quickFix/browser/terminal.quickFix.contribution.ts'
    'vs/workbench/contrib/terminalContrib/typeAhead/browser/terminal.typeAhead.contribution.ts'
    'vs/workbench/contrib/terminalContrib/resizeDimensionsOverlay/browser/terminal.resizeDimensionsOverlay.contribution.ts'
    'vs/workbench/contrib/terminalContrib/sendSequence/browser/terminal.sendSequence.contribution.ts'
    'vs/workbench/contrib/terminalContrib/sendSignal/browser/terminal.sendSignal.contribution.ts'
    'vs/workbench/contrib/terminalContrib/suggest/browser/terminal.suggest.contribution.ts'
    'vs/workbench/contrib/terminalContrib/telemetry/browser/terminal.telemetry.contribution.ts'
    'vs/workbench/contrib/terminalContrib/wslRecommendation/browser/terminal.wslRecommendation.contribution.ts'
)

# Files the walk cannot reach because they sit outside src/, copied by name and mirrored
# under the destination the way src/vs mirrors <vscode>/src/vs.
#
# `Scope` wraps the copy in an `@scope` rule rather than editing it. The stylesheet is written
# for the preview's own webview document, where the whole body is the rendered document and a
# bare `table` selector can only mean the preview's tables. This port renders into the
# workbench document, where the same selector would mean every table in the application, so
# the copy has to be confined - and confining it from the outside is what keeps it a copy.
# The rules written against the webview's own chrome (its CSP warning, its scroll-sync
# `code-line` classes, its scroll-to-top button) go inert on their own that way, with nothing
# to cut and nothing to re-cut on the next upgrade.
$outsideSrcFiles = @(
    @{
        Path  = 'extensions/markdown-language-features/media/markdown.css'
        Scope = '.markdown-preview .markdown-preview-content'
    }
)

# node/, test/ and electron-*/ are pruned wholesale after the copy, because those names are
# VS Code's marker for "knows what it runs on". These three are the exceptions: each imports
# nothing but common/, so it is portable and the directory name is the only thing wrong with
# it. They are walked like entry points because nothing we copy imports them - the pty host
# that did is one of the processes this port does not have - and exempted from the prune
# below so the sweep does not take back what the walk just copied.
$portableUnderPrunedDirs = @(
    'vs/workbench/contrib/terminal/electron-browser/localPty.ts'
    'vs/platform/terminal/node/terminalContrib/autoReplies/terminalAutoResponder.ts'
    'vs/platform/terminal/node/terminalContrib/autoReplies/autoRepliesContribController.ts'
)

# The monaco-editor npm package bundles its own copies of vs/base and vs/platform, which
# would give us two Emitters, two URIs and two createDecorator registries. So the editor
# is vendored from source like everything else, and nothing is excluded from the walk.
$excludedPrefixes = @()

$importPatterns = @(
    "(?m)^\s*(?:import|export)\s[^;]*?\sfrom\s*['`"]([^'`"]+)['`"]"  # import/export ... from '...'
    "(?m)^\s*import\s*['`"]([^'`"]+)['`"]"                            # side-effect import '...'
    "import\s*\(\s*['`"]([^'`"]+)['`"]\s*\)"                          # dynamic import('...')
)

# Specifiers that are data, not modules: copy them, do not parse them.
$assetExtensions = @('.css', '.json', '.wasm', '.svg', '.png', '.ttf', '.woff', '.woff2')

# Directories of assets that sit beside code the closure reaches, and that nothing imports:
# media/ holds the images the co-located CSS points at, scripts/ the shell-integration
# scripts the terminal hands to the shell by path rather than by specifier.
$assetDirNames = @('media', 'scripts')

$modules = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$assets = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$unresolved = [System.Collections.Generic.List[string]]::new()
$outsideVs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$queue = [System.Collections.Generic.Queue[string]]::new()

function Add-Module([string]$rel) {
    if ($modules.Add($rel)) { $queue.Enqueue($rel) }
}

# Turns an import specifier into a path relative to src/, or $null when it is a bare
# npm specifier or escapes the sources root.
function Resolve-Specifier([string]$fromRel, [string]$spec) {
    if (-not $spec.StartsWith('.')) { return $null }
    $fromDir = [IO.Path]::GetDirectoryName([IO.Path]::Combine($srcRoot, ($fromRel -replace '/', '\')))
    Get-RelativeUnderRoot -Base $srcRoot -Full ([IO.Path]::Combine($fromDir, $spec))
}

# VS Code emits ESM, so its specifiers say ".js" where the source file says ".ts".
function Find-FileIn([string]$root, [string]$rel) {
    foreach ($candidate in @(($rel -replace '\.js$', '.ts'), ($rel -replace '\.js$', '.d.ts'), $rel, "$rel.ts")) {
        if (Test-Path -LiteralPath (ConvertTo-NativePath $root $candidate) -PathType Leaf) {
            return $candidate
        }
    }
    $null
}

function Get-ImportSpecifiers([string]$content) {
    # JSDoc writes {@link import('...')}, which is documentation, not a dependency.
    $code = [regex]::Replace($content, '/\*[\s\S]*?\*/', '')
    $code = [regex]::Replace($code, '(?m)//.*$', '')

    $specs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($pattern in $importPatterns) {
        foreach ($m in [regex]::Matches($code, $pattern)) { [void]$specs.Add($m.Groups[1].Value) }
    }
    $specs
}

function Add-Dependencies([string]$fromRel, [string[]]$specs) {
    foreach ($spec in $specs) {
        $target = Resolve-Specifier $fromRel $spec
        if (-not $target) { continue }

        $isVs = $target.StartsWith('vs/', [StringComparison]::OrdinalIgnoreCase)
        if ($isVs -and ($excludedPrefixes | Where-Object { $target.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })) {
            continue
        }

        if ($isVs) {
            $resolvedFile = Find-FileIn $srcRoot $target
            if ($resolvedFile) {
                if ($assetExtensions -contains [IO.Path]::GetExtension($resolvedFile)) {
                    [void]$assets.Add($resolvedFile)
                } else {
                    Add-Module $resolvedFile
                }
                continue
            }
        }

        # Not upstream's. Ours if it is already in the destination tree - the Tauri
        # transports and styles.css have no counterpart in the VS Code checkout.
        if (Find-FileIn $Destination $target) { continue }

        if ($isVs) { $unresolved.Add("$fromRel -> $spec") } else { [void]$outsideVs.Add($target) }
    }
}

$walkRoots = @($entryPoints) + @($portableUnderPrunedDirs)

foreach ($entry in $walkRoots) {
    if (-not (Test-Path -LiteralPath (ConvertTo-NativePath $srcRoot $entry))) {
        throw "Entry point missing from the VS Code checkout: $entry"
    }
    Add-Module $entry
}

foreach ($entry in $localEntryPoints) {
    $path = ConvertTo-NativePath $Destination $entry
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        Write-Host "Local entry point not written yet, skipping: $entry"
        continue
    }
    Add-Dependencies $entry @(Get-ImportSpecifiers (Get-Content -LiteralPath $path -Raw))
}

Write-Host "Walking the import closure from $($walkRoots.Count + $localEntryPoints.Count) entry points..."

while ($queue.Count -gt 0) {
    $rel = $queue.Dequeue()
    $content = Get-Content -LiteralPath (ConvertTo-NativePath $srcRoot $rel) -Raw -ErrorAction SilentlyContinue
    if (-not $content) { continue }
    Add-Dependencies $rel @(Get-ImportSpecifiers $content)
}

Write-Host "  closure: $($modules.Count) modules, $($assets.Count) imported assets"

# --- copy -------------------------------------------------------------------

$vsDestination = [IO.Path]::Combine($Destination, 'vs')
$written = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$protected = @()

function Copy-Batch([string[]]$RelativePaths) {
    foreach ($rel in $RelativePaths) { [void]$written.Add($rel) }
    @(Copy-SourceFiles -SourceRoot $srcRoot -TargetRoot $Destination -RelativePaths $RelativePaths)
}

$protected += Copy-Batch (@($modules) + @($assets))

# These layers are copied whole rather than filtered by the closure. A walk pulls service
# interfaces but not their implementations - stock instantiates those at its electron
# entry points, which we prune - so vs/platform would arrive as IFileService without
# FileService. common/ and browser/ are portable by construction, so all of them can come.
$wholesaleDirs = @('base', 'editor', 'platform', 'workbench/services')
foreach ($name in $wholesaleDirs) {
    Write-Host "Copying all of vs/$name..."
    $protected += Copy-Batch @(Get-SourceFilesUnder -SourceRoot $srcRoot -Relative "vs/$name")
}

# Co-located CSS and asset directories under every directory the closure touched. VS Code's
# own build plugin resolves these; Vite needs the files to actually be there.
Write-Host "Copying co-located CSS and asset directories..."
$touchedDirs = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($rel in $modules) {
    $dir = ($rel -replace '/[^/]+$', '')
    $isWholesale = $wholesaleDirs | Where-Object { $dir.StartsWith("vs/$_", [StringComparison]::OrdinalIgnoreCase) }
    if (-not $isWholesale) { [void]$touchedDirs.Add($dir) }
}

$extraFiles = 0
foreach ($dir in $touchedDirs) {
    $sourceDir = ConvertTo-NativePath $srcRoot $dir
    $extras = @(Get-ChildItem -LiteralPath $sourceDir -Filter '*.css' -File -ErrorAction SilentlyContinue |
        ForEach-Object { "$dir/$($_.Name)" })

    foreach ($assetDir in $assetDirNames) {
        if (Test-Path -LiteralPath ([IO.Path]::Combine($sourceDir, $assetDir)) -PathType Container) {
            $extras += @(Get-SourceFilesUnder -SourceRoot $srcRoot -Relative "$dir/$assetDir")
        }
    }

    $extraFiles += $extras.Count
    $protected += Copy-Batch $extras
}

# Ambient declarations are reached by inclusion, not by import, so the closure walk cannot
# see them: `DebugProtocol`, the `monaco` global, `Timeout`, `Thenable`, `EditContext` and
# the product/nls/ttp globals all come from files nothing imports.
Write-Host "Copying ambient declarations..."
$ambientFiles = @(Get-SourceFilesUnder -SourceRoot $srcRoot -Relative 'vs' |
    Where-Object { $_.EndsWith('.d.ts', [StringComparison]::OrdinalIgnoreCase) })
$protected += Copy-Batch $ambientFiles

# src/typings holds the same kind of declaration one level up, outside vs/. Upstream's
# copilot-api.d.ts is left behind: it declares a chat dependency this port does not have.
$typings = @(Get-ChildItem -LiteralPath ([IO.Path]::Combine($srcRoot, 'typings')) -Filter '*.d.ts' -File |
    Where-Object { $_.Name -ne 'copilot-api.d.ts' } |
    ForEach-Object { "typings/$($_.Name)" })
$protected += @(Copy-SourceFiles -SourceRoot $srcRoot -TargetRoot $Destination -RelativePaths $typings)
Write-Host "  typings: $($typings.Count) declaration files"

# The outside-src/ files. Written here rather than through Copy-SourceFiles because the scope
# wrapper makes the destination differ from the source by construction, which is exactly what
# that function reads as "hand-written, do not touch". This run always rewrites them; nothing
# about them is ever edited in place. They live outside vs/, so neither the prune nor the
# stale sweep below reaches them.
Write-Host "Copying files from outside src/..."
foreach ($entry in $outsideSrcFiles) {
    $source = ConvertTo-NativePath $vscodeRoot $entry.Path
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Missing from the VS Code checkout: $($entry.Path)"
    }
    $target = ConvertTo-NativePath $Destination $entry.Path
    $targetDir = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }

    $text = [Text.Encoding]::UTF8.GetString((Get-PortableBytes $source))
    $wrapped = if ($entry.Scope) { "@scope ($($entry.Scope)) {`n$text}`n" } else { $text }
    [IO.File]::WriteAllBytes($target, [Text.Encoding]::UTF8.GetBytes($wrapped))
    Write-Host "  $($entry.Path)"
}

$keptFromPrune = @($portableUnderPrunedDirs | ForEach-Object { ConvertTo-NativePath $Destination $_ })
$prunedFiles = Remove-NonPortableDirectories -Root $vsDestination -Keep $keptFromPrune
$staleFiles = Remove-StaleCopies -SourceRoot $srcRoot -TargetRoot $Destination -Root $vsDestination -Written $written

# --- report -----------------------------------------------------------------

$copied = Get-ChildItem -LiteralPath $vsDestination -Recurse -File
$byLayer = @{}
foreach ($file in $copied) {
    $rel = Get-RelativeUnderRoot -Base $Destination -Full $file.FullName
    $layer = switch -Regex ($rel) {
        '/tauri/'             { 'hand-written tauri/'; break }
        '^vs/base/parts/ipc/' { 'vs/base/parts/ipc'; break }
        '^vs/base/'           { 'vs/base'; break }
        '^vs/editor/'         { 'vs/editor'; break }
        '^vs/platform/'       { 'vs/platform'; break }
        '^vs/workbench/'      { 'vs/workbench'; break }
        default               { 'vs (other)' }
    }
    if (-not $byLayer.ContainsKey($layer)) { $byLayer[$layer] = 0 }
    $byLayer[$layer]++
}

Write-Host ''
Write-Host 'Files copied per layer:'
foreach ($layer in ($byLayer.Keys | Sort-Object)) {
    Write-Host ("  {0,-22} {1,5}" -f $layer, $byLayer[$layer])
}
Write-Host ("  {0,-22} {1,5}" -f 'TOTAL', $copied.Count)
Write-Host ''
Write-Host "Co-located CSS and asset-directory files added: $extraFiles"
Write-Host "Files removed by pruning node/electron-*/test: $prunedFiles"
Write-Host "Stale copies swept: $staleFiles"
Write-Host "Hand-written files left untouched: $($protected.Count)"
foreach ($item in ($protected | Sort-Object -Unique)) { Write-Host "  $item" }
Write-Host "Imports resolving outside src/vs: $($outsideVs.Count)"
foreach ($item in ($outsideVs | Sort-Object)) { Write-Host "  $item" }
Write-Host "Unresolved specifiers: $($unresolved.Count)"
foreach ($item in ($unresolved | Sort-Object -Unique)) { Write-Host "  $item" }
