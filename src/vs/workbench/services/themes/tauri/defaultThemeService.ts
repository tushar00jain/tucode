/*---------------------------------------------------------------------------------------------
 *  The theme, before there is a theme picker.
 *
 *  Upstream has exactly two `IThemeService` implementations: `WorkbenchThemeService`, which
 *  takes `IWorkbenchLayoutService` and `IHostService` and writes its colours into a
 *  `createStyleSheet`, and `TestThemeService`, a mock whose `defines()` throws. Neither can
 *  stand up here, so this holds one `ColorThemeData`, one `FileIconThemeData` and
 *  `ProductIconThemeData.defaultTheme`, and never changes any of them after boot. Every answer
 *  therefore comes from upstream's own theme classes, resolved out of the colour and icon
 *  registries.
 *
 *  What it *does* do, which T04 recorded as a task of its own, is load those themes' JSON:
 *  `ThemeRegistry` over upstream's `themes` and `iconThemes` extension points finds the themes
 *  `ThemeSettingDefaults` names, `ColorThemeData.fromExtensionTheme` /
 *  `FileIconThemeData.fromExtensionTheme` build them and `ensureLoaded` reads the files. Without
 *  the colour load a `ColorThemeData` carries no TextMate rules at all, so `tokenColorMap` is two
 *  entries and every token in every file resolves to the default foreground — the syntax colours
 *  would be tucode's rather than tscode's. Without the icon load `hasFileIcons` is false, which is
 *  the answer `views.css` reads before it will align a file row's icon with a folder's twistie.
 *  These are the same themes, read from the same files, resolved by the same classes.
 *
 *  It refines `IThemeService` rather than sitting beside it: `IWorkbenchThemeService` is a
 *  `refineServiceDecorator` over the same identifier, so one registration answers both, and the
 *  members only the workbench interface declares are the ones
 *  `TextMateTokenizationFeature` takes.
 *
 *  Upstream counterpart: src/vs/workbench/services/themes/browser/workbenchThemeService.ts
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IExtensionResourceLoaderService } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { addStylesheet } from '../../../../../tui/terminal/dom/style.js';
import { IExtensionService } from '../../extensions/common/extensions.js';
import { FileIconThemeData, FileIconThemeLoader } from '../browser/fileIconThemeData.js';
import { ProductIconThemeData } from '../browser/productIconThemeData.js';
import { ColorThemeData } from '../common/colorThemeData.js';
import { registerColorThemeExtensionPoint, registerFileIconThemeExtensionPoint, ThemeRegistry } from '../common/themeExtensionPoints.js';
import {
	IWorkbenchColorTheme, IWorkbenchFileIconTheme, IWorkbenchProductIconTheme, IWorkbenchThemeService,
	ThemeSettingDefaults, ThemeSettings
} from '../common/workbenchThemeService.js';

/** Answered by every operation that would change or install a theme, none of which this can do. */
const UNSUPPORTED = 'tucode has one theme and no theme picker';

export class DefaultThemeService extends Disposable implements IWorkbenchThemeService {

	declare readonly _serviceBrand: undefined;

	private readonly colorThemeRegistry = this._register(new ThemeRegistry(registerColorThemeExtensionPoint(), ColorThemeData.fromExtensionTheme));

	private readonly fileIconThemeRegistry = this._register(new ThemeRegistry(registerFileIconThemeExtensionPoint(), FileIconThemeData.fromExtensionTheme, true, FileIconThemeData.noIconTheme));

	private fileIconTheme: FileIconThemeData = FileIconThemeData.noIconTheme;

	/**
	 * The colour scheme a terminal has no way to ask its host about — `IHostColorSchemeService`
	 * is what answered upstream, over `matchMedia`. Dark is the value
	 * `ColorThemeData.toColorScheme` falls back to for an unrecognized theme type, and the
	 * default `workbench.colorTheme` on every platform but the web.
	 */
	private colorTheme = ColorThemeData.createUnloadedThemeForThemeType(ColorScheme.DARK);

	private readonly _onDidColorThemeChange = this._register(new Emitter<IWorkbenchColorTheme>());
	readonly onDidColorThemeChange = this._onDidColorThemeChange.event;

	private readonly _onDidFileIconThemeChange = this._register(new Emitter<IWorkbenchFileIconTheme>());
	readonly onDidFileIconThemeChange = this._onDidFileIconThemeChange.event;

	constructor(
		@IExtensionService private readonly extensionService: IExtensionService,
		@IExtensionResourceLoaderService private readonly extensionResourceLoaderService: IExtensionResourceLoaderService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ILogService private readonly logService: ILogService
	) {
		super();
	}

