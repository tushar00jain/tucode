# Upgrading upstream code

Use PowerShell from the repository root, starting with a clean working tree.
`vendor` stores pristine upstream files; merging it updates our patched copies.
The copy scripts alone skip edited files, so they are not a complete upgrade.

## VS Code

1. Check out the desired VS Code revision locally. Create an upgrade branch and a
   separate vendor worktree (reuse it if present; if needed, first create the local
   branch with `git branch vendor origin/vendor`).

```powershell
$upstream = (Resolve-Path "<vscode-checkout>").Path
$vendorTree = "../tscode-vendor"
git switch -c upgrade-vscode
git worktree add $vendorTree vendor
./scripts/copy-from-vscode.ps1 -VSCodeRoot $upstream
./scripts/copy-extensions.ps1 -VSCodeRoot $upstream
```

2. Populate the vendor worktree with the upstream originals of the selected files:

```powershell
. ./scripts/vscode-source.ps1
foreach ($pair in @(@('src/vs', 'src/vs'), @('resources/extensions', 'extensions'))) {
  $localTree = (Resolve-Path $pair[0]).Path
  Get-ChildItem $localTree -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($localTree.Length + 1)
    $source = Join-Path (Join-Path $upstream $pair[1]) $rel
    if (Test-Path -LiteralPath $source -PathType Leaf) {
      $dest = Join-Path (Join-Path $vendorTree $pair[0]) $rel
      New-Item -ItemType Directory -Force (Split-Path -Parent $dest) | Out-Null
      [IO.File]::WriteAllBytes($dest, (Get-PortableBytes -Path $source))
    }
  }
}
Copy-Item "$upstream/LICENSE.txt", "$upstream/ThirdPartyNotices.txt" .
```

3. Review both diffs. Remove obsolete VS Code files from the vendor worktree;
   preserve `.gitattributes`, Sapling, and Vim files. Keep our adapters off `vendor`.
   Commit the copy-script changes before merging; stage new files on both branches.

```powershell
git add -A
git commit -m "Prepare VS Code upgrade"
git -C $vendorTree add -A
git -C $vendorTree commit -m "vendor: vscode @ $(git -C $upstream rev-parse HEAD)"
git merge vendor
```

4. Resolve conflicts while preserving our feature cuts and adapters. Keep our
   `src/vs/nls.ts`. Review changes to upstream sources cited by `src/main.ts`,
   `tauri/` adapters, and Rust modules: those ports do not merge automatically.
5. Run `npm install`, `npm run typecheck`, `npm run test:unit`, `npm run test:rust`,
   and `npm run tauri:build`; run `npm run e2e` on Windows. Commit the reviewed result.
   The test scripts currently require Node 24; the transform-types flag is gone in Node 26.

## Sapling and Vim

- Sapling: run `./scripts/copy-from-sapling.ps1 -SaplingRoot <checkout>` on the upgrade
  branch. On `vendor`, replace `contrib/sapling/common/{render,renderText}.ts` under
  `src/vs/workbench/` with the originals from `addons/isl/src/dag/`, using
  `Get-PortableBytes`. Commit as `vendor: sapling @ <sha>` and merge as above;
  review the generated CSS/excerpts and our Sapling adapters, then run the checks.
- Copy Sapling source only from its MIT-licensed `addons/` tree; retain licenses and headers.
- Update the Vim engine and Monaco adapter together, recording both revisions on `vendor`.
  Preserve local import changes, especially the adapter's `monacoEditorApi.js` import.
