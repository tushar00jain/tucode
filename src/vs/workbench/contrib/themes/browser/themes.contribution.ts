/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { KeyMod, KeyChord, KeyCode } from '../../../../base/common/keyCodes.js';
import { MenuRegistry, MenuId, Action2, registerAction2, ISubmenuItem } from '../../../../platform/actions/common/actions.js';
import { equalsIgnoreCase } from '../../../../base/common/strings.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { IWorkbenchThemeService, IWorkbenchTheme, ThemeSettingTarget, IWorkbenchColorTheme, IWorkbenchFileIconTheme, IWorkbenchProductIconTheme, ThemeSettings, ThemeSettingDefaults } from '../../../services/themes/common/workbenchThemeService.js';
import { IColorRegistry, Extensions as ColorRegistryExtensions } from '../../../../platform/theme/common/colorRegistry.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { Color } from '../../../../base/common/color.js';
import { ColorScheme, isHighContrast } from '../../../../platform/theme/common/theme.js';
import { colorThemeSchemaId } from '../../../services/themes/common/colorThemeSchema.js';
import { isCancellationError, onUnexpectedError } from '../../../../base/common/errors.js';
import { IQuickInputButton, IQuickInputService, IQuickPick, IQuickPickItem, QuickInputButtonLocation, QuickPickInput } from '../../../../platform/quickinput/common/quickInput.js';
import { DEFAULT_PRODUCT_ICON_THEME_ID, ProductIconThemeData } from '../../../services/themes/browser/productIconThemeData.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { FileIconThemeData } from '../../../services/themes/browser/fileIconThemeData.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';

import { mainWindow } from '../../../../base/browser/window.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';

interface InstalledThemesPickerOptions {
	readonly placeholderMessage: string;
	readonly title?: string;
	readonly description?: string;
	readonly buttons?: IQuickInputButton[];
	readonly onButton?: (button: IQuickInputButton, quickInput: IQuickPick<ThemeItem, { useSeparators: boolean }>) => Promise<void>;
}

class InstalledThemesPicker {
	constructor(
		private readonly options: InstalledThemesPickerOptions,
		private readonly setTheme: (theme: IWorkbenchTheme | undefined, settingsTarget: ThemeSettingTarget) => Promise<unknown>,
		@IQuickInputService private readonly quickInputService: IQuickInputService
	) {
	}

	public async openQuickPick(picks: QuickPickInput<ThemeItem>[], currentTheme: IWorkbenchTheme) {

		let selectThemeTimeout: number | undefined;

		const selectTheme = (theme: IWorkbenchTheme | undefined, applyTheme: boolean) => {
			if (selectThemeTimeout) {
				clearTimeout(selectThemeTimeout);
			}
			selectThemeTimeout = mainWindow.setTimeout(() => {
				selectThemeTimeout = undefined;
				const newTheme = (theme ?? currentTheme) as IWorkbenchTheme;
				this.setTheme(newTheme, applyTheme ? 'auto' : 'preview').then(undefined,
					err => {
						onUnexpectedError(err);
						this.setTheme(currentTheme, undefined);
					}
				);
			}, applyTheme ? 0 : 200);
		};

		const pickInstalledThemes = (activeItemId: string | undefined) => {
			const disposables = new DisposableStore();
			return new Promise<void>((s, _) => {
				let isCompleted = false;
				const autoFocusIndex = picks.findIndex(p => isItem(p) && p.id === activeItemId);
				const quickpick = disposables.add(this.quickInputService.createQuickPick<ThemeItem>({ useSeparators: true }));
				quickpick.items = picks;
				quickpick.title = this.options.title;
				quickpick.description = this.options.description;
				quickpick.placeholder = this.options.placeholderMessage;
				quickpick.activeItems = [picks[autoFocusIndex] as ThemeItem];
				quickpick.canSelectMany = false;
				quickpick.buttons = this.options.buttons ?? [];
				disposables.add(quickpick.onDidTriggerButton(button => this.options.onButton?.(button, quickpick)));
				quickpick.matchOnDescription = true;
				disposables.add(quickpick.onDidAccept(async _ => {
					isCompleted = true;
					const theme = quickpick.selectedItems[0];
					if (theme) {
						selectTheme(theme.theme, true);
					}

					quickpick.hide();
					s();
				}));
				disposables.add(quickpick.onDidChangeActive(themes => selectTheme(themes[0]?.theme, false)));
				disposables.add(quickpick.onDidHide(() => {
					if (!isCompleted) {
						selectTheme(currentTheme, true);
						s();
					}
					quickpick.dispose();
				}));
				quickpick.show();
			}).finally(() => {
				disposables.dispose();
			});
		};
		await pickInstalledThemes(currentTheme.id);
	}
}

