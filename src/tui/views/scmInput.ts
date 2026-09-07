/*---------------------------------------------------------------------------------------------
 * Commit input transport for the upstream SCM view. SCMInputWidget constructs CodeEditorWidget,
 * which requires unavailable code-editor services and canvas font measurements. This supplies
 * its input contract with upstream InputBox over the terminal DOM; ISCMInput remains the model.
 * Upstream counterpart: src/vs/workbench/contrib/scm/browser/scmInput.ts
 *--------------------------------------------------------------------------------------------*/

import { InputBox } from '../../vs/base/browser/ui/inputbox/inputBox.js';
import { Event } from '../../vs/base/common/event.js';
import { Disposable, DisposableStore } from '../../vs/base/common/lifecycle.js';
import { IContextKeyService } from '../../vs/platform/contextkey/common/contextkey.js';
import { IContextViewService } from '../../vs/platform/contextview/browser/contextView.js';
import { defaultInputBoxStyles } from '../../vs/platform/theme/browser/defaultStyles.js';
import type { ISCMInput } from '../../vs/workbench/contrib/scm/common/scm.js';
import type { ISCMInputWidget } from '../../vs/workbench/contrib/scm/browser/scmViewPane.js';
import type { Selection } from '../../vs/editor/common/core/selection.js';

export class TerminalSCMInput extends Disposable implements ISCMInputWidget {
	readonly onDidChangeContentHeight = Event.None;
	selections: Selection[] | null = null;
	private readonly box: InputBox;
	private readonly inputDisposables = this._register(new DisposableStore());
	private readonly repository;
	private model: ISCMInput | undefined;

	constructor(container: HTMLElement,
		@IContextViewService contextViewService: IContextViewService,
		@IContextKeyService contextKeyService: IContextKeyService
	) {
		super();
		const scoped = this._register(contextKeyService.createScoped(container));
		this.repository = scoped.createKey<string | undefined>('scmRepository', undefined);
		this.box = this._register(new InputBox(container, contextViewService, { inputBoxStyles: defaultInputBoxStyles }));
		this._register(this.box.onDidChange(value => {
			if (this.model?.enabled) { this.model.setValue(value, true); }
			else if (this.model) { this.box.value = this.model.value; }
		}));
	}

	get input(): ISCMInput | undefined { return this.model; }
	set input(input: ISCMInput | undefined) {
		this.inputDisposables.clear();
		this.model = input;
		this.repository.set(input?.repository.id);
		if (input) {
			this.box.value = input.value;
			this.box.setPlaceHolder(input.placeholder);
			const enable = () => input.enabled ? this.box.enable() : this.box.disable();
			enable();
			this.inputDisposables.add(input.onDidChangeEnablement(enable));
			this.inputDisposables.add(input.onDidChangeFocus(() => this.focus()));
			this.inputDisposables.add(input.onDidChange(({ value }) => { this.box.value = value; }));
			this.inputDisposables.add(input.onDidChangePlaceholder(value => this.box.setPlaceHolder(value)));
		}
	}

	focus(): void { this.box.focus(); }
	hasFocus(): boolean { return this.box.hasFocus(); }
	getContentHeight(): number { return 26; }
	layout(): void { this.box.layout(); }
	clearValidation(): void { this.box.hideMessage(); }
}
