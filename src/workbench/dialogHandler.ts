/*---------------------------------------------------------------------------------------------
 * Existing dialog presentation through IQuickInputService, used by both frontends.
 * VS Code's DialogsModel owns pending requests; AbstractDialogHandler supplies button/result
 * semantics. This presenter retains the existing single-field, no-checkbox limitations.
 * Upstream counterpart: src/vs/workbench/browser/parts/dialogs/dialogHandler.ts
 *--------------------------------------------------------------------------------------------*/

import {
	AbstractDialogHandler, IAsyncPromptResult, IConfirmation, IConfirmationResult, IDialogService,
	IInput, IInputResult, IPrompt
} from '../vs/platform/dialogs/common/dialogs.js';
import { IQuickInputService, IQuickPickItem } from '../vs/platform/quickinput/common/quickInput.js';
import { DialogQueue } from './dialogQueue.js';

/** One button, as the pick that stands for it. */
type IButtonPick = IQuickPickItem & { index: number };

export class QuickInputDialogHandler extends AbstractDialogHandler {

	constructor(private readonly quickInputService: IQuickInputService) {
		super();
	}

	async confirm(confirmation: IConfirmation): Promise<IConfirmationResult> {
		const buttons = this.getConfirmationButtons(confirmation);
		const button = await this.doShow(confirmation.message, buttons, confirmation.detail, buttons.length - 1);

		return { confirmed: button === 0, checkboxChecked: undefined };
	}

	async prompt<T>(prompt: IPrompt<T>): Promise<IAsyncPromptResult<T>> {
		const buttons = this.getPromptButtons(prompt);
		const button = await this.doShow(prompt.message, buttons, prompt.detail, prompt.cancelButton ? buttons.length - 1 : -1);

		return this.getPromptResult(prompt, button, undefined);
	}

	/**
	 * One field, which is what the quick input's own box is. `Dialog` lays out as many as `inputs`
	 * has and a terminal has room for the one; a caller that wants two is asking for a form.
	 */
	async input(input: IInput): Promise<IInputResult> {
		if (input.inputs.length !== 1) {
			throw new Error(`IDialogService.input with ${input.inputs.length} fields is not available in tucode: the box takes one.`);
		}

		const value = await this.quickInputService.input({
			title: input.message,
			prompt: input.detail,
			value: input.inputs[0].value,
			placeHolder: input.inputs[0].placeholder,
			password: input.inputs[0].type === 'password'
		});

		return { confirmed: value !== undefined, checkboxChecked: undefined, values: value === undefined ? undefined : [value] };
	}

	async about(): Promise<void> {
		throw new Error('IDialogService.about is not available in tucode: there is no About dialog.');
	}

	/**
	 * The buttons as picks, in `AbstractDialogHandler`'s order — the default first and the cancel
	 * last — and the index the user chose. Escaping is `cancelId`, which is the same answer
	 * `Dialog` gives when its close action runs.
	 */
	private async doShow(message: string, buttons: string[], detail: string | undefined, cancelId: number): Promise<number> {
		const picks: IButtonPick[] = buttons.map((label, index) => ({ label: label.replace(/&&/g, ''), index }));
		const picked = await this.quickInputService.pick<IButtonPick>(picks, {
			title: message,
			prompt: detail,
			hideInput: true
		});

		return picked?.index ?? cancelId;
	}
}

/** Presents the head of the existing VS Code dialog model using the platform's picker. */
export class QuickInputDialogs extends DialogQueue {

	constructor(
		@IDialogService dialogService: IDialogService,
		@IQuickInputService quickInputService: IQuickInputService
	) {
		super(new QuickInputDialogHandler(quickInputService), dialogService);
	}
}