const SelectColorThemeCommandId = 'workbench.action.selectTheme';

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: SelectColorThemeCommandId,
			title: localize2('selectTheme.label', 'Color Theme'),
			category: Categories.Preferences,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyT)
			}
		});
	}

	private getTitle(colorScheme: ColorScheme | undefined): string {
		switch (colorScheme) {
			case ColorScheme.DARK: return localize('themes.selectTheme.darkScheme', "Select Color Theme for System Dark Mode");
			case ColorScheme.LIGHT: return localize('themes.selectTheme.lightScheme', "Select Color Theme for System Light Mode");
			case ColorScheme.HIGH_CONTRAST_DARK: return localize('themes.selectTheme.darkHC', "Select Color Theme for High Contrast Dark Mode");
			case ColorScheme.HIGH_CONTRAST_LIGHT: return localize('themes.selectTheme.lightHC', "Select Color Theme for High Contrast Light Mode");
			default:
				return localize('themes.selectTheme.default', "Select Color Theme (detect system color mode disabled)");
		}
	}

	override async run(accessor: ServicesAccessor) {
		const themeService = accessor.get(IWorkbenchThemeService);
		const preferencesService = accessor.get(IPreferencesService);

		const preferredColorScheme = themeService.getPreferredColorScheme();

		const modeConfigureButton: IQuickInputButton = {
			tooltip: preferredColorScheme
				? localize('themes.configure.switchingEnabled', 'Detect system color mode enabled. Click to configure.')
				: localize('themes.configure.switchingDisabled', 'Detect system color mode disabled. Click to configure.'),
			iconClass: ThemeIcon.asClassName(Codicon.colorMode),
			location: QuickInputButtonLocation.Inline
		};

		const options = {
			placeholderMessage: this.getTitle(preferredColorScheme),
			buttons: [modeConfigureButton],
			onButton: async (_button, picker) => {
				picker.hide();
				await preferencesService.openSettings({ query: ThemeSettings.DETECT_COLOR_SCHEME });
			}
		} satisfies InstalledThemesPickerOptions;
		const setTheme = (theme: IWorkbenchTheme | undefined, settingsTarget: ThemeSettingTarget) => themeService.setColorTheme(theme as IWorkbenchColorTheme, settingsTarget);

		const instantiationService = accessor.get(IInstantiationService);
		const picker = instantiationService.createInstance(InstalledThemesPicker, options, setTheme);

		const themes = await themeService.getColorThemes();
		const currentTheme = themeService.getColorTheme();

		const lightEntries = toEntries(themes.filter(t => t.type === ColorScheme.LIGHT), localize('themes.category.light', "light themes"));
		const darkEntries = toEntries(themes.filter(t => t.type === ColorScheme.DARK), localize('themes.category.dark', "dark themes"));
		const hcEntries = toEntries(themes.filter(t => isHighContrast(t.type)), localize('themes.category.hc', "high contrast themes"));

		let picks;
		switch (preferredColorScheme) {
			case ColorScheme.DARK:
				picks = [...darkEntries, ...lightEntries, ...hcEntries];
				break;
			case ColorScheme.HIGH_CONTRAST_DARK:
			case ColorScheme.HIGH_CONTRAST_LIGHT:
				picks = [...hcEntries, ...lightEntries, ...darkEntries];
				break;
			case ColorScheme.LIGHT:
			default:
				picks = [...lightEntries, ...darkEntries, ...hcEntries];
				break;
		}
		await picker.openQuickPick(picks, currentTheme);

	}
});

