/*---------------------------------------------------------------------------------------------
 *  tscode does not ship ML language detection.
 *
 *  Upstream's only implementation resolves a TensorFlow.js library, a model and its weights
 *  through `FileAccess.asBrowserUri`, which throws in a bundle. "Detection off" is a state
 *  upstream supports on its own — it is the `workbench.editor.languageDetection` setting —
 *  so this service reports exactly that, and a file's language comes from its extension the
 *  way it does for every file with one. What is absent is content-based guessing for
 *  untitled and extensionless files.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { ILanguageDetectionService } from '../common/languageDetectionWorkerService.js';

export class NullLanguageDetectionService implements ILanguageDetectionService {

	declare readonly _serviceBrand: undefined;

	isEnabledForLanguage(_languageId: string): boolean {
		return false;
	}

	async detectLanguage(_resource: URI, _supportedLangs?: string[]): Promise<string | undefined> {
		return undefined;
	}
}
