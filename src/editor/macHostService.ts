import { Emitter, Event } from '../vs/base/common/event.js';
import { Schemas } from '../vs/base/common/network.js';
import { invoke } from './nativeTransport.js';
import { IOpenEmptyWindowOptions, IOpenWindowOptions, isFolderToOpen, IWindowOpenable } from '../vs/platform/window/common/window.js';
import { IHostService } from '../vs/workbench/services/host/browser/host.js';
import { IConfigurationService } from '../vs/platform/configuration/common/configuration.js';

const focusChanged = new Emitter<boolean>();
let focused = false;

export function setMacWindowFocus(value: boolean): void {
	if (focused !== value) { focused = value; focusChanged.fire(value); }
}

export function createMacHostService(configuration: IConfigurationService): IHostService {
	return new Proxy({
		_serviceBrand: undefined,
		onDidChangeFocus: focusChanged.event,
		onDidChangeActiveWindow: Event.None,
		onDidChangeFullScreen: Event.None,
		get hasFocus() { return focused; },
		hadLastFocus: async () => focused,
		focus: async () => { await invoke('mac_focus_window'); },
		moveTop: async () => { await invoke('mac_focus_window'); },
		async openWindow(toOpen: IWindowOpenable[] | IOpenEmptyWindowOptions = [], options?: IOpenWindowOptions): Promise<void> {
			if (!Array.isArray(toOpen) || !toOpen.length || options?.forceReuseWindow ||
				!toOpen.every(item => isFolderToOpen(item) && item.folderUri.scheme === Schemas.file)) {
				throw new Error('The Mac host currently opens local folders in new windows only');
			}
			await invoke('mac_open_folders', {
				folders: toOpen.filter(isFolderToOpen).map(item => item.folderUri.fsPath),
				nativeTabs: configuration.getValue<boolean>('window.nativeTabs') === true
			});
		}
	} as unknown as IHostService, {
		get(target, property) {
			if (property in target) { return target[property as keyof IHostService]; }
			throw new Error(`IHostService.${String(property)} is not available in the editor-only Mac surface`);
		}
	});
}
