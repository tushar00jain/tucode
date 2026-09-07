import { readFileSync } from 'node:fs';
import process from 'node:process';
import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const debug = !!process.env.TAURI_ENV_DEBUG;

// Decoding as UTF-8 leaves a byte-order mark in the string as a leading U+FEFF, and both
// readers below choke on one: `JSON.parse` rejects it outright, and `product.json` reaches
// the bundle verbatim, where it is a syntax error with nothing pointing at its origin.
function readConfigJson(file: string): string {
	return readFileSync(new URL(file, import.meta.url), 'utf8').replace(/^\uFEFF/, '');
}

// `vs/platform/product/common/product.ts` reads the product configuration off these two
// globals; upstream's build injects them from the repo-root product.json and package.json.
// Both files are valid JS object literals, so they go in as `define` replacements verbatim.
const productJson = readConfigJson('./product.json');
const packageJson = JSON.parse(readConfigJson('./package.json')) as { version: string };

export default defineConfig({
	base: './',
	// Tauri drives the dev server, so its output must survive and its port must be fixed.
	clearScreen: false,
	envPrefix: ['VITE_', 'TAURI_ENV_*'],
	server: {
		port: 1420,
		strictPort: true,
		watch: { ignored: ['**/src-tauri/**'] }
	},
	define: {
		'globalThis._VSCODE_PRODUCT_JSON': productJson,
		'globalThis._VSCODE_PACKAGE_JSON': JSON.stringify({ version: process.env.TUCODE_RELEASE_VERSION || packageJson.version })
	},
	resolve: {
		alias: [
			// One IChannel adapter; the Mac bundle replaces only Node's transport.
			{ find: /\.\.\/node\/ipc\.host\.js$/, replacement: fileURLToPath(new URL(
				'./src/vs/base/parts/ipc/wry/ipc.wry.ts', import.meta.url)) },
			// vs/base/browser/ui/codicons/codicon/codicon.css asks for ./codicon.ttf, which
			// upstream drops next to it from @vscode/codicons during its own build.
			{ find: /^\.\/codicon\.ttf$/, replacement: '@vscode/codicons/dist/codicon.ttf' }
		]
	},
	// vscode-oniguruma loads its regex engine from onig.wasm at runtime.
	assetsInclude: ['**/*.wasm'],
	optimizeDeps: {
		// UMD builds, which the dev server has to pre-bundle to ESM.
		include: [
			'vscode-textmate',
			'vscode-oniguruma',
			'@vscode/iconv-lite-umd',
			'jschardet'
		]
	},
	worker: {
		format: 'es'
	},
	build: {
		target: 'es2022',
		outDir: 'dist-mac',
		// Debug symbols, in JS. Off unless Tauri says this is a debug build.
		minify: debug ? false : 'esbuild',
		sourcemap: debug,
		// The editor service graph is intentionally emitted as one application chunk.
		chunkSizeWarningLimit: 10_000
	}
});
