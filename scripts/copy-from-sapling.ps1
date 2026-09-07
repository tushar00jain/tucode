# Copies what the Sapling view renders against, out of a Sapling checkout: ISL's stylesheets,
# and the framework-free declarations of the `.tsx` files the view rebuilds against the DOM.
#
# The view draws Sapling's own smartlog, so it renders Sapling's own class names and wants
# Sapling's own rules behind them. Those rules are copied rather than re-typed for the same
# reason `render.ts` is: a copy merges on the next upgrade, and a hand-port drops whatever
# nobody thought to look at - which already happened once here, when `InlineBadge.css` was
# summarised into a rectangle and lost the `border-radius: 14px` and `font-size: 80%` that
# make it ISL's pill. The same happened to `RenderDag.tsx`'s geometry, which is why the
# excerpts below are copied now rather than read and re-typed.
#
# Each copy is wrapped in an `@scope` rule as it is written, exactly as
# `copy-from-vscode.ps1` wraps the markdown preview's stylesheet: ISL's are written for a
# document that holds nothing but ISL, and this port renders them into the document that
# holds the whole workbench, where a bare `.tag` would mean every tag in the application.
# Wrapping confines them without editing a line, and leaves the rules that belong to ISL's
# other chrome inert rather than needing a cut.
#
# What cannot be copied is hand-written in `sapling.css` beside them: ISL's spacing tokens,
# and the mapping from the webview-toolkit colour variables its rules read onto the
# workbench's own `--vscode-*` ones.
#
#   pwsh -File scripts/copy-from-sapling.ps1 [-SaplingRoot <path>] [-Destination <path>]

[CmdletBinding()]
param(
    [string]$SaplingRoot,
    [string]$Destination
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'vscode-source.ps1')

# Where the copies land, and the selector every one of them is confined to - the class the
# view pane puts on its own body.
$targetDir = 'src/vs/workbench/contrib/sapling/media'
$scope = '.sapling-smartlog'

# The stylesheets behind the classes the row renderer emits. Whole files, not excerpts: a
# rule nobody noticed is exactly what excerpting loses, and an unused one goes inert under
# the scope anyway.
$stylesheets = @(
    'addons/isl/src/RenderDag.css'            # the graph's rows, lines and tiles
    'addons/isl/src/CommitTreeList.css'       # the commit body: `.commit-rows`, `.commit-details`
    'addons/isl/src/InlineBadge.css'          # the pill `YouAreHereLabel` renders
    'addons/isl/src/UncommittedChanges.css'   # `.you-are-here-container`, and the changed-file list
    'addons/isl/src/CommitInfoView/CommitInfoView.css'  # the commit-info pane below the graph
    'addons/components/Tag.module.css'        # what `Bookmark.tsx` renders a bookmark as
    'addons/isl/src/Bookmark.module.css'      # and that tag's widening
)

