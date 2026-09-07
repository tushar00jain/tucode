import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Script } from 'node:vm';
import { reportDOM } from './reportDom.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { KeyCode, KeyMod, KeyChord, KeyCodeUtils } from '../../src/vs/base/common/keyCodes.js';
import { decodeKeybinding } from '../../src/vs/base/common/keybindings.js';
// @ts-ignore — documentation generators are plain Node modules.
import { variantKeys } from '../../docs/keyboard/expressions.mjs';
// @ts-ignore — documentation generators are plain Node modules.
import { shortcutLabel, compareBindings } from '../../docs/keyboard/collect.mjs';
// @ts-ignore — documentation generators are plain Node modules.
import { scanner, hasRegistrations } from '../../docs/keyboard/registrations.mjs';
// @ts-ignore — documentation generators are plain Node modules.
import { renderKeyboard, packRows, selectRows } from '../../docs/keyboard/report.mjs';
// @ts-ignore — documentation generators are plain Node modules.
import { documentation } from '../../docs/config.mjs';

// @ts-ignore — the test loader emits runtime objects for these const enums.
const codes = { KeyCode, KeyMod, KeyChord, KeyCodeUtils };
const decoder = { decodeKeybinding };

it('uses the same generators for a GUI app and separate terminal/Mac frontends', () => {
	const root = mkdtempSync(join(tmpdir(), 'documentation-profile-'));
	try {
		writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'example' }));
		const gui = documentation(root);
		assert.equal(gui.project, 'example');
		assert.equal(gui.pages.length, 1);
		assert.equal(gui.pages[0].file, 'keys.html');
		assert.deepEqual(gui.pages[0].comparisons, [{ upstream: 'win', ours: 'win' }, { upstream: 'mac', ours: 'mac' }]);
		mkdirSync(join(root, 'src/tui/workbench'), { recursive: true });
		writeFileSync(join(root, 'src/tui/workbench/workbench.ts'), '');
		writeFileSync(join(root, 'src/macWebMain.ts'), '');
		const frontends = documentation(root).pages;
		assert.deepEqual(frontends.map((page: { file: string }) => page.file), ['terminal.html', 'mac.html']);
		assert.deepEqual(frontends[0].comparisons, [{ upstream: 'win', ours: 'linux' }, { upstream: 'mac', ours: 'linux' }]);
		assert.deepEqual(frontends[1].comparisons, [{ upstream: 'mac', ours: 'mac' }]);
	} finally { rmSync(root, { recursive: true, force: true }); }
});

it('selects platform-specific replacements, including an explicit unbound primary', () => {
	const variant = { primary: 'KeyMod.CtrlCmd | KeyCode.KeyN', secondary: '[KeyCode.F1]',
		mac: { primary: 'KeyMod.WinCtrl | KeyCode.KeyN' }, linux: { primary: '0' } };
	assert.deepEqual(variantKeys(variant, 'win', codes).keys, [KeyMod.CtrlCmd | KeyCode.KeyN, KeyCode.F1]);
	assert.deepEqual(variantKeys(variant, 'mac', codes).keys, [KeyMod.WinCtrl | KeyCode.KeyN]);
	assert.deepEqual(variantKeys(variant, 'linux', codes), { keys: [], unresolved: false });
	assert.equal(shortcutLabel(KeyMod.CtrlCmd | KeyCode.KeyN, 'mac', codes, decoder), 'Cmd+N');
	assert.equal(shortcutLabel(KeyMod.WinCtrl | KeyCode.KeyN, 'mac', codes, decoder), 'Ctrl+N');
	assert.equal(shortcutLabel(KeyMod.CtrlCmd | KeyCode.KeyN, 'win', codes, decoder), 'Ctrl+N');
});

it('handles conditional defaults, alternatives and two-step chords without guessing unknown values', () => {
	const variant = { primary: 'isMacintosh ? undefined : KeyCode.F1',
		secondary: '[KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyS)]' };
	const mac = variantKeys(variant, 'mac', codes);
	assert.equal(mac.unresolved, false);
	assert.equal(mac.keys.length, 1);
	assert.equal(shortcutLabel(mac.keys[0], 'mac', codes, decoder), 'Cmd+K Cmd+S');
	assert.equal(variantKeys(variant, 'win', codes).keys.length, 2);
	assert.deepEqual(variantKeys({ primary: 'getDynamicKey()' }, 'mac', codes), { keys: [], unresolved: true });
});

