/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * tscode ships English only and runs no NLS build step, so there is no message
 * bundle to look a key up in: `localize` formats the message it is handed. The
 * exported shape is upstream's, since the copied tree imports it verbatim.
 */

export function getNLSMessages(): string[] {
	return [];
}

export function getNLSLanguage(): string | undefined {
	return undefined;
}

export interface ILocalizeInfo {
	key: string;
	comment: string[];
}

export interface ILocalizedString {
	original: string;
	value: string;
}

function _format(message: string, args: (string | number | boolean | undefined | null)[]): string {
	if (args.length === 0) {
		return message;
	}

	return message.replace(/\{(\d+)\}/g, (match, rest) => {
		const index = rest[0];
		const arg = args[index];
		let result = match;
		if (typeof arg === 'string') {
			result = arg;
		} else if (typeof arg === 'number' || typeof arg === 'boolean' || arg === void 0 || arg === null) {
			result = String(arg);
		}
		return result;
	});
}

/**
 * Marks a string to be localized. Returns the localized string.
 *
 * @param info The {@linkcode ILocalizeInfo} which describes the id and comments associated with the localized string.
 * @param message The string to localize
 * @param args The arguments to the string
 *
 * @note `message` can contain `{n}` notation where it is replaced by the nth value in `...args`
 * @example `localize({ key: 'sayHello', comment: ['Welcomes user'] }, 'hello {0}', name)`
 *
 * @returns string The localized string.
 */
export function localize(info: ILocalizeInfo, message: string, ...args: (string | number | boolean | undefined | null)[]): string;

/**
 * Marks a string to be localized. Returns the localized string.
 *
 * @param key The key to use for localizing the string
 * @param message The string to localize
 * @param args The arguments to the string
 *
 * @note `message` can contain `{n}` notation where it is replaced by the nth value in `...args`
 * @example For example, `localize('sayHello', 'hello {0}', name)`
 *
 * @returns string The localized string.
 */
export function localize(key: string, message: string, ...args: (string | number | boolean | undefined | null)[]): string;

export function localize(data: ILocalizeInfo | string, message: string, ...args: (string | number | boolean | undefined | null)[]): string {
	return _format(message, args);
}

/**
 * Marks a string to be localized. Returns an {@linkcode ILocalizedString}
 * which contains the localized string and the original string.
 *
 * @param info The {@linkcode ILocalizeInfo} which describes the id and comments associated with the localized string.
 * @param message The string to localize
 * @param args The arguments to the string
 *
 * @note `message` can contain `{n}` notation where it is replaced by the nth value in `...args`
 * @example `localize2({ key: 'sayHello', comment: ['Welcomes user'] }, 'hello {0}', name)`
 *
 * @returns ILocalizedString which contains the localized string and the original string.
 */
export function localize2(info: ILocalizeInfo, message: string, ...args: (string | number | boolean | undefined | null)[]): ILocalizedString;

/**
 * Marks a string to be localized. Returns an {@linkcode ILocalizedString}
 * which contains the localized string and the original string.
 *
 * @param key The key to use for localizing the string
 * @param message The string to localize
 * @param args The arguments to the string
 *
 * @note `message` can contain `{n}` notation where it is replaced by the nth value in `...args`
 * @example `localize('sayHello', 'hello {0}', name)`
 *
 * @returns ILocalizedString which contains the localized string and the original string.
 */
export function localize2(key: string, message: string, ...args: (string | number | boolean | undefined | null)[]): ILocalizedString;

export function localize2(data: ILocalizeInfo | string, originalMessage: string, ...args: (string | number | boolean | undefined | null)[]): ILocalizedString {
	const value = _format(originalMessage, args);

	return { value, original: value };
}

export interface INLSLanguagePackConfiguration {

	/**
	 * The path to the translations config file that contains pointers to
	 * all message bundles for `main` and extensions.
	 */
	readonly translationsConfigFile: string;

	/**
	 * The path to the file containing the translations for this language
	 * pack as flat string array.
	 */
	readonly messagesFile: string;

	/**
	 * The path to the file that can be used to signal a corrupt language
	 * pack, for example when reading the `messagesFile` fails. This will
	 * instruct the application to re-create the cache on next startup.
	 */
	readonly corruptMarkerFile: string;
}

export interface INLSConfiguration {

	/**
	 * Locale as defined in `argv.json` or `app.getLocale()`.
	 */
	readonly userLocale: string;

	/**
	 * Locale as defined by the OS (e.g. `app.getPreferredSystemLanguages()`).
	 */
	readonly osLocale: string;

	/**
	 * The actual language of the UI that ends up being used considering `userLocale`
	 * and `osLocale`.
	 */
	readonly resolvedLanguage: string;

	/**
	 * Defined if a language pack is used that is not the
	 * default english language pack. This requires a language
	 * pack to be installed as extension.
	 */
	readonly languagePack?: INLSLanguagePackConfiguration;

	/**
	 * The path to the file containing the default english messages
	 * as flat string array. The file is only present in built
	 * versions of the application.
	 */
	readonly defaultMessagesFile: string;

	/**
	 * Below properties are deprecated and only there to continue support
	 * for `vscode-nls` module that depends on them.
	 * Refs https://github.com/microsoft/vscode-nls/blob/main/src/node/main.ts#L36-L46
	 */
	/** @deprecated */
	readonly locale: string;
	/** @deprecated */
	readonly availableLanguages: Record<string, string>;
}
