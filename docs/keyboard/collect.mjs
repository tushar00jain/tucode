// Inventory default shortcut declarations reached by each frontend's source imports.
import ts from 'typescript';
import { scanner, hasRegistrations } from './registrations.mjs';
import { closure, resolveSpec } from './closure.mjs';
import { injectedKeys } from './injected.mjs';
import { cachedTree, sourceModules } from './source.mjs';
import { evaluateNode, evaluate, platformValues, variantKeys, UNRESOLVED } from './expressions.mjs';

const KEYMAP = 'src/vs/workbench/browser/tauri/keymap.ts';
const CODES = 'src/vs/base/common/keyCodes.ts';
const BINDINGS = 'src/vs/base/common/keybindings.ts';
const field = (node, name) => node?.properties?.find(p => p.name?.getText().replace(/^['"]|['"]$/g, '') === name)?.initializer;
function text(node) {
	if (!node) return undefined;
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (ts.isTemplateExpression(node)) return node.head.text.trim();
	if (ts.isCallExpression(node) && /(?:^|\.)(?:localize|localize2)$/.test(node.expression.getText())) return text(node.arguments[1]);
	return undefined;
}

// Expand only keymap loops actually present in a frontend, including its .filter predicate.
function keymapLoops(module, keymap) {
	const records = [], commands = new Map();
	const declared = module.exprs.get('COMMANDS');
	if (declared && ts.isArrayLiteralExpression(declared)) {
		for (const entry of declared.elements) {
			const id = text(field(entry, 'id'));
			if (id) commands.set(id, text(field(entry, 'title')));
		}
	}
	function visit(node) {
		if (ts.isForOfStatement(node) && /rowsFor\(/.test(node.expression.getText())) {
			let expression = node.expression, predicate;
			if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
				&& expression.expression.name.text === 'filter') {
				predicate = expression.arguments[0]; expression = expression.expression.expression;
			}
			if (!ts.isCallExpression(expression) || expression.expression.getText() !== 'rowsFor') return;
			const surface = text(expression.arguments[0]);
			if (surface !== 'gui' && surface !== 'tui') return;
			const body = node.statement.getText();
			if (!body.includes('registerKeybindingRule')) return;
			for (const row of keymap.rowsFor(surface)) {
				if (predicate) {
					if (!ts.isArrowFunction(predicate)) throw new Error('Unsupported keymap filter');
					const include = evaluateNode(predicate.body, { [predicate.parameters[0].name.getText()]: row });
					if (include === UNRESOLVED) throw new Error('Cannot resolve keymap filter');
					if (!include) continue;
				}
				if (/if\s*\(row\.stock\)/.test(body) && row.stock) continue;
				const id = body.includes('guiRuleId(') ? keymap.guiRuleId(row, new Set(commands.keys())) : row.id;
				const keys = keymap.keysFor(row, surface);
				records.push({ id, label: commands.get(id), key: String(keys[0] ?? 0),
					variants: [{ primary: String(keys[0] ?? 0), secondary: JSON.stringify(keys.slice(1)) }],
					when: keymap.guiRuleWhen(row)?.serialize(), file: module.rel, line: module.source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(module.source);
	return records;
}

function nativeKeys(module) {
	const records = [];
	function visit(node) {
		if (ts.isObjectLiteralExpression(node) && text(field(node, 'kind')) === 'selector') {
			const selector = text(field(node, 'selector')), key = field(node, 'key');
			const character = text(field(key, 'characters')), modifiers = evaluateNode(field(key, 'modifiers'), {});
			if (selector && character && typeof modifiers === 'number') {
				const binding = [[1 << 18, 'Ctrl'], [1 << 17, 'Shift'], [1 << 19, 'Alt'], [1 << 20, 'Cmd']]
					.filter(([mask]) => modifiers & mask).map(([, label]) => label).concat(character.toUpperCase()).join('+');
				records.push({ id: `native:${selector}`, label: text(field(node, 'label')) ?? selector,
					native: binding, file: module.rel, line: module.source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(module.source);
	return records;
}

export async function collect(tree, roots) {
	tree = cachedTree(tree);
	const [codes, decoder, keymap] = await sourceModules(tree, [CODES, BINDINGS, ...(tree.has(KEYMAP) ? [KEYMAP] : [])]);
	const reader = scanner(ts, injectedKeys(roots));
	const reached = closure(tree, roots), records = [];
	const edge = (spec, from) => resolveSpec(tree, spec, from);
	for (const file of reached.keys()) {
		const body = tree.read(file);
		if (!file.endsWith('.ts') || !body || (!hasRegistrations(body) && !body.includes("kind: 'selector'"))) continue;
		records.push(...reader.scan(file, tree, edge, { detailedKeys: true }));
		if (keymap && body.includes('rowsFor(')) records.push(...keymapLoops(reader.moduleOf(file, tree), keymap));
		if (body.includes("kind: 'selector'")) records.push(...nativeKeys(reader.moduleOf(file, tree)));
	}
	return { records, codes, decoder, modules: reached.size, files: [...reached.keys()] };
}

export function shortcutLabel(key, platform, codes, decoder) {
	const os = { win: 1, mac: 2, linux: 3 }[platform];
	return decoder.decodeKeybinding(key, os)?.chords.map(chord => [
		...['ctrlKey', 'shiftKey', 'altKey', 'metaKey'].flatMap((field, i) => chord[field]
			? [['Ctrl', 'Shift', 'Alt', platform === 'mac' ? 'Cmd' : 'Meta'][i]] : []),
		codes.KeyCodeUtils.toString(chord.keyCode)
	].join('+')).join(' ');
}

export function bindingsByAction(inventory, platform) {
	const actions = new Map();
	for (const record of inventory.records) {
		if (record.id.startsWith('?') || record.declaresOnly) continue;
		if (record.conditions?.some(([condition, expected]) => {
			const value = evaluate(condition, platformValues(platform, inventory.codes));
			return typeof value === 'boolean' && value !== expected;
		})) continue;
		if (!record.key && !record.variants?.length && !record.native) continue;
		const action = actions.get(record.id) ?? { id: record.id, label: record.label, bindings: new Set(), unresolved: false };
		if (!action.label && record.label) action.label = record.label;
		if (record.native) {
			if (platform === 'mac') action.bindings.add(record.native);
		} else {
			for (const variant of record.variants?.length ? record.variants : [{ primary: record.key, secondary: record.secondary }]) {
				const { keys, unresolved } = variantKeys(variant, platform, inventory.codes);
				action.unresolved ||= unresolved;
				for (const key of keys) {
					const label = shortcutLabel(key, platform, inventory.codes, inventory.decoder);
					if (label) action.bindings.add(label); else action.unresolved = true;
				}
			}
		}
		actions.set(record.id, action);
	}
	// A separate command/menu declaration often owns the readable title.
	for (const record of inventory.records) {
		const action = actions.get(record.id);
		if (action && !action.label && record.label) action.label = record.label;
	}
	return actions;
}

export function compareBindings(ours, upstream) {
	return [...ours.values()].map(action => {
		const base = upstream.get(action.id);
		const own = [...action.bindings].sort(), before = [...(base?.bindings ?? [])].sort();
		return { id: action.id, action: action.label ?? base?.label ?? action.id,
			upstream: before, ours: own, upstreamUnresolved: !!base?.unresolved, oursUnresolved: action.unresolved,
			changed: action.unresolved || !!base?.unresolved || JSON.stringify(before) !== JSON.stringify(own) };
	}).filter(row => row.ours.length || row.upstream.length || row.oursUnresolved || row.upstreamUnresolved).sort((a, b) => a.action.localeCompare(b.action, 'en') || a.id.localeCompare(b.id, 'en'));
}
