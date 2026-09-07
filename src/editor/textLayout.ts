import type { IDisposable } from '../vs/base/common/lifecycle.js';
import type { IEditorConfiguration } from '../vs/editor/common/config/editorConfiguration.js';
import type { ILineBreaksComputerFactory } from '../vs/editor/common/modelLineProjectionData.js';

/** Geometry supplied by a frontend to the shared text semantics. Units are identified by metricsId. */
export interface ITextLayoutRequest {
	readonly width: number;
	readonly wrap: boolean;
	readonly modelLineCount: number;
}

/**
 * The frontend-owned geometry implementation used by the shared ViewModel. A terminal supplies a
 * cell backend; a DOM/native frontend may supply measured font and pixel geometry instead.
 */
export interface ITextLayoutBackend extends IDisposable {
	readonly configuration: IEditorConfiguration;
	readonly lineBreaksComputerFactory: ILineBreaksComputerFactory;
	update(request: Readonly<ITextLayoutRequest>): void;
}

export interface ITextLayoutBackendFactory {
	readonly metricsId: string;
	readonly initialWidth: number;
	readonly initialVisibleRows: number;
	create(request: Readonly<ITextLayoutRequest>): ITextLayoutBackend;
}
