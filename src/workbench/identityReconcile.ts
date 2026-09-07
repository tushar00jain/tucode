/*---------------------------------------------------------------------------------------------
 *  Deterministic identity-keyed reconciliation shared by every frontend projection.
 *--------------------------------------------------------------------------------------------*/

export type IdentityReconcileOperation =
	| { readonly kind: 'remove'; readonly index: number }
	| { readonly kind: 'insert'; readonly index: number }
	| { readonly kind: 'move'; readonly from: number; readonly to: number };

/** Transform `previous` into `next` without a full rebuild. Duplicate identities are rejected. */
export function reconcileIdentities(previous: readonly string[], next: readonly string[]): readonly IdentityReconcileOperation[] {
	if (new Set(previous).size !== previous.length || new Set(next).size !== next.length) {
		throw new Error('projection identities must be unique');
	}
	const desired = new Set(next);
	const current = [...previous];
	const operations: IdentityReconcileOperation[] = [];
	for (let index = current.length - 1; index >= 0; index--) {
		if (!desired.has(current[index])) {
			current.splice(index, 1);
			operations.push({ kind: 'remove', index });
		}
	}
	for (let index = 0; index < next.length; index++) {
		if (current[index] === next[index]) { continue; }
		const from = current.indexOf(next[index], index + 1);
		if (from >= 0) {
			const [identity] = current.splice(from, 1);
			current.splice(index, 0, identity);
			operations.push({ kind: 'move', from, to: index });
		} else {
			current.splice(index, 0, next[index]);
			operations.push({ kind: 'insert', index });
		}
	}
	for (let index = current.length - 1; index >= next.length; index--) {
		current.splice(index, 1);
		operations.push({ kind: 'remove', index });
	}
	return operations;
}
