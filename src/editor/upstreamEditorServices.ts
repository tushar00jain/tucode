/*---------------------------------------------------------------------------------------------
 * Editor lifecycle registrations shared by the terminal and native frontends.
 *--------------------------------------------------------------------------------------------*/

import '../vs/workbench/browser/parts/editor/editorParts.js';
import '../vs/workbench/browser/workbench.contribution.js';
import '../vs/workbench/services/editor/browser/editorService.js';
import '../vs/workbench/services/textfile/common/textEditorService.js';
import '../vs/workbench/services/untitled/common/untitledTextEditorService.js';
import '../vs/workbench/services/editor/common/customEditorLabelService.js';
import '../vs/workbench/services/outline/browser/outlineService.js';
import '../vs/workbench/services/preferences/browser/preferencesService.js';
import '../vs/workbench/services/configuration/common/jsonEditingService.js';
import '../vs/workbench/services/url/browser/urlService.js';

import { Registry } from '../vs/platform/registry/common/platform.js';
import { EditorExtensions, IEditorFactoryRegistry } from '../vs/workbench/common/editor.js';
import { FileEditorInput } from '../vs/workbench/contrib/files/browser/editors/fileEditorInput.js';
import { registerSingleton, InstantiationType } from '../vs/platform/instantiation/common/extensions.js';
import { IMarkerDecorationsService } from '../vs/editor/common/services/markerDecorations.js';
import { MarkerDecorationsService } from '../vs/editor/common/services/markerDecorationsService.js';
import { AccessibilitySignalService, IAccessibilitySignalService } from '../vs/platform/accessibilitySignal/browser/accessibilitySignalService.js';

registerSingleton(IMarkerDecorationsService, MarkerDecorationsService, InstantiationType.Delayed);
registerSingleton(IAccessibilitySignalService, AccessibilitySignalService, InstantiationType.Delayed);

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerFileEditorFactory({
	typeId: 'workbench.editors.files.fileEditorInput',
	createFileEditor: (resource, preferredResource, preferredName, preferredDescription, preferredEncoding, preferredLanguageId, preferredContents, instantiationService) =>
		instantiationService.createInstance(FileEditorInput, resource, preferredResource, preferredName, preferredDescription, preferredEncoding, preferredLanguageId, preferredContents),
	isFileEditor: (input): input is FileEditorInput => input instanceof FileEditorInput
});