# The declarations in ISL's `.tsx` files that owe nothing to React, copied into generated
# modules - one per upstream source.
#
# Those files cannot be copied whole: they are JSX, and their components are rewritten here
# as DOM builders. But what sits beside the components is plain TypeScript - `RenderDag.tsx`'s
# edge model and tile geometry, `responsive.tsx`'s layout threshold, `relativeDate.tsx`'s
# whole formatter - and that is exactly the kind of thing a re-typing loses a bit of. So each
# declaration is lifted verbatim by its own first and last line, with whatever comment block
# sits above it, and nothing between the anchors is touched.
#
# Excerpting is what the stylesheets above deliberately avoid. It is the only option here,
# so the anchors are declaration boundaries rather than line numbers, and a run throws if
# one of them stops matching - which is the upgrade telling us to look at what moved.
#
# `Preamble` is this script's, not upstream's: what an excerpt reaches for across a module
# boundary, resolved against the workbench. `Exports` is additive - nothing in an excerpt is
# edited to add an `export` keyword, so the copied text stays diffable against upstream line
# for line, and a declaration upstream already exports needs no entry.
$tsModules = @(
    @{
        Source   = 'addons/isl/src/RenderDag.tsx'
        Target   = 'src/vs/workbench/contrib/sapling/common/renderDag.ts'
        Note     = 'the declarations in it that owe nothing to React'
        Sibling  = '``saplingRowRenderer.ts`` is where the components around it are rebuilt against the DOM'
        # `LinkLine` is the one thing the excerpts reach for across a module boundary;
        # upstream's own import line cannot be reused because it also brings `NodeLine` and
        # `PadLine`, which nothing excerpted here mentions.
        Preamble = "import { LinkLine } from './render.js';"
        Excerpts = @(
            @{ First = 'export type Edge = {';           Last = 'const defaultStrokeWidth = 2;' }
            @{ First = 'const YOU_ARE_HERE_COLOR =';     Last = 'const DEFAULT_GLYPH_RADIUS = (defaultTileWidth * 7) / 20;' }
            @{ First = 'function linkLineToEdges(';      Last = '}' }
            @{ First = 'function authorToSvgPatternId('; Last = '}' }
        )
        Exports  = 'defaultTileWidth', 'defaultStrokeWidth', 'YOU_ARE_HERE_COLOR', 'DEFAULT_GLYPH_RADIUS', 'linkLineToEdges', 'authorToSvgPatternId'
    }
    @{
        Source   = 'addons/isl/src/responsive.tsx'
        Target   = 'src/vs/workbench/contrib/sapling/common/responsive.ts'
        Note     = 'the widths its layout switches on'
        Sibling  = '``saplingViewPane.ts`` compares them against the pane, where upstream compares a ``ResizeObserver`` on its main content area'
        Preamble = ''
        Excerpts = @(
            @{ First = 'export const NARROW_COMMIT_TREE_WIDTH = 800;'; Last = 'export const NARROW_COMMIT_TREE_WIDTH_WHEN_COMPACT = 300;' }
        )
        Exports  = @()
    }
    @{
        Source   = 'addons/isl/src/relativeDate.tsx'
        Target   = 'src/vs/workbench/contrib/sapling/common/relativeDate.ts'
        Note     = 'the formatter, without the React component that wraps it'
        Sibling  = 'a row''s ``.commit-date`` renders ``relativeDate(date, { useShortVariant: true })``, which is what ``CommitDate`` in ``Commit.tsx`` passes'
        # `getCurrentLanguage` is ISL's own i18n state; the workbench already has the
        # answer, so the shim is the whole of what that import would have brought.
        Preamble = @"
import { language } from '../../../../base/common/platform.js';

/** ``getCurrentLanguage`` in ``addons/isl/src/i18n.tsx``, over the workbench's own locale. */
function getCurrentLanguage(): string {
	return language;
}
"@
        Excerpts = @(
            # One span, from the time constants through the end of `relativeDate`: everything
            # between them - the four format tables and the `Intl` unit map - is what the
            # function selects from, so an excerpt per table would only be the same text in
            # more pieces.
            @{ First = 'const SECOND = 1000;';        Last = '}' }
            @{ First = 'function now(): number {';    Last = '}' }
        )
        Exports  = @()
    }
)

# The Sapling checkout to copy from. Same precedence as `Get-VSCodeRoot`'s:
#   1. -SaplingRoot argument
#   2. $env:TSCODE_SAPLING_ROOT
#   3. ../../sapling relative to this repo (sibling-checkout layout)
function Get-SaplingRoot {
    param([string]$SaplingRoot)

    if (-not $SaplingRoot) { $SaplingRoot = $env:TSCODE_SAPLING_ROOT }
    if (-not $SaplingRoot) { $SaplingRoot = [IO.Path]::Combine((Get-RepoRoot), '..', '..', 'sapling') }

    if (-not (Test-Path -LiteralPath $SaplingRoot)) {
        throw "Sapling checkout not found at '$SaplingRoot'. Pass -SaplingRoot <path> or set TSCODE_SAPLING_ROOT."
    }

    $resolved = (Resolve-Path -LiteralPath $SaplingRoot).ProviderPath
    if (-not (Test-Path -LiteralPath ([IO.Path]::Combine($resolved, 'addons', 'isl')))) {
        throw "'$resolved' does not look like a Sapling checkout (no addons/isl)."
    }
    $resolved
}

$saplingRoot = Get-SaplingRoot -SaplingRoot $SaplingRoot
if (-not $Destination) { $Destination = Get-RepoRoot }
$destination = (Resolve-Path -LiteralPath $Destination).ProviderPath

# The revision every copy below came from. `vendor` records it in the commit subject that
# carries `render.ts` and `renderText.ts` -- `vendor: sapling @ <sha>` -- and that is the only
# thing a later upgrade can diff against, so a run that cannot name it says so rather than
# leaving the reader to assume the checkout has not moved.
try {
    $saplingSha = & git -C $saplingRoot rev-parse --short HEAD 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $saplingSha) { $saplingSha = '<unknown - not a git checkout>' }
} catch {
    $saplingSha = '<unknown - git unavailable>'
}

Write-Host "Sapling checkout: $saplingRoot"
Write-Host "Sapling revision: $saplingSha"
Write-Host "Destination:      $destination"

$targetRoot = ConvertTo-NativePath $destination $targetDir
if (-not (Test-Path -LiteralPath $targetRoot)) { New-Item -ItemType Directory -Path $targetRoot -Force | Out-Null }

