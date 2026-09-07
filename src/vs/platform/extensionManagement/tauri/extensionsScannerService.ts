/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { IEnvironmentService } from '../../environment/common/environment.js';
import { IExtensionsProfileScannerService } from '../common/extensionsProfileScannerService.js';
import { IExtensionsScannerService, NativeExtensionsScannerService, } from '../common/extensionsScannerService.js';
import { IFileService } from '../../files/common/files.js';
import { IInstantiationService } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IProductService } from '../../product/common/productService.js';
import { IUriIdentityService } from '../../uriIdentity/common/uriIdentity.js';
import { IUserDataProfilesService } from '../../userDataProfile/common/userDataProfile.js';

/**
 * The bundled theme and grammar extensions, relative to the app resource
 * directory. There is no `INativeEnvironmentService` to ask, so the resource
 * directory is resolved at boot and passed in. The `resources/` segment is the
 * bundle target `tauri.conf.json` maps `resources/extensions` to, which the
 * Tauri CLI reproduces next to the binary under `tauri dev` as well.
 */
const BUILTIN_EXTENSIONS_PATH = 'resources/extensions';

/** The user-installed extensions folder under the user data home. */
const USER_EXTENSIONS_FOLDER = 'extensions';

export class TauriExtensionsScannerService extends NativeExtensionsScannerService implements IExtensionsScannerService {

	constructor(
		appResourceLocation: URI,
		@IUserDataProfilesService userDataProfilesService: IUserDataProfilesService,
		@IExtensionsProfileScannerService extensionsProfileScannerService: IExtensionsProfileScannerService,
		@IFileService fileService: IFileService,
		@ILogService logService: ILogService,
		@IEnvironmentService environmentService: IEnvironmentService,
		@IProductService productService: IProductService,
		@IUriIdentityService uriIdentityService: IUriIdentityService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(
			joinPath(appResourceLocation, BUILTIN_EXTENSIONS_PATH),
			joinPath(environmentService.userRoamingDataHome, USER_EXTENSIONS_FOLDER),
			environmentService.userRoamingDataHome,
			userDataProfilesService.defaultProfile,
			userDataProfilesService, extensionsProfileScannerService, fileService, logService, environmentService, productService, uriIdentityService, instantiationService);
	}

}
