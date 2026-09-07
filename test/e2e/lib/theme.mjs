// The colours the app will paint, read out of the theme the app loads.
//
// Every colour on a cell comes from one `ColorThemeData` — `DefaultThemeService` finds the theme
// `ThemeSettingDefaults.COLOR_THEME_DARK` names and reads its JSON before the first paint — so a hex
// pasted out of a run is only ever true of the theme pathway as it stood that day. It went stale
// exactly once already: loading the theme's own `colors` block moved `gitDecoration.*` and
// `editor.findMatchHighlightBackground` off the colour registry's registered defaults, and two
// assertions went red for a change that made the colours *more* tscode's, not less.
//
// So the expected value is derived the way the app derives it: the same manifests pick the same
// theme file, upstream's own JSONC parser reads it, the include chain merges in `_loadColorTheme`'s
// order, and upstream's own `Color.blend` flattens a translucent colour. What each suite still
// states for itself is **which colour id** a row is drawn in and what it sits on — the part of a
// pane that can regress, and the part a hard-coded hex was never really checking.
//
// It reads `out/`, which `npm run e2e` builds first, for the same reason the suite has no freshness
// check: those modules cannot be older than the sources they came from.
//
// Upstream counterpart: test/e2e/lib/probes.mjs

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Color } from '../../../out/src/vs/base/common/color.js';
import { parse } from '../../../out/src/vs/base/common/json.js';
import { ThemeSettingDefaults } from '../../../out/src/vs/workbench/services/themes/common/workbenchThemeService.js';

const EXTENSIONS = fileURLToPath(new URL('../../../resources/extensions/', import.meta.url));

/**
 * The file the configured theme lives in.
 *
 * `ThemeRegistry` builds one `ColorThemeData` per `contributes.themes` entry of every scanned
 * extension and `findThemeBySettingsId` matches on the entry's `id`, or on its `label` where it has
 * none — so the manifests say which file here exactly as they do in the app.
 */
function themeLocation(settingsId) {
	for (const extension of readdirSync(EXTENSIONS, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
		const manifest = join(EXTENSIONS, extension.name, 'package.json');
		for (const theme of parse(readFileSync(manifest, 'utf8'))?.contributes?.themes ?? []) {
			if ((theme.id ?? theme.label) === settingsId) {
				return join(EXTENSIONS, extension.name, theme.path);
			}
		}
	}

	throw new Error(`no extension under ${EXTENSIONS} contributes a theme with the settings id ${settingsId}`);
}

/** The same, for the file icon theme: `contributes.iconThemes` rather than `contributes.themes`. */
function iconThemeLocation(settingsId) {
	for (const extension of readdirSync(EXTENSIONS, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
		const manifest = join(EXTENSIONS, extension.name, 'package.json');
		for (const theme of parse(readFileSync(manifest, 'utf8'))?.contributes?.iconThemes ?? []) {
			if (theme.id === settingsId) {
				return join(EXTENSIONS, extension.name, theme.path);
			}
		}
	}

	throw new Error(`no extension under ${EXTENSIONS} contributes an icon theme with the settings id ${settingsId}`);
}

/** `_loadColorTheme`'s merge: whatever the file includes first, then the file's own colours over it. */
function loadColors(location, colors = {}) {
	const content = parse(readFileSync(location, 'utf8'));
	if (content.include) {
		loadColors(join(dirname(location), content.include), colors);
	}

	return Object.assign(colors, content.colors);
}

const COLORS = loadColors(themeLocation(ThemeSettingDefaults.COLOR_THEME_DARK));

/**
 * A colour id as the theme defines it.
 *
 * A theme that defines no value for an id leaves the app on the colour registry's default, which
 * only the registry can answer — so this throws rather than guessing, naming the id it looked for.
 */
function colorOf(id) {
	const value = COLORS[id];
	if (typeof value !== 'string') {
		throw new Error(`the theme defines no ${id}`);
	}

	const color = Color.Format.CSS.parseHex(value);
	if (!color) {
		throw new Error(`the theme's ${id} is ${JSON.stringify(value)}, which is not a hex colour`);
	}

	return color;
}

/** A cell's colour is `rrggbb` in `bin/read-frame.mjs`, which is `formatHex` without its `#`. */
const cellColour = color => Color.Format.CSS.formatHex(color).slice(1);

/** An opaque theme colour, in the form a frame reads it back. */
export const themeColour = id => cellColour(colorOf(id));

/**
 * A translucent theme colour flattened onto its background layers, front to back. DOM paint first
 * combines match and row colours; the screen then blends that result onto the sidebar. Preserve
 * that order because upstream Color.blend rounds each intermediate channel.
 */
export const themeColourOver = (id, ...backgroundIds) => cellColour(
	[id, ...backgroundIds].map(colorOf).reduce((foreground, background) => foreground.blend(background))
);

const ICONS = parse(readFileSync(iconThemeLocation(ThemeSettingDefaults.FILE_ICON_THEME), 'utf8')).iconDefinitions;

/**
 * What a file row's icon cell must hold, derived the way the app derives it.
 *
 * The colour is the definition's own `fontColor`, which reaches the cell through the stylesheet
 * `FileIconThemeLoader` builds. The glyph is not: the definition's `fontCharacter` is a codepoint in
 * `seti.woff`, which a terminal cannot load, so `tui/workbench/iconGlyphs.ts` draws the
 * initial of the icon's own name instead — the one thing in the icons this fork decides for itself,
 * and the reason this states the *definition id* rather than a letter.
 */
export function setiIcon(definitionId) {
	const definition = ICONS[definitionId];
	if (!definition) {
		throw new Error(`the file icon theme has no ${definitionId} definition`);
	}

	const name = definitionId.replace(/^_/, '');

	return { glyph: name === 'default' ? '·' : name.replace(/[^a-z0-9]/gi, '')[0].toUpperCase(), colour: cellColour(Color.Format.CSS.parseHex(definition.fontColor)) };
}