const SelectFileIconThemeCommandId = 'workbench.action.selectIconTheme';

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: SelectFileIconThemeCommandId,
			title: localize2('selectIconTheme.label', 'File Icon Theme'),
			category: Categories.Preferences,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor) {
		const themeService = accessor.get(IWorkbenchThemeService);

		const options = {
			placeholderMessage: localize('themes.selectIconTheme', "Select File Icon Theme (Up/Down Keys to Preview)")
		};
		const setTheme = (theme: IWorkbenchTheme | undefined, settingsTarget: ThemeSettingTarget) => themeService.setFileIconTheme(theme as IWorkbenchFileIconTheme, settingsTarget);

		const instantiationService = accessor.get(IInstantiationService);
		const picker = instantiationService.createInstance(InstalledThemesPicker, options, setTheme);

		const picks: QuickPickInput<ThemeItem>[] = [
			{ type: 'separator', label: localize('fileIconThemeCategory', 'file icon themes') },
			{ id: '', theme: FileIconThemeData.noIconTheme, label: localize('noIconThemeLabel', 'None'), description: localize('noIconThemeDesc', 'Disable File Icons') },
			...toEntries(await themeService.getFileIconThemes()),
		];

		await picker.openQuickPick(picks, themeService.getFileIconTheme());
	}
});

const SelectProductIconThemeCommandId = 'workbench.action.selectProductIconTheme';

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: SelectProductIconThemeCommandId,
			title: localize2('selectProductIconTheme.label', 'Product Icon Theme'),
			category: Categories.Preferences,
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor) {
		const themeService = accessor.get(IWorkbenchThemeService);

		const options = {
			placeholderMessage: localize('themes.selectProductIconTheme', "Select Product Icon Theme (Up/Down Keys to Preview)")
		};
		const setTheme = (theme: IWorkbenchTheme | undefined, settingsTarget: ThemeSettingTarget) => themeService.setProductIconTheme(theme as IWorkbenchProductIconTheme, settingsTarget);

		const instantiationService = accessor.get(IInstantiationService);
		const picker = instantiationService.createInstance(InstalledThemesPicker, options, setTheme);

		const picks: QuickPickInput<ThemeItem>[] = [
			{ type: 'separator', label: localize('productIconThemeCategory', 'product icon themes') },
			{ id: DEFAULT_PRODUCT_ICON_THEME_ID, theme: ProductIconThemeData.defaultTheme, label: localize('defaultProductIconThemeLabel', 'Default') },
			...toEntries(await themeService.getProductIconThemes()),
		];

		await picker.openQuickPick(picks, themeService.getProductIconTheme());
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.tryNewDefaultThemes',
			title: localize2('tryNewDefaultThemes', "Try New Default Themes"),
			category: Categories.Preferences,
			f1: true,
		});
	}
	override async run(accessor: ServicesAccessor) {
		const themeService = accessor.get(IWorkbenchThemeService);
		const quickInputService = accessor.get(IQuickInputService);
		const configurationService = accessor.get(IConfigurationService);

		const previousTheme = themeService.getColorTheme();
		const allThemes = await themeService.getColorThemes();
		const newThemeSettingsIds = new Set([ThemeSettingDefaults.COLOR_THEME_LIGHT, ThemeSettingDefaults.COLOR_THEME_DARK]);
		const themes = allThemes.filter(t => newThemeSettingsIds.has(t.settingsId));

		const items: IQuickPickItem[] = themes.map(t => ({
			id: t.id,
			label: t.label,
			description: t.description,
		}));

		const disposables = new DisposableStore();
		const picker = disposables.add(quickInputService.createQuickPick<IQuickPickItem>());
		picker.items = items;
		picker.placeholder = localize('pickNewTheme', "Pick a new default theme");
		picker.canSelectMany = false;

		const preferredId = (previousTheme.type === ColorScheme.LIGHT || previousTheme.type === ColorScheme.HIGH_CONTRAST_LIGHT) ? ThemeSettingDefaults.COLOR_THEME_LIGHT : ThemeSettingDefaults.COLOR_THEME_DARK;
		const activeItem = items.find(i => themes.find(t => t.id === i.id)?.settingsId === preferredId);
		if (activeItem) {
			picker.activeItems = [activeItem];
		}

		disposables.add(picker.onDidChangeActive(selected => {
			if (selected[0]) {
				const theme = themes.find(t => t.id === selected[0].id);
				if (theme) {
					themeService.setColorTheme(theme, 'preview');
				}
			}
		}));

		disposables.add(picker.onDidAccept(() => {
			const selected = picker.activeItems[0];
			const theme = selected ? themes.find(t => t.id === selected.id) : undefined;

			picker.hide();

			if (!theme) {
				return;
			}

			(async () => {
				try {
					await themeService.setColorTheme(theme, 'auto');
					await configurationService.updateValue(ThemeSettings.PREFERRED_LIGHT_THEME, ThemeSettingDefaults.COLOR_THEME_LIGHT);
					await configurationService.updateValue(ThemeSettings.PREFERRED_DARK_THEME, ThemeSettingDefaults.COLOR_THEME_DARK);
				} catch (error) {
					if (!isCancellationError(error)) {
						onUnexpectedError(error);
					}
				}
			})();
		}));

		const result = new Promise<void>(resolve => {
			disposables.add(picker.onDidHide(() => {
				if (!picker.selectedItems.length) {
					themeService.setColorTheme(previousTheme, undefined);
				}
				resolve();
			}));
		}).finally(() => disposables.dispose());

		picker.show();

		return result;
	}
});

