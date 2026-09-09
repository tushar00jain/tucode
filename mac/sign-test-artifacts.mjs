import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const identity = 'Automation Signing';
const keychain = resolve(homedir(), 'Library/Keychains/Automation.keychain-db');
const app = resolve(root, '.build/macos/Code.app');
const runner = resolve(root, '.build/xcui/DerivedData/Build/Products/Debug/TucodeMacUITests-Runner.app');
const backendLibrary = resolve(app, 'Contents/Frameworks/libtscode_mac.dylib');
const testBundle = resolve(runner, 'Contents/PlugIns/TucodeMacUITests.xctest');

function codesign(args) {
	const result = spawnSync('/usr/bin/codesign', args, { encoding: 'utf8' });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().replaceAll(keychain, '<dedicated-keychain>');
		throw new Error(`codesign failed${detail ? `: ${detail}` : ''}`);
	}
	return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

for (const artifact of [backendLibrary, app, runner, testBundle]) {
	if (!existsSync(artifact)) throw new Error(`required test artifact is missing: ${artifact}`);
}

for (const artifact of [backendLibrary, testBundle, app, runner]) {
	codesign(['--force', '--keychain', keychain, '--sign', identity, '--timestamp=none',
		'--preserve-metadata=entitlements,flags', artifact]);
}

for (const artifact of [backendLibrary, testBundle, app, runner]) {
	codesign(['--verify', '--strict', artifact]);
	const details = codesign(['--display', '--verbose=4', artifact]);
	if (!details.includes(`Authority=${identity}`) || details.includes('Signature=adhoc')) {
		throw new Error(`test artifact does not have the stable ${identity} identity: ${artifact}`);
	}
}

console.log(`Signed Code.app and its XCUI runner with ${identity}.`);