it('reads all action binding variants and expands a frontend registration loop', () => {
	const source = `
	class NextEditor { constructor() { super({ id: 'next', title: localize2('next.key', 'Next Editor'), keybinding: [
		{ primary: KeyMod.CtrlCmd | KeyCode.PageDown, mac: { primary: KeyMod.CtrlCmd | KeyCode.BracketRight } },
		{ primary: KeyCode.F6, mac: { primary: 0 } }
	] }); } }
	const actions = [NextEditor];
	for (const action of actions) registerAction2(action);
	`;
	assert.equal(hasRegistrations(source), true);
	const tree = { read: () => source };
	const records = scanner(ts).scan('main.ts', tree, () => null, { detailedKeys: true });
	assert.equal(records.length, 1);
	assert.equal(records[0].id, 'next');
	assert.equal(records[0].label, 'Next Editor');
	assert.equal(records[0].variants.length, 2);
	assert.equal(records[0].variants[1].mac.primary, '0');
});

it('compares actions by id and keeps uncertain readings visible', () => {
	const action = (id: string, bindings: string[], unresolved = false) => ({ id, label: 'Same label', bindings: new Set(bindings), unresolved });
	const ours = new Map([['one', action('one', ['F1'])], ['two', action('two', ['F2'], true)]]);
	const base = new Map([['one', action('one', ['F1'])], ['two', action('two', ['F3'])]]);
	const rows = compareBindings(ours, base);
	assert.equal(rows[0].changed, false);
	assert.equal(rows[1].changed, true);
	assert.equal(packRows(rows)[1][3], 'F2 · Not resolved');
	assert.equal(selectRows(packRows(rows), '', false).length, 1);
	assert.equal(selectRows(packRows(rows), '', true).length, 2);
	assert.equal(selectRows(packRows(rows), 'F3', true).length, 1);
});

it('resolves named Mac overrides and constants inside chord arithmetic', () => {
	const source = `const defaults = { primary: KeyMod.CtrlCmd | KeyCode.KeyP,
		secondary: [KeyCode.F1], mac: { primary: KeyMod.WinCtrl | KeyCode.KeyP } };
	KeybindingsRegistry.registerKeybindingRule({ id: 'next', primary: defaults.primary, mac: defaults.mac });
	KeybindingsRegistry.registerKeybindingRule({ id: 'previous', primary: defaults.primary | KeyMod.Shift,
		secondary: [defaults.secondary[0] | KeyMod.Shift] });`;
	const records = scanner(ts).scan('main.ts', { read: () => source }, () => null, { detailedKeys: true });
	assert.deepEqual(variantKeys(records[0].variants[0], 'mac', codes), { keys: [KeyMod.WinCtrl | KeyCode.KeyP], unresolved: false });
	assert.deepEqual(variantKeys(records[1].variants[0], 'win', codes), {
		keys: [KeyMod.CtrlCmd | KeyCode.KeyP | KeyMod.Shift, KeyCode.F1 | KeyMod.Shift], unresolved: false
	});
});

it('renders only visible rows and keeps the two terminal comparisons separate', () => {
	const rows = Array.from({ length: 5000 }, (_, i) => [`Action ${i}`, `id.${i}`, 'Ctrl+N', 'N', i === 0 ? 1 : 0]);
	const data = { frontend: 'Terminal', baseline: { ref: 'test', commit: '1234567890' }, tables: [
		{ title: 'Windows', upstream: 'Windows binding', rows }, { title: 'macOS', upstream: 'macOS binding', rows }
	] };
	const html = renderKeyboard(data);
	assert.equal((html.match(/<table>/g) ?? []).length, 2);
	assert.ok(!html.includes('<td>Action 4999'));
	const { document, created } = reportDOM();
	document.getElementById('data').textContent = JSON.stringify(data);
	new Script(html.match(/<script>(.*?)<\/script>/s)![1]).runInNewContext({ document });
	assert.ok(created() < 30, `${created()} elements were created for filtered rows`);
	assert.equal(document.getElementById('count-0').textContent, '1 actions shown');
	const unsafe = renderKeyboard({ ...data, frontend: '<script>alert(1)</script>' });
	assert.ok(!unsafe.includes('<script>alert(1)</script>'));
});