CommandsRegistry.registerCommand('workbench.action.previewColorTheme', async function (accessor: ServicesAccessor, extension: { publisher: string; name: string; version: string }, themeSettingsId?: string) {
	const themeService = accessor.get(IWorkbenchThemeService);

	let themes = findBuiltInThemes(await themeService.getColorThemes(), extension);
	if (themes.length === 0) {
		themes = await themeService.getMarketplaceColorThemes(extension.publisher, extension.name, extension.version);
	}
	for (const theme of themes) {
		if (!themeSettingsId || theme.settingsId === themeSettingsId) {
			await themeService.setColorTheme(theme, 'preview');
			return theme.settingsId;
		}
	}
	return undefined;
});

function findBuiltInThemes(themes: IWorkbenchColorTheme[], extension: { publisher: string; name: string }): IWorkbenchColorTheme[] {
	return themes.filter(({ extensionData }) => extensionData && extensionData.extensionIsBuiltin && equalsIgnoreCase(extensionData.extensionPublisher, extension.publisher) && equalsIgnoreCase(extensionData.extensionName, extension.name));
}

interface ThemeItem extends IQuickPickItem {
	readonly id: string | undefined;
	readonly theme?: IWorkbenchTheme;
	readonly label: string;
	readonly description?: string;
	readonly alwaysShow?: boolean;
}

function isItem(i: QuickPickInput<ThemeItem>): i is ThemeItem {
	// eslint-disable-next-line local/code-no-any-casts, @typescript-eslint/no-explicit-any
	return (<any>i)['type'] !== 'separator';
}

const defaultThemeDescriptions: Record<string, string> = {
	[ThemeSettingDefaults.COLOR_THEME_LIGHT]: localize('defaultLight', "Default Light"),
	[ThemeSettingDefaults.COLOR_THEME_DARK]: localize('defaultDark', "Default Dark"),
};

function toEntry(theme: IWorkbenchTheme): ThemeItem {
	const settingId = theme.settingsId ?? undefined;
	const item: ThemeItem = {
		id: theme.id,
		theme: theme,
		label: theme.label,
		description: defaultThemeDescriptions[settingId ?? ''] ?? theme.description ?? (theme.label === settingId ? undefined : settingId),
	};
	return item;
}

function toEntries(themes: Array<IWorkbenchTheme>, label?: string): QuickPickInput<ThemeItem>[] {
	const pinnedIds = new Set([ThemeSettingDefaults.COLOR_THEME_DARK, ThemeSettingDefaults.COLOR_THEME_LIGHT]);
	const sorter = (t1: ThemeItem, t2: ThemeItem) => {
		const pin1 = pinnedIds.has(t1.theme?.settingsId ?? '');
		const pin2 = pinnedIds.has(t2.theme?.settingsId ?? '');
		if (pin1 !== pin2) {
			return pin1 ? -1 : 1;
		}
		return t1.label.localeCompare(t2.label);
	};
	const entries: QuickPickInput<ThemeItem>[] = themes.map(toEntry).sort(sorter);
	if (entries.length > 0 && label) {
		entries.unshift({ type: 'separator', label });
	}
	return entries;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.generateColorTheme',
			title: localize2('generateColorTheme.label', 'Generate Color Theme From Current Settings'),
			category: Categories.Developer,
			f1: true
		});
	}

	override run(accessor: ServicesAccessor) {
		const themeService = accessor.get(IWorkbenchThemeService);

		const theme = themeService.getColorTheme();
		const colors = Registry.as<IColorRegistry>(ColorRegistryExtensions.ColorContribution).getColors();
		const colorIds = colors.filter(c => !c.deprecationMessage).map(c => c.id).sort();
		const resultingColors: { [key: string]: string | null } = {};
		const inherited: string[] = [];
		for (const colorId of colorIds) {
			const color = theme.getColor(colorId, false);
			if (color) {
				resultingColors[colorId] = Color.Format.CSS.formatHexA(color, true);
			} else {
				inherited.push(colorId);
			}
		}
		const nullDefaults = [];
		for (const id of inherited) {
			const color = theme.getColor(id);
			if (color) {
				resultingColors['__' + id] = Color.Format.CSS.formatHexA(color, true);
			} else {
				nullDefaults.push(id);
			}
		}
		for (const id of nullDefaults) {
			resultingColors['__' + id] = null;
		}
		let contents = JSON.stringify({
			'$schema': colorThemeSchemaId,
			type: theme.type,
			colors: resultingColors,
			tokenColors: theme.tokenColors.filter(t => !!t.scope)
		}, null, '\t');
		contents = contents.replace(/\"__/g, '//"');

		const editorService = accessor.get(IEditorService);
		return editorService.openEditor({ resource: undefined, contents, languageId: 'jsonc', options: { pinned: true } });
	}
});

