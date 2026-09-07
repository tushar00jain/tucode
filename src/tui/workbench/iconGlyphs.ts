/*---------------------------------------------------------------------------------------------
 *  The terminal's icon glyphs, at boot: the setting that says whether it needs them, and the
 *  letters read out of the loaded icon theme.
 *
 *  The table itself is `terminal/dom/glyphSubstitutes.ts`, which imports nothing so that it stays
 *  inside `test:unit`. This is the half that has to reach the theme service and the configuration
 *  registry, and it is the half **only the terminal's entry point imports** — which is why
 *  `tscode.iconFont` is registered here rather than beside the theme settings it sits with: a
 *  `registerConfiguration` at the module scope of a shared file would contribute a terminal's
 *  setting to a frontend that has no terminal.
 *
 *  Upstream counterpart: none — a browser loads the font and draws the glyph, so there is nothing
 *  upstream to stand in for it.
 *--------------------------------------------------------------------------------------------*/

import * as Json from '../../vs/base/common/json.js';
import { localize } from '../../vs/nls.js';
import { IConfigurationService } from '../../vs/platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../vs/platform/configuration/common/configurationRegistry.js';
import { IExtensionResourceLoaderService } from '../../vs/platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { ServicesAccessor } from '../../vs/platform/instantiation/common/instantiation.js';
import { ILogService } from '../../vs/platform/log/common/log.js';
import { Registry } from '../../vs/platform/registry/common/platform.js';
import { IThemeService } from '../../vs/platform/theme/common/themeService.js';
import { FileIconThemeData } from '../../vs/workbench/services/themes/browser/fileIconThemeData.js';
import { addGlyphSubstitutes, setIconFont } from '../terminal/dom/glyphSubstitutes.js';

/**
 * The one setting this fork adds, and it is a fact about the *user's terminal* that no code in this
 * process can measure: whether the font it draws in carries those codepoints. Off, an icon is a
 * letter derived from its type instead.
 */
export const ICON_FONT_SETTING = 'tscode.iconFont';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'tscode',
	order: 100,
	title: localize('tscodeConfigurationTitle', "tscode"),
	type: 'object',
	properties: {
		[ICON_FONT_SETTING]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.MACHINE,
			description: localize('tscode.iconFont', "Whether the terminal draws in a font carrying the icon fonts' own codepoints — `seti.woff`, shipped in `resources/extensions/theme-seti/icons`, and `codicon.ttf`. When it does not, a file icon is drawn as a letter taken from the icon's name in the theme and a folder's bubble badge as a dot, both in the colour the theme gives the icon.")
		}
	}
});

/**
 * The letter each of the loaded theme's icons is drawn as, installed before the first paint.
 *
 * It is **the initial of the icon's own name**, which is the theme's name for the file's type:
 * `_typescript` is `T`, `_rust` is `R`, `_json` is `J`. Seti's 383 definitions are 192 names, so a
 * letter names about eight types and **collisions are not resolved** — a second character would
 * need a second column that tscode's row does not have, and the theme's own `fontColor`, which the
 * same rule carries onto the same cell, is what tells `T` for TypeScript from `T` for Terraform.
 * `_default`, the type-less file, would be a `D` on most rows in a workspace and is the one name
 * drawn as something other than its initial.
 *
 * It runs from the entry point after `DefaultThemeService.initialize()` rather than inside it,
 * because reading a theme document for letters is a thing only this frontend does — and the theme
 * service is shared. A theme that will not load leaves the seeded table in place, so the failure
 * costs the letters and nothing else.
 */
export async function loadGlyphSubstitutes(accessor: ServicesAccessor): Promise<void> {
	const logService = accessor.get(ILogService);

	setIconFont(accessor.get(IConfigurationService).getValue<boolean>(ICON_FONT_SETTING) === true);

	const theme = accessor.get(IThemeService).getFileIconTheme() as FileIconThemeData;
	if (!theme.location) {
		// `noIconTheme`, or a theme that did not load. Either way there are no definitions to read.
		return;
	}

	try {
		const document = Json.parse(await accessor.get(IExtensionResourceLoaderService).readExtensionResource(theme.location)) as { iconDefinitions?: { [id: string]: { fontCharacter?: string } } };
		const entries: [string, string][] = [];

		for (const [id, definition] of Object.entries(document.iconDefinitions ?? {})) {
			const name = id.replace(/^_/, '').replace(/_light$/, '');
			const initial = name.replace(/[^a-z0-9]/gi, '')[0];
			if (definition.fontCharacter && initial) {
				entries.push([String.fromCodePoint(parseInt(definition.fontCharacter.replace(/^\\/, ''), 16)), name === 'default' ? '·' : initial.toUpperCase()]);
			}
		}

		addGlyphSubstitutes(entries);
	} catch (error) {
		logService.error(`Unable to read the file icon theme's definitions; file icons will be drawn as the theme's own codepoints.`, error);
	}
}
