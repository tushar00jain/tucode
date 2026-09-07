import { KeyCode } from '../../../base/common/keyCodes.js';
import { IKeyboardEvent } from '../../keybinding/common/keybinding.js';
import { IQuickNavigateConfiguration } from './quickInput.js';

/** The modifier-release rule shared by browser and projected Quick Input. */
export function isQuickNavigateRelease(configuration: IQuickNavigateConfiguration, keyboardEvent: IKeyboardEvent): boolean {
	const keyCode = keyboardEvent.keyCode;
	return configuration.keybindings.some(binding => {
		const chords = binding.getChords();
		if (chords.length !== 1) { return false; }
		if (chords[0].shiftKey && keyCode === KeyCode.Shift) {
			// Shift can also be used to navigate backwards while the trigger remains held.
			return !(keyboardEvent.ctrlKey || keyboardEvent.altKey || keyboardEvent.metaKey);
		}
		return (chords[0].altKey && keyCode === KeyCode.Alt) ||
			(chords[0].ctrlKey && keyCode === KeyCode.Ctrl) ||
			(chords[0].metaKey && keyCode === KeyCode.Meta);
	});
}