	/**
	 * Reads the configured theme's JSON, and is awaited before the first paint: a pane asks the
	 * theme for its colours while it renders, and a theme that arrived afterwards would need
	 * every pane to repaint on an event none of them listens for.
	 *
	 * A theme that is missing or unreadable leaves the unloaded one in place, which is what
	 * `WorkbenchThemeService` also falls back to — the app stays usable in the colour registry's
	 * defaults, and the failure goes to the log rather than to the screen.
	 */
	async initialize(): Promise<void> {
		// The extension point only fires once the scanned manifests are published, and this is
		// the first thing in boot that needs them.
		await this.extensionService.whenInstalledExtensionsRegistered();

		await this.initializeFileIconTheme();

		const settingsId = this.configurationService.getValue<string>(ThemeSettings.COLOR_THEME) ?? ThemeSettingDefaults.COLOR_THEME_DARK;
		const theme = this.colorThemeRegistry.findThemeBySettingsId(settingsId, ThemeSettingDefaults.COLOR_THEME_DARK);
		if (!theme) {
			this.logService.warn(`No color theme is contributed for ${settingsId}; using the color registry's defaults.`);

			return;
		}

		try {
			await theme.ensureLoaded(this.extensionResourceLoaderService);
			this.colorTheme = theme;
			this._onDidColorThemeChange.fire(theme);
		} catch (error) {
			this.logService.error(`Unable to load color theme ${settingsId}`, error);
		}
	}

	/**
	 * The same route one theme over: `FileIconThemeLoader` turns the theme document into upstream's
	 * own stylesheet, which is where the icon's colour, its `::before` and the `@font-face` naming
	 * `seti.woff` live, and `tui/terminal/dom/style.ts` reads it beside every other sheet.
	 * `hasFileIcons` is the answer `views.css` needs before it will collapse a file row's twistie,
	 * so the alignment is the theme's rather than a constant here.
	 *
	 * The terminal cannot load that font, so it substitutes a printable character through
	 * `tui/workbench/iconGlyphs.ts` once this has run.
	 *
	 * A theme that will not load leaves `noIconTheme` in place, so the failure costs the icons and
	 * nothing else.
	 */
	private async initializeFileIconTheme(): Promise<void> {
		const configured = this.configurationService.getValue<string | null | undefined>(ThemeSettings.FILE_ICON_THEME);
		if (configured === null) {
			// Upstream's own spelling of "no file icons", and `noIconTheme` is already the answer.
			return;
		}

		const settingsId = configured ?? ThemeSettingDefaults.FILE_ICON_THEME;
		const theme = this.fileIconThemeRegistry.findThemeBySettingsId(settingsId, ThemeSettingDefaults.FILE_ICON_THEME);
		if (!theme?.location) {
			this.logService.warn(`No file icon theme is contributed for ${settingsId}; file rows will have no icon.`);

			return;
		}

		try {
			await theme.ensureLoaded(new FileIconThemeLoader(this.extensionResourceLoaderService, this.languageService));
			addStylesheet(theme.styleSheetContent ?? '');
			this.fileIconTheme = theme;
			this._onDidFileIconThemeChange.fire(theme);
		} catch (error) {
			this.logService.error(`Unable to load file icon theme ${settingsId}`, error);
		}
	}

	getColorTheme(): IWorkbenchColorTheme {
		return this.colorTheme;
	}

	getFileIconTheme(): IWorkbenchFileIconTheme {
		return this.fileIconTheme;
	}

	getProductIconTheme(): IWorkbenchProductIconTheme {
		return ProductIconThemeData.defaultTheme;
	}

	getPreferredColorScheme(): ColorScheme | undefined {
		return this.colorTheme.type;
	}

	// The one theme of each kind is the only one there is, which is what a picker would list.
	async getColorThemes(): Promise<IWorkbenchColorTheme[]> { return [this.getColorTheme()]; }
	async getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]> { return [this.getFileIconTheme()]; }
	async getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]> { return [this.getProductIconTheme()]; }

	// The product icon theme is never loaded over, so it cannot change.
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme> = Event.None;

	// There is no gallery — `product.json` has no `extensionsGallery` — so a marketplace theme
	// cannot be fetched, let alone chosen.
	async getMarketplaceColorThemes(): Promise<IWorkbenchColorTheme[]> { return []; }
	async getMarketplaceFileIconThemes(): Promise<IWorkbenchFileIconTheme[]> { return []; }
	async getMarketplaceProductIconThemes(): Promise<IWorkbenchProductIconTheme[]> { return []; }

	setColorTheme(): Promise<IWorkbenchColorTheme | null> { throw new Error(UNSUPPORTED); }
	setFileIconTheme(): Promise<IWorkbenchFileIconTheme> { throw new Error(UNSUPPORTED); }
	setProductIconTheme(): Promise<IWorkbenchProductIconTheme> { throw new Error(UNSUPPORTED); }
}
