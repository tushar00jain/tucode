/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Barrier } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import Severity from '../../../../base/common/severity.js';
import { IExtensionsScannerService, toExtensionDescription } from '../../../../platform/extensionManagement/common/extensionsScannerService.js';
import { ExtensionIdentifier, ExtensionIdentifierMap, IExtension, IExtensionContributions, IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { ExtensionHostKind } from '../common/extensionHostKind.js';
import { ExtensionActivationReason, ExtensionPointContribution, IExtensionInspectInfo, IExtensionService, IExtensionsStatus, IMessage, IResponsiveStateChangeEvent, IWillActivateEvent, WillStopExtensionHostsEvent } from '../common/extensions.js';
import { ExtensionMessageCollector, ExtensionPoint, ExtensionsRegistry, IExtensionPoint, IExtensionPointUser } from '../common/extensionsRegistry.js';

const hasOwnProperty = Object.hasOwnProperty;

/**
 * An `IExtensionService` that publishes the scanned extension manifests into
 * the `ExtensionsRegistry` extension points — themes, grammars and languages —
 * and stops there. Nothing is ever activated: there is no extension host, no
 * `main` is loaded, and no activation event reaches any code.
 *
 * Only the bundled system extensions are scanned. tscode has no gallery and no
 * extension management, so the user extensions folder and the profile's
 * `extensions.json` never exist, let alone hold anything.
 */
export class CatalogueExtensionService extends Disposable implements IExtensionService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidRegisterExtensions = this._register(new Emitter<void>());
	readonly onDidRegisterExtensions = this._onDidRegisterExtensions.event;

	private readonly _onDidChangeExtensionsStatus = this._register(new Emitter<ExtensionIdentifier[]>());
	readonly onDidChangeExtensionsStatus = this._onDidChangeExtensionsStatus.event;

	private readonly _onDidChangeExtensions = this._register(new Emitter<{ readonly added: readonly IExtensionDescription[]; readonly removed: readonly IExtensionDescription[] }>());
	readonly onDidChangeExtensions = this._onDidChangeExtensions.event;

	// Nothing is ever activated, so none of these can ever fire.
	readonly onWillActivateByEvent: Event<IWillActivateEvent> = Event.None;
	readonly onDidChangeResponsiveChange: Event<IResponsiveStateChangeEvent> = Event.None;
	readonly onWillStop: Event<WillStopExtensionHostsEvent> = Event.None;

	private readonly _registry = new ExtensionIdentifierMap<IExtensionDescription>();
	private readonly _status = new ExtensionIdentifierMap<IExtensionsStatus>();
	private readonly _installedExtensionsReady = new Barrier();

	private _extensions: readonly IExtensionDescription[] = [];
	get extensions(): readonly IExtensionDescription[] { return this._extensions; }

	constructor(
		@IExtensionsScannerService private readonly extensionsScannerService: IExtensionsScannerService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._scanExtensions();
	}

	private async _scanExtensions(): Promise<void> {
		let extensions: IExtensionDescription[] = [];
		try {
			const scanned = await this.extensionsScannerService.scanSystemExtensions({});
			extensions = scanned.map(extension => toExtensionDescription(extension, false));
		} catch (error) {
			this.logService.error('CatalogueExtensionService: failed to scan extensions', error);
		}

		for (const extension of extensions) {
			this._registry.set(extension.identifier, extension);
		}
		this._extensions = extensions;

		this._handleExtensionPoints(extensions);

		this._installedExtensionsReady.open();
		this._onDidChangeExtensions.fire({ added: extensions, removed: [] });
		this._onDidRegisterExtensions.fire();
	}

	private _handleExtensionPoints(affectedExtensions: readonly IExtensionDescription[]): void {
		const affectedExtensionPoints: { [extPointName: string]: boolean } = Object.create(null);
		for (const extensionDescription of affectedExtensions) {
			if (extensionDescription.contributes) {
				for (const extPointName in extensionDescription.contributes) {
					if (hasOwnProperty.call(extensionDescription.contributes, extPointName)) {
						affectedExtensionPoints[extPointName] = true;
					}
				}
			}
		}

		const messageHandler = (msg: IMessage) => this._handleExtensionPointMessage(msg);
		for (const extensionPoint of ExtensionsRegistry.getExtensionPoints()) {
			if (affectedExtensionPoints[extensionPoint.name]) {
				CatalogueExtensionService._handleExtensionPoint(extensionPoint, affectedExtensions, messageHandler);
			}
		}
	}

	private static _handleExtensionPoint<T extends IExtensionContributions[keyof IExtensionContributions]>(extensionPoint: ExtensionPoint<T>, availableExtensions: readonly IExtensionDescription[], messageHandler: (msg: IMessage) => void): void {
		const users: IExtensionPointUser<T>[] = [];
		for (const desc of availableExtensions) {
			if (desc.contributes && hasOwnProperty.call(desc.contributes, extensionPoint.name)) {
				users.push({
					description: desc,
					value: desc.contributes[extensionPoint.name as keyof typeof desc.contributes] as T,
					collector: new ExtensionMessageCollector(messageHandler, desc, extensionPoint.name)
				});
			}
		}
		extensionPoint.acceptUsers(users);
	}

	private _handleExtensionPointMessage(msg: IMessage): void {
		const status = this._getOrCreateExtensionStatus(msg.extensionId);
		status.messages.push(msg);

		const strMsg = `[${msg.extensionId.value}]: ${msg.message}`;
		if (msg.type === Severity.Error) {
			this.logService.error(strMsg);
		} else if (msg.type === Severity.Warning) {
			this.logService.warn(strMsg);
		} else {
			this.logService.info(strMsg);
		}

		this._onDidChangeExtensionsStatus.fire([msg.extensionId]);
	}

	private _getOrCreateExtensionStatus(extensionId: ExtensionIdentifier): IExtensionsStatus {
		let status = this._status.get(extensionId);
		if (!status) {
			status = {
				id: extensionId,
				messages: [],
				activationStarted: false,
				activationTimes: undefined,
				runtimeErrors: [],
				runningLocation: null
			};
			this._status.set(extensionId, status);
		}
		return status;
	}

	//#region Catalogue

	whenInstalledExtensionsRegistered(): Promise<boolean> {
		return this._installedExtensionsReady.wait();
	}

	async getExtension(id: string): Promise<IExtensionDescription | undefined> {
		await this._installedExtensionsReady.wait();

		return this._registry.get(id);
	}

	async readExtensionPointContributions<T extends IExtensionContributions[keyof IExtensionContributions]>(extPoint: IExtensionPoint<T>): Promise<ExtensionPointContribution<T>[]> {
		await this._installedExtensionsReady.wait();

		const result: ExtensionPointContribution<T>[] = [];
		for (const desc of this._extensions) {
			if (desc.contributes && hasOwnProperty.call(desc.contributes, extPoint.name)) {
				result.push(new ExtensionPointContribution<T>(desc, desc.contributes[extPoint.name as keyof typeof desc.contributes] as T));
			}
		}
		return result;
	}

	getExtensionsStatus(): { [id: string]: IExtensionsStatus } {
		const result: { [id: string]: IExtensionsStatus } = Object.create(null);
		for (const status of this._status.values()) {
			result[status.id.value] = status;
		}
		return result;
	}

	//#endregion

	//#region Activation — there is nothing to activate

	/**
	 * Resolves once the catalogue is published. Callers use this to sequence
	 * against the extension points being handled; no code is ever run.
	 */
	async activateByEvent(activationEvent: string): Promise<void> {
		await this._installedExtensionsReady.wait();
	}

	activateById(extensionId: ExtensionIdentifier, reason: ExtensionActivationReason): Promise<void> {
		return Promise.reject(new Error(`Cannot activate ${extensionId.value}: tscode has no extension host.`));
	}

	activationEventIsDone(activationEvent: string): boolean {
		return this._installedExtensionsReady.isOpen();
	}

	canAddExtension(extension: IExtensionDescription): boolean {
		return false;
	}

	canRemoveExtension(extension: IExtensionDescription): boolean {
		return false;
	}

	async getInspectPorts(extensionHostKind: ExtensionHostKind, tryEnableInspector: boolean): Promise<IExtensionInspectInfo[]> {
		return [];
	}

	async stopExtensionHosts(reason: string, auto?: boolean): Promise<boolean> {
		return true;
	}

	async startExtensionHosts(updates?: { readonly toAdd: readonly IExtension[]; readonly toRemove: readonly string[] }): Promise<void> {
		// no extension host to start
	}

	setRemoteEnvironment(env: { [key: string]: string | null }): Promise<void> {
		return Promise.reject(new Error('Cannot set the remote environment: tscode has no extension host.'));
	}

	//#endregion
}
