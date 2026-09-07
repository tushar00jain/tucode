/*---------------------------------------------------------------------------------------------
 *  Platform-neutral keyboard-layout selection and mapping.
 *  Native adapters publish immutable source records; this controller owns shared behavior.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../vs/base/common/event.js';
import { Disposable } from '../vs/base/common/lifecycle.js';
import { OS } from '../vs/base/common/platform.js';
import { getKeyboardLayoutId, IKeyboardLayoutInfo, IKeyboardLayoutService, IKeyboardMapping, IMacKeyboardLayoutInfo, IMacLinuxKeyboardMapping } from '../vs/platform/keyboardLayout/common/keyboardLayout.js';
import { IKeyboardMapper } from '../vs/platform/keyboardLayout/common/keyboardMapper.js';
import { KeyboardLayoutContribution } from '../vs/workbench/services/keybinding/browser/keyboardLayouts/layout.contribution.darwin.js';
import { FallbackKeyboardMapper } from '../vs/workbench/services/keybinding/common/fallbackKeyboardMapper.js';
import { KeymapInfo } from '../vs/workbench/services/keybinding/common/keymapInfo.js';
import { MacLinuxKeyboardMapper } from '../vs/workbench/services/keybinding/common/macLinuxKeyboardMapper.js';

export interface IKeyboardInputSourceSnapshot { readonly generation: number; readonly id: string | undefined }
export interface IKeyboardInputSource {
	readonly snapshot: IKeyboardInputSourceSnapshot;
	readonly onDidChange: Event<IKeyboardInputSourceSnapshot>;
}

const NO_INPUT_SOURCE_SNAPSHOT = Object.freeze({ generation: 0, id: undefined });
export const NO_INPUT_SOURCE: IKeyboardInputSource = Object.freeze({ snapshot: NO_INPUT_SOURCE_SNAPSHOT, onDidChange: Event.None });

export function keyboardInputSourceSnapshot(generation: number, id: string | undefined): IKeyboardInputSourceSnapshot {
	if (!Number.isSafeInteger(generation) || generation < 0) { throw new Error('invalid keyboard input-source generation'); }
	return Object.freeze({ generation, id });
}

export class MacKeyboardLayoutService extends Disposable implements IKeyboardLayoutService {
	declare readonly _serviceBrand: undefined;
	private readonly _onDidChangeKeyboardLayout = this._register(new Emitter<void>());
	readonly onDidChangeKeyboardLayout: Event<void> = this._onDidChangeKeyboardLayout.event;
	private readonly keymaps = KeyboardLayoutContribution.INSTANCE.layoutInfos
		.map(info => new KeymapInfo(info.layout, info.secondaryLayouts, info.mapping, info.isUserKeyboardLayout));
	private active: KeymapInfo | undefined;
	private mapper: IKeyboardMapper | undefined;
	private generation: number;

	constructor(private readonly source: IKeyboardInputSource = NO_INPUT_SOURCE) {
		super();
		this.generation = source.snapshot.generation;
		this.active = this.match(source.snapshot.id);
		this._register(source.onDidChange(snapshot => this.accept(snapshot)));
	}
	getCurrentKeyboardLayout(): IKeyboardLayoutInfo | null { return this.active?.layout ?? null; }
	getAllKeyboardLayouts(): IKeyboardLayoutInfo[] { return this.keymaps.map(keymap => keymap.layout); }
	getRawKeyboardMapping(): IKeyboardMapping | null { return (this.active?.mapping as IKeyboardMapping | undefined) ?? null; }
	getKeyboardMapper(): IKeyboardMapper { return this.mapper ??= this.active ? createKeyboardMapper(this.active) : new FallbackKeyboardMapper(false, OS); }
	validateCurrentKeyboardMapping(): void { this.accept(this.source.snapshot); }

	private accept(snapshot: IKeyboardInputSourceSnapshot): void {
		if (snapshot.generation <= this.generation) { return; }
		const matched = this.match(snapshot.id);
		this.generation = snapshot.generation;
		if (getLayoutId(matched) === getLayoutId(this.active)) { return; }
		this.active = matched;
		this.mapper = undefined;
		this._onDidChangeKeyboardLayout.fire();
	}
	private match(id: string | undefined): KeymapInfo | undefined {
		if (!id) { return undefined; }
		return this.keymaps.find(keymap => (keymap.layout as IMacKeyboardLayoutInfo).id === id)
			?? this.keymaps.find(keymap => keymap.secondaryLayouts.some(layout => (layout as IMacKeyboardLayoutInfo).id === id));
	}
}

function getLayoutId(keymap: KeymapInfo | undefined): string | undefined { return keymap && getKeyboardLayoutId(keymap.layout); }
function createKeyboardMapper(keymap: KeymapInfo): IKeyboardMapper {
	const rawMapping = keymap.mapping;
	if (Object.keys(rawMapping).length === 0) { return new FallbackKeyboardMapper(false, OS); }
	return new MacLinuxKeyboardMapper(!!keymap.layout.isUSStandard, rawMapping as IMacLinuxKeyboardMapping, false, OS);
}
