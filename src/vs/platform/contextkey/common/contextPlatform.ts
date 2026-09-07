/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { isMacintosh, isWeb as isWebRuntime } from '../../../base/common/platform.js';

export * from '../../../base/common/platform.js';

// Context keys describe the application host. The Mac shell uses a browser runtime
// internally, but its menus and user keybindings need the native desktop contexts.
// Detect its bridge before context expressions fold platform keys into constants.
const nativeMacHost = isMacintosh && typeof (globalThis as {
	webkit?: { messageHandlers?: { tucodeNative?: { postMessage?: unknown } } };
}).webkit?.messageHandlers?.tucodeNative?.postMessage === 'function';

export const isWeb = isWebRuntime && !nativeMacHost;
