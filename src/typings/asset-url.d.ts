/*---------------------------------------------------------------------------------------------
 *  An asset's URL as a module, which is what `import x from './y?url'` means in this tree.
 *
 *  Vite declared these in `vite/client` and answered them in tscode; `bin/bundler-imports.mjs`
 *  answers them here, with the asset's own `file:` URL as the default export. The two queries are
 *  the two that file resolves — `?url` for `onig.wasm`, `?worker&url` for a worker main — and the
 *  declarations are Vite's own, so what the compiler sees and what the hook returns are the same
 *  string.
 *
 *  Upstream counterpart: none — the declarations came from `vite/client`, a package rather than a file of tscode's; `bin/bundler-imports.mjs` is the runtime half and stands in for `vite.config.ts`.
 *--------------------------------------------------------------------------------------------*/

declare module '*?url' {
	const url: string;
	export default url;
}

declare module '*?worker&url' {
	const url: string;
	export default url;
}