const toggleLightDarkThemesCommandId = 'workbench.action.toggleLightDarkThemes';

registerAction2(class extends Action2 {

	constructor() {
		super({
			id: toggleLightDarkThemesCommandId,
			title: localize2('toggleLightDarkThemes.label', 'Toggle between Light/Dark Themes'),
			category: Categories.Preferences,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor) {
		const themeService = accessor.get(IWorkbenchThemeService);
		const configurationService = accessor.get(IConfigurationService);
		const notificationService = accessor.get(INotificationService);
		const preferencesService = accessor.get(IPreferencesService);

		if (configurationService.getValue(ThemeSettings.DETECT_COLOR_SCHEME)) {
			const message = localize({ key: 'cannotToggle', comment: ['{0} is a setting name'] }, "Cannot toggle between light and dark themes when `{0}` is enabled in settings.", ThemeSettings.DETECT_COLOR_SCHEME);
			notificationService.prompt(Severity.Info, message, [
				{
					label: localize('goToSetting', "Open Settings"),
					run: () => {
						return preferencesService.openUserSettings({ query: ThemeSettings.DETECT_COLOR_SCHEME });
					}
				}
			]);
			return;
		}

		const currentTheme = themeService.getColorTheme();
		let newSettingsId: string = ThemeSettings.PREFERRED_DARK_THEME;
		switch (currentTheme.type) {
			case ColorScheme.LIGHT:
				newSettingsId = ThemeSettings.PREFERRED_DARK_THEME;
				break;
			case ColorScheme.DARK:
				newSettingsId = ThemeSettings.PREFERRED_LIGHT_THEME;
				break;
			case ColorScheme.HIGH_CONTRAST_LIGHT:
				newSettingsId = ThemeSettings.PREFERRED_HC_DARK_THEME;
				break;
			case ColorScheme.HIGH_CONTRAST_DARK:
				newSettingsId = ThemeSettings.PREFERRED_HC_LIGHT_THEME;
				break;
		}

		const themeSettingId: string = configurationService.getValue(newSettingsId);

		if (themeSettingId && typeof themeSettingId === 'string') {
			const theme = (await themeService.getColorThemes()).find(t => t.settingsId === themeSettingId);
			if (theme) {
				themeService.setColorTheme(theme.id, 'auto');
			}
		}
	}
});

const ThemesSubMenu = new MenuId('ThemesSubMenu');
MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
	title: localize('themes', "Themes"),
	submenu: ThemesSubMenu,
	group: '2_configuration',
	order: 7
} satisfies ISubmenuItem);
MenuRegistry.appendMenuItem(MenuId.MenubarPreferencesMenu, {
	title: localize({ key: 'miSelectTheme', comment: ['&& denotes a mnemonic'] }, "&&Themes"),
	submenu: ThemesSubMenu,
	group: '2_configuration',
	order: 7
} satisfies ISubmenuItem);

MenuRegistry.appendMenuItem(ThemesSubMenu, {
	command: {
		id: SelectColorThemeCommandId,
		title: localize('selectTheme.label', 'Color Theme')
	},
	order: 1
});

MenuRegistry.appendMenuItem(ThemesSubMenu, {
	command: {
		id: SelectFileIconThemeCommandId,
		title: localize('themes.selectIconTheme.label', "File Icon Theme")
	},
	order: 2
});

MenuRegistry.appendMenuItem(ThemesSubMenu, {
	command: {
		id: SelectProductIconThemeCommandId,
		title: localize('themes.selectProductIconTheme.label', "Product Icon Theme")
	},
	order: 3
});
