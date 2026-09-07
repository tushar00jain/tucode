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
const Vim = initVim(TerminalCodeMirror)   // a class with statics; returns the engine bound to it
Vim.enterVimMode(adapter)
Vim.handleKey(adapter, '<Esc>', 'user')
```

Nothing else crosses. **The engine installs no keymap** — it never assigns `CM.keyMap.vim`, and
`cm.setOption('keyMap', …)` only records state. Key dispatch is the host's, through `handleKey`;
`src/tui/editor/` is where that lives — `vimMode.ts` calls `initVim` once at module load, and
`vimAdapter.ts` is the `CM5EditorInterface` over `TextView`.

## Do not edit these files

A local fix here stops merging from the origin. If the engine needs to behave differently,
`src/tui/editor/vimAdapter.ts` is where that belongs — the adapter is ours, so a behaviour change
never has to be written into a vendored file.

`vendor` holds these bytes pristine, and the check is scoped to the two engine files rather than to
the directory: **`git diff vendor -- src/vendor/codemirror-vim/vim.js src/vendor/codemirror-vim/types.ts`
must be empty.** This `README.md` is not in it — it is prose about the copy rather than part of one,
and it carries the edits below.

**This file diverges from tscode's copy, deliberately.** tscode vendors a second tree beside this
one, `monaco-vim/`, whose `cm_adapter.ts` binds the same engine to a Monaco `ICodeEditor`; this fork
deleted it along with the GUI vim it was the adapter for, so the seam described above is
`src/tui/editor/`'s rather than `contrib/vim/tauri/`'s. The 2-insertions/9-deletions audit
`docs/UPGRADING.md` enumerates counts that deleted adapter's two rewritten import lines, and is
tscode's rule about its own upstreams, not this fork's.

## `vim.js` is compiled rather than copied

The build's `allowJs` puts it through TypeScript, because `types.ts`'s whole contract is stated
as `ReturnType<typeof initVim>`: a hand-written `.d.ts` here would have to answer `any` for the
engine's entire API, and the seam would lose its types at the one place they are worth having.
The origin carries `//@ts-check` on its first line and **this tree deletes it** — one of the two
sanctioned deletions above. `allowJs` without `checkJs` compiles the engine without checking it;
`//@ts-check` would have opted this one file back in, against a `strict` config it was never
written for.