# Every copy is rewritten on every run. The wrapper makes the destination differ from the
# source by construction, so the hand-written check the VS Code script relies on cannot tell
# a copy from an edit here - which is why nothing about these files is ever edited in place.
$written = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($relative in $stylesheets) {
    $source = ConvertTo-NativePath $saplingRoot $relative
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "Missing from the Sapling checkout: $relative"
    }

    # `.module.` is dropped from the destination name. Upstream's bundler reads that infix as
    # "CSS module" and rewrites every class name in the file to a hashed one; ours reads it
    # the same way, and the class names in these two files are exactly what the row renderer
    # emits. The upstream path each copy came from is the list above.
    $name = (Split-Path -Leaf $relative) -replace '\.module\.css$', '.css'
    $target = Join-Path $targetRoot $name
    $text = [Text.Encoding]::UTF8.GetString((Get-PortableBytes $source))
    [IO.File]::WriteAllBytes($target, [Text.Encoding]::UTF8.GetBytes("@scope ($scope) {`n$text}`n"))

    [void]$written.Add($name)
    Write-Host "  $relative"
}

# A stylesheet dropped from the list above leaves a copy behind that nothing imports and
# nothing refreshes, so the run takes it back.
$stale = 0
foreach ($file in (Get-ChildItem -LiteralPath $targetRoot -File -Force)) {
    if ($written.Contains($file.Name)) { continue }
    Remove-Item -LiteralPath $file.FullName -Force
    $stale++
}

Write-Host "Copied $($written.Count) stylesheet(s); removed $stale stale."

# Everything this script copies lives under `addons/`, which carries its own MIT licence -
# not the GPL-2.0 one at the Sapling repository root. Attribution is a condition of that
# licence, so the file travels with the copies and is re-copied whenever they are, exactly
# as `copy-from-vscode.ps1` re-copies VS Code's. Byte-for-byte: a licence is not source text
# to normalize.
$licenseSource = Join-Path $saplingRoot 'addons/LICENSE'
if (-not (Test-Path -LiteralPath $licenseSource)) {
    throw "Sapling's addons licence is missing at '$licenseSource'. The copies below may not be MIT-licensed - stop and check before shipping them."
}
[IO.File]::WriteAllBytes(
    (ConvertTo-NativePath $destination 'LICENSE-sapling.txt'),
    [IO.File]::ReadAllBytes($licenseSource))
Write-Host "Copied addons/LICENSE -> LICENSE-sapling.txt"

# Lifts one declaration out of a source file: the line that opens it, the line that closes
# it, and the comment block sitting immediately above it - which is where upstream explains
# what the declaration means, and is exactly what a re-typing tends to leave behind.
function Get-Excerpt {
    param([string[]]$Lines, [string]$First, [string]$Last, [string]$Relative)

    $start = -1
    for ($i = 0; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i].StartsWith($First)) { $start = $i; break }
    }
    if ($start -lt 0) { throw "'$First' is no longer in $Relative. The excerpt list needs re-anchoring." }

    $end = -1
    for ($i = $start; $i -lt $Lines.Count; $i++) {
        if ($Lines[$i] -eq $Last) { $end = $i; break }
    }
    if ($end -lt 0) { throw "'$Last' does not close '$First' in $Relative. The excerpt list needs re-anchoring." }

    $top = $start
    while ($top -gt 0) {
        $above = $Lines[$top - 1].TrimStart()
        if ($above.StartsWith('/*') -or $above.StartsWith('*') -or $above.StartsWith('//')) { $top-- } else { break }
    }

    , ($Lines[$top..$end])
}

foreach ($module in $tsModules) {
    $tsSourcePath = ConvertTo-NativePath $saplingRoot $module.Source
    if (-not (Test-Path -LiteralPath $tsSourcePath -PathType Leaf)) {
        throw "Missing from the Sapling checkout: $($module.Source)"
    }
    $tsLines = [Text.Encoding]::UTF8.GetString((Get-PortableBytes $tsSourcePath)) -split "`r?`n"

    $header = @"
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Copied from ``$($module.Source)`` by ``scripts/copy-from-sapling.ps1`` - $($module.Note). Do
// not edit: a run rewrites this file. Everything below the preamble is upstream's text,
// unchanged; $($module.Sibling).

$($module.Preamble)

"@

    $body = foreach ($excerpt in $module.Excerpts) {
        (Get-Excerpt -Lines $tsLines -First $excerpt.First -Last $excerpt.Last -Relative $module.Source) -join "`n"
        ''
    }

    $footer = if ($module.Exports.Count -gt 0) { "`nexport { $($module.Exports -join ', ') };`n" } else { "" }

    $tsTargetPath = ConvertTo-NativePath $destination $module.Target
    [IO.File]::WriteAllBytes($tsTargetPath, [Text.Encoding]::UTF8.GetBytes(($header + ($body -join "`n") + $footer)))
    Write-Host "  $($module.Source) -> $($module.Target) ($($module.Excerpts.Count) excerpts)"
}
