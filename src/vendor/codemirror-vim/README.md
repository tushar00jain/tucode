# `@replit/codemirror-vim-core`, vendored

The vim engine, copied unmodified. **Nothing in this directory is ours and nothing in it is
VS Code's** — it is a third thing in the tree, which is why it is not under `src/vs/`.

| | |
| --- | --- |
| origin | `https://github.com/replit/codemirror-vim`, `packages/codemirror-vim-core` |
| revision | `8640966b6977f84d2197e6adfd521fb737184587`, 2026-07-28 |
| package | `@replit/codemirror-vim-core@0.1.0` — *"editor-agnostic vim engine shared by @replit/codemirror-vim (CodeMirror 6) and cm5-vim (CodeMirror 5)"* |
| licence | MIT, `LICENSE` beside this file, copied with it |

| file | lines | |
| --- | --- | --- |
| `vim.js` | 7,163 | the engine. **Zero imports** — dependency-free, so vendoring it adds no runtime dependency |
| `types.ts` | 587 | the adapter contract. `CM5EditorInterface` is what an adapter implements, and `CodeMirrorConstructor` is what `initVim` is handed |

**Both files are the origin's bytes save two deletions**, each sanctioned by
`docs/UPGRADING.md`: `vim.js`'s `//@ts-check` and `types.ts`'s `declare global`. Nothing else in
either file is ours, which is what keeps 7,750 lines out of the diff at the next re-point.

## The seam

```
const Vim = initVim(TauriVimAdapter)   // a class with statics; returns the engine bound to it
Vim.enterVimMode(adapter)
Vim.handleKey(adapter, '<Esc>', 'user')
```

Nothing else crosses. **The engine installs no keymap** — it never assigns `CM.keyMap.vim`, and
`cm.setOption('keyMap', …)` only records state. Key dispatch is the host's, through `handleKey`;
`vs/workbench/contrib/vim/tauri/` is where that lives.

## Do not edit these files

A local fix here stops merging from the origin. If the engine needs to behave differently, the
adapter is where that belongs — and the adapter subclass in `contrib/vim/tauri/` exists so that
even a fix to *monaco-vim's* adapter does not have to be written into a vendored file.

`vendor` holds these bytes pristine; `git diff vendor..main -- src/vendor` is the check, and it
must show the adapter's two rewritten import lines and the two deletions above — 2 insertions and
9 deletions, exactly as `docs/UPGRADING.md` enumerates them — and nothing else.

## `vim.js` is compiled rather than copied

The build's `allowJs` puts it through TypeScript, because `types.ts`'s whole contract is stated
as `ReturnType<typeof initVim>`: a hand-written `.d.ts` here would have to answer `any` for the
engine's entire API, and the seam would lose its types at the one place they are worth having.
The origin carries `//@ts-check` on its first line and **this tree deletes it** — one of the two
sanctioned deletions above. `allowJs` without `checkJs` compiles the engine without checking it;
`//@ts-check` would have opted this one file back in, against a `strict` config it was never
written for.
