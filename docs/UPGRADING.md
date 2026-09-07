# Upgrading tscode

Tucode's `vendor` branch stores complete, unmodified tscode snapshots. Update VS Code,
Sapling, and Vim in tscode first, then import that committed tree here. The inherited
copy scripts do not replace this step: they skip files that tucode has edited.

Start with a clean working tree. Fetch the published branches and inspect any local
`vendor` commits before choosing the previous snapshot as the parent. The example
below assumes `origin/vendor` is the latest snapshot; `tscode_checkout` can point to
any existing tscode checkout. Fetching its Git objects does not copy source files
into a temporary worktree.

```sh
git fetch origin
tscode_checkout=../tscode
tscode_revision=$(git -C "$tscode_checkout" rev-parse HEAD)
git fetch --no-tags "$tscode_checkout" "$tscode_revision"
vendor_commit=$(git commit-tree "$tscode_revision^{tree}" -p origin/vendor \
  -m "vendor: tscode @ $tscode_revision")
# Create vendor if absent; otherwise advance it without discarding local commits.
if git show-ref --verify --quiet refs/heads/vendor; then
  git merge-base --is-ancestor vendor "$vendor_commit" && \
    git update-ref refs/heads/vendor "$vendor_commit" "$(git rev-parse vendor)"
else
  git branch vendor "$vendor_commit"
fi
git diff --exit-code "$tscode_revision^{tree}" 'vendor^{tree}'
git merge --no-commit --no-ff vendor
```

Resolve conflicts while preserving tucode's terminal and Mac entry points, adapters,
package commands, and tests. Review changes to upstream modules used by local ports;
those adaptations do not update automatically. Keep Quick Input's shared controller
and its TUI paint-invalidation and list-viewport hooks.

The documentation generators are shared with tscode. Regenerate tucode's three HTML
pages against the new local snapshot; do not retain tscode's `docs/keyboard/keys.html`:

```sh
npm run provenance -- --rev vendor --keys
```

Run both typechecks and relevant unit, host, and terminal tests. For Rust or Mac
changes, also use `npm run test:rust`, `mac/package.sh`, and the relevant foreground
workflows described in [Mac development](../mac/README.md). Install dependencies when
the manifests change. Commit the resolved merge with the normal repository hooks.

Push both `vendor` and the branch containing the merge when publishing the upgrade.
The generators default to `origin/vendor`; `--rev vendor` measures the local snapshot
before it is pushed. `--upstream <checkout>` instead measures an existing working tree.
