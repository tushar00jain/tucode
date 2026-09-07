/*---------------------------------------------------------------------------------------------
 *  A stylesheet as a module, which is what `import './media/x.css'` means in this tree.
 *
 *  Vite answered those imports in tscode and `bin/bundler-imports.mjs` answers them here — with a
 *  call to `tui/terminal/dom/style.ts`'s resolver, since G0. There is nothing to import *from* one, so the
 *  declaration is empty; what it exists for is `noUncheckedSideEffectImports`, which otherwise
 *  reports every one of the 266 vendored files that carries such an import.
 *--------------------------------------------------------------------------------------------*/

declare module '*.css';
