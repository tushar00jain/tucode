// The editor: TextMate tokenization through the bundled grammars and themes, the modal state
// — viewer until `V`, normal after it, insert after `i`, and typing reaching the buffer in that
// one state and no other — and the workbench keys that have to keep working through all of it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { closeQuickOpen, editorText, editorTokenColors, focusedElement, focusEditorText, keysQuickPick, openFileByQuickOpen, vimMode } from '../lib/probes.mjs';
import { waitFor } from '../lib/wait.mjs';

/** A string no fixture file contains, so finding it in the buffer means this suite typed it. */
const TYPED = 'zzq';

/** What tokenizing the first file of a session is allowed to take; measured at ~110 ms. */
const TOKENIZE_TIMEOUT = 5_000;

/**
 * The token colours once TextMate has answered about the buffer.
 *
 * Monaco paints every line in the default `mtk1` and repaints it coloured when the tokenizer comes
 * back, which on the first file of a session is a grammar and an oniguruma engine away.
 * `editorTokenColors` waits for the first `mtk` span, and the *un*tokenized paint already has one —
 * so it is polled here rather than read once. A reading that never grows past one class is left to
 * the assertions, which name what the editor drew.
 */
async function tokenColors(page) {
	let tokens;
	try {
		await waitFor(async () => (tokens = await editorTokenColors(page)).classes.length > 1,
			{ what: 'the editor never tokenized', timeoutMs: TOKENIZE_TIMEOUT });
	} catch { /* an untokenized editor is what the assertions are about, not a failure to read it */ }

	return tokens;
}

export default function registerEditorSuite(context) {
	describe('editor', () => {
		it('tokenizes an opened file into distinct token colours', async () => {
			await openFileByQuickOpen(context.page, 'alpha/src/app.ts');
			await closeQuickOpen(context.page);
			const tokens = await tokenColors(context.page);
			assert.ok(tokens.spanCount > 5, `only ${tokens.spanCount} token spans rendered`);
			assert.ok(tokens.classes.length > 2, `only ${tokens.classes.length} token classes: ${JSON.stringify(tokens.classes)}`);
			assert.ok(tokens.colors.length > 2, `only ${tokens.colors.length} distinct colours: ${JSON.stringify(tokens.colors)}`);
		});

		it('opens as a viewer, attaches vim on V, and takes typing only in insert mode', async () => {
			const page = context.page;
			await openFileByQuickOpen(page, 'alpha/src/app.ts');
			await closeQuickOpen(page);
			await focusEditorText(page);

			// Viewer: the mode line says so, and typing does nothing at all.
			await vimMode(page, '-- VIEWER --');
			const opened = await editorText(page);
			await page.keyboard.type(TYPED);
			assert.equal(await editorText(page), opened, 'typing in the viewer reached the buffer');

			// `V` attaches vim in normal mode, where the letters are commands rather than text.
			await page.keyboard.press('v');
			await vimMode(page, '-- NORMAL --');
			assert.equal(await editorText(page), opened, 'typing in normal mode reached the buffer');

			// Insert is the one state in which it does.
			await page.keyboard.press('i');
			await vimMode(page, '-- INSERT --');
			await page.keyboard.type(TYPED);
			await editorText(page, text => text.includes(TYPED));

			// Escape is the engine's, and `u` takes the whole insert back — one undo stop per command
			// is what `TauriVimAdapter.operation` exists for.
			await page.keyboard.press('Escape');
			await vimMode(page, '-- NORMAL --');
			await page.keyboard.press('u');
			await editorText(page, text => text === opened);

			// `:q` detaches, back to the state the editor opened in. Not `V`: with vim attached `v`
			// is the engine's own visual mode rather than anything this port added.
			await page.keyboard.type(':q');
			await vimMode(page, ':q');
			await page.keyboard.press('Enter');
			await vimMode(page, '-- VIEWER --');
		});

		// The bug this exists for: every `global` row expanded to `!inputFocus`, which a focused
		// Monaco sets in every state — so `0`, `?`, `T` and the container digits were all dead in an
		// editor, and the only answer the user got was Monaco's "cannot edit in read only editor".
		// Nothing had pressed a workbench key from inside an editor until this step.
		it('answers a workbench key from the viewer, and types the same key in insert mode', async () => {
			const page = context.page;
			await openFileByQuickOpen(page, 'alpha/src/app.ts');
			await closeQuickOpen(page);
			await focusEditorText(page);
			await vimMode(page, '-- VIEWER --');

			// `?` is the one that says the list itself agrees the key applies here.
			assert.ok((await keysQuickPick(page)).length > 0, '`?` opened no list from the viewer');
			await closeQuickOpen(page);

			// `0` is what the user pressed: the side bar takes the keyboard off the editor.
			await focusEditorText(page);
			await page.keyboard.press('0');
			await waitFor(async () => (await focusedElement(page)).inList,
				{ what: '`0` never moved the keyboard out of the editor' });

			// …and in insert mode the same key is text, because that is the one state that types.
			await focusEditorText(page);
			const opened = await editorText(page);
			await page.keyboard.press('v');
			await vimMode(page, '-- NORMAL --');
			await page.keyboard.press('i');
			await vimMode(page, '-- INSERT --');
			await page.keyboard.press('0');
			await editorText(page, text => text !== opened);
			assert.equal((await focusedElement(page)).inList, false, '`0` left the editor while the user was typing');

			// Back to the state the suite found the editor in.
			await page.keyboard.press('Escape');
			await vimMode(page, '-- NORMAL --');
			await page.keyboard.press('u');
			await editorText(page, text => text === opened);
			await page.keyboard.type(':q');
			await page.keyboard.press('Enter');
			await vimMode(page, '-- VIEWER --');
		});
	});
}
