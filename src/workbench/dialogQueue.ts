/*---------------------------------------------------------------------------------------------
 *  `DialogHandlerContribution`'s dialog queue loop.
 *
 *  The seam is upstream's and is not moved: `DialogService` — registered by `boot.ts` — pushes onto
 *  `DialogsModel` and waits, and whoever handles the model closes the item with a result. This is
 *  upstream's contribution minus the About arm and the lazy handler: one dialog at a time, in the
 *  order the model queued them, each closed with its result or with the error that came out of
 *  showing it.
 *
 *  The presentation handler is a constructor argument so the queue remains independent of its quick-pick
 *  presentation. Upstream starts this as a workbench contribution; each frontend starts it here.
 *
 *  There is no About arm, and reaching one is a caller asking for a dialog this
 *  fork has never had — so it throws rather than closing the item with nothing.
 *
 *  Upstream counterpart: src/vs/workbench/browser/parts/dialogs/dialogHandler.ts, src/vs/workbench/browser/parts/dialogs/dialog.web.contribution.ts
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../vs/base/common/lifecycle.js';
import { localize } from '../vs/nls.js';
import {
	IAsyncPromptResult, IConfirmation, IConfirmationResult, IDialogResult, IDialogService, IInput,
	IInputResult, IPrompt
} from '../vs/platform/dialogs/common/dialogs.js';
import { IDialogsModel, IDialogViewItem } from '../vs/workbench/common/dialogs.js';
import { DialogService } from '../vs/workbench/services/dialogs/common/dialogService.js';

/**
 * The three arms a queued dialog can take, which is `AbstractDialogHandler`'s surface minus the
 * About one.
 */
export interface IQueuedDialogHandler {
	confirm(confirmation: IConfirmation): Promise<IConfirmationResult>;
	input(input: IInput): Promise<IInputResult>;
	prompt<T>(prompt: IPrompt<T>): Promise<IAsyncPromptResult<T>>;
}

export class DialogQueue extends Disposable {

	private readonly model: IDialogsModel;

	private currentDialog: IDialogViewItem | undefined;

	constructor(private readonly handler: IQueuedDialogHandler, dialogService: IDialogService) {
		super();

		this.model = (dialogService as DialogService).model;

		this._register(this.model.onWillShowDialog(() => {
			if (!this.currentDialog) {
				void this.processDialogs();
			}
		}));

		void this.processDialogs();
	}

	private async processDialogs(): Promise<void> {
		while (this.model.dialogs.length) {
			this.currentDialog = this.model.dialogs[0];

			let result: IDialogResult | Error | undefined = undefined;
			try {
				if (this.currentDialog.args.confirmArgs) {
					result = await this.handler.confirm(this.currentDialog.args.confirmArgs.confirmation);
				} else if (this.currentDialog.args.inputArgs) {
					result = await this.handler.input(this.currentDialog.args.inputArgs.input);
				} else if (this.currentDialog.args.promptArgs) {
					result = await this.handler.prompt(this.currentDialog.args.promptArgs.prompt);
				} else {
					throw new Error(localize('tscode.noAboutDialog', "There is no About dialog in this fork."));
				}
			} catch (error) {
				result = error as Error;
			}

			this.currentDialog.close(result);
			this.currentDialog = undefined;
		}
	}
}
