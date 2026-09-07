import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decodeKeybinding } from '../../src/vs/base/common/keybindings.js';
import { KeyCode, KeyMod } from '../../src/vs/base/common/keyCodes.js';
import { OperatingSystem } from '../../src/vs/base/common/platform.js';
import { TerminalKeyboardLayoutService } from '../../src/tui/workbench/terminalKeyboard.js';

test('terminal CtrlCmd bindings remain Ctrl bindings on macOS hosts', () => {
	const service = new TerminalKeyboardLayoutService();
	const keybinding = decodeKeybinding(KeyMod.CtrlCmd | KeyCode.KeyW, OperatingSystem.Linux)!;
	const [resolved] = service.getKeyboardMapper().resolveKeybinding(keybinding);
	const [chord] = resolved.getChords();

	assert.equal(chord.ctrlKey, true);
	assert.equal(chord.metaKey, false);
	assert.equal(service.terminalWire, true);
});
