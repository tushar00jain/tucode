// Frontend-supplied key tables used by the source registration scanner.
const INJECTED_KEYS = {
	'src/main.ts': [{ prefix: 'workbench.keys', file: 'src/tui/workbench/workbench.ts', name: 'TERMINAL_KEYS' }],
};

/**
 * The injected tables a set of boot roots supplies, in the form the scanner substitutes them by.
 * Derived from the roots a caller already has, so measuring a surface never means naming it twice —
 * and a tree where the named table does not exist, which is what tscode is, simply resolves nothing
 * and the expression stays unread.
 */
export function injectedKeys(roots) {
	const found = roots.flatMap(root => INJECTED_KEYS[root] ?? []);
	if (found.length > new Set(found.map(entry => entry.prefix)).size) {
		throw new Error(`two key tables answer one name across ${roots.join(', ')} — the scan cannot say which frontend runs`);
	}

	return new Map(found.map(entry => [entry.prefix, entry]));
}

