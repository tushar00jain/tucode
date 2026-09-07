// Opening a folder, the explorer, and the file icon theme.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TOP_LEVEL } from '../lib/fixture.mjs';
import { explorerRows, fileIconGlyph, loadedFonts } from '../lib/probes.mjs';

export default function registerWorkspaceSuite(context) {
	describe('workspace', () => {
		it('lists the opened folder in the explorer', async () => {
			const rows = await explorerRows(context.page);
			const names = rows.map(row => row.name);
			for (const entry of TOP_LEVEL) {
				assert.ok(names.includes(entry), `explorer is missing ${entry}; it lists ${JSON.stringify(names)}`);
			}
		});

		it('renders a file icon from the icon theme', async () => {
			const glyph = await fileIconGlyph(context.page, 'README.md');
			assert.match(glyph.classes, /file-icon/, `icon label carries no file-icon class: ${glyph.classes}`);
			const drawn = /seti/i.test(glyph.fontFamily) || glyph.backgroundImage !== 'none';
			assert.ok(drawn, `README.md has no icon glyph: ${JSON.stringify(glyph)}`);
			assert.notEqual(glyph.content, 'none', `README.md's icon renders no content: ${JSON.stringify(glyph)}`);
		});

		it('loads the icon theme font', async () => {
			const fonts = await loadedFonts(context.page);
			const seti = fonts.find(face => /seti/i.test(face.family));
			assert.ok(seti, `no seti face among ${JSON.stringify(fonts)}`);
			assert.equal(seti.status, 'loaded', `the seti face is ${seti.status}`);
		});
	});
}
