import { Disposable } from '../../vs/base/common/lifecycle.js';
import { EditorOptions } from '../../vs/editor/common/config/editorOptions.js';
import { MonospaceLineBreaksComputerFactory } from '../../vs/editor/common/viewModel/monospaceLineBreaksComputer.js';
import type { ITextLayoutBackend, ITextLayoutBackendFactory, ITextLayoutRequest } from '../../editor/textLayout.js';
import { CellEditorConfiguration } from './cellEditorConfiguration.js';

function gutterColumns(lineCount: number): number {
	return String(Math.max(1, lineCount)).length + 2;
}

class CellTextLayoutBackend extends Disposable implements ITextLayoutBackend {
	readonly configuration: CellEditorConfiguration;
	readonly lineBreaksComputerFactory = new MonospaceLineBreaksComputerFactory(
		EditorOptions.wordWrapBreakBeforeCharacters.defaultValue,
		EditorOptions.wordWrapBreakAfterCharacters.defaultValue
	);

	constructor(request: Readonly<ITextLayoutRequest>) {
		super();
		this.configuration = this._register(new CellEditorConfiguration(request.width, 0));
		this.update(request);
	}

	update(request: Readonly<ITextLayoutRequest>): void {
		this.configuration.layout(request.width, 0);
		this.configuration.updateOptions(request.wrap ? {
			wordWrap: 'wordWrapColumn',
			wordWrapColumn: Math.max(1, request.width - gutterColumns(request.modelLineCount))
		} : { wordWrap: 'off' });
	}
}

/** The TUI's only implementation of the shared text-layout contract. */
export class CellTextLayoutBackendFactory implements ITextLayoutBackendFactory {
	readonly metricsId = 'terminal-cell-v1';
	readonly initialWidth = 80;
	readonly initialVisibleRows = 40;
	create(request: Readonly<ITextLayoutRequest>): ITextLayoutBackend {
		return new CellTextLayoutBackend(request);
	}
}
