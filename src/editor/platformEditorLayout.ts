/*---------------------------------------------------------------------------------------------
 * Mechanical layout supplied to upstream editor parts by a single platform surface.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../vs/base/common/event.js';
import { Disposable } from '../vs/base/common/lifecycle.js';
import { ILayoutService } from '../vs/platform/layout/browser/layoutService.js';
import { Parts, Position } from '../vs/workbench/services/layout/browser/layoutService.js';

export class PlatformEditorLayout implements ILayoutService {
	declare readonly _serviceBrand: undefined;
	readonly onDidLayoutMainContainer = Event.None;
	readonly onDidLayoutActiveContainer = Event.None;
	readonly onDidLayoutContainer = Event.None;
	readonly onDidChangeActiveContainer = Event.None;
	readonly onDidAddContainer = Event.None;
	readonly onDidChangePartVisibility = Event.None;
	readonly mainContainerOffset = { top: 0, quickPickTop: 0 };
	readonly activeContainerOffset = { top: 0, quickPickTop: 0 };
	readonly whenRestored = Promise.resolve();
	constructor(readonly mainContainer: HTMLElement) { }
	get activeContainer(): HTMLElement { return this.mainContainer; }
	get containers(): Iterable<HTMLElement> { return [this.mainContainer]; }
	get mainContainerDimension() { return { width: this.mainContainer.clientWidth, height: this.mainContainer.clientHeight }; }
	get activeContainerDimension() { return this.mainContainerDimension; }
	getContainer(): HTMLElement { return this.mainContainer; }
	isRestored(): boolean { return true; }
	whenContainerStylesLoaded(): undefined { return undefined; }
	focus(): void { this.mainContainer.focus(); }
	registerPart(): typeof Disposable.None { return Disposable.None; }
	getMaximumEditorDimensions() { return this.mainContainerDimension; }
	getPanelAlignment(): 'center' { return 'center'; }
	getPanelPosition(): Position { return Position.BOTTOM; }
	getSideBarPosition(): Position { return Position.LEFT; }
	isFloatingPanelsEnabled(): boolean { return false; }
	isVisible(part: Parts): boolean { return part === Parts.EDITOR_PART; }
}
