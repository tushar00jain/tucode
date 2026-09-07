/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Declare types that we probe for to implement util and/or polyfill functions

declare global {

	// --- idle callbacks

	interface IdleDeadline {
		readonly didTimeout: boolean;
		timeRemaining(): number;
	}

	function requestIdleCallback(callback: (args: IdleDeadline) => void, options?: { timeout: number }): number;
	function cancelIdleCallback(handle: number): void;


	// --- timeout / interval (available in all contexts, but different signatures in node.js vs web)

	// Upstream declares these itself because it builds for the browser and for node.js off one
	// tree, and neither `lib`'s handle type is right for both. This fork only runs on node, so
	// `@types/node`'s globals are the right ones and re-declaring them only produced a second,
	// incompatible `Timeout`. `NodeJS.Timeout` is an object type, so it still prevents the direct
	// number assignment the `TimeoutHandle` brand existed to prevent.
	type TimeoutHandle = NodeJS.Timeout;
	type Timeout = NodeJS.Timeout;


	// --- error

	interface ErrorConstructor {
		captureStackTrace(targetObject: object, constructorOpt?: Function): void;
		stackTraceLimit: number;
	}
}

export { }
