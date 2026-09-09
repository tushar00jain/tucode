#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
	version: { type: 'string' },
	identity: { type: 'string', default: '-' },
	'build-number': { type: 'string', default: '1' },
	keychain: { type: 'string' },
	'notary-profile': { type: 'string' },
	'notary-keychain': { type: 'string' },
	help: { type: 'boolean' }
} });
if (values.help) {
	console.log(`Usage: node mac/release.mjs --version X.Y.Z [options]

  --identity NAME         Developer ID Application identity (default: ad-hoc, no certificate)
  --build-number N        Bundle build number (default: 1)
  --keychain PATH         Keychain containing the signing identity
  --notary-profile NAME   Notarize using credentials already stored by notarytool
  --notary-keychain PATH  Keychain containing that notarization profile

Builds for this Mac's architecture, signs ad-hoc without a personal identity, and
creates a ZIP and SHA-256 checksum under .build/macos-release/.
Notarization requires --identity. With --notary-profile, waits for Apple's acceptance,
staples and validates the ticket, then recreates the ZIP. Does not publish to GitHub.`);
	process.exit(0);
}
if (!/^\d+\.\d+\.\d+$/.test(values.version ?? '') || !/^[1-9]\d*$/.test(values['build-number']) || !values.identity) {
	throw new Error('Supply --version X.Y.Z; --build-number must be positive and --identity cannot be empty.');
}
const adHoc = values.identity === '-';
if (adHoc && (values['notary-profile'] || values.keychain)) {
	throw new Error('Ad-hoc signing uses no keychain and cannot be notarized. Supply --identity for Developer ID signing.');
}
if (values['notary-keychain'] && !values['notary-profile']) {
	throw new Error('--notary-keychain requires --notary-profile.');
}

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, '.build/macos-release');
const app = resolve(output, 'Code.app');
const executable = resolve(app, 'Contents/MacOS/Tucode');
const library = resolve(app, 'Contents/Frameworks/libtscode_mac.dylib');

function run(command, args, capture = false) {
	const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
	if (result.error) { throw result.error; }
	if (result.status !== 0) {
		throw new Error(`${command} failed (${result.status ?? result.signal})${capture ? `\n${result.stdout}${result.stderr}` : ''}`);
	}
	return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

run('/bin/sh', [resolve(import.meta.dirname, 'package.sh'), '--release', values.version, values['build-number']]);

// Catch development search paths and dependencies before signing a portable bundle.
for (const binary of [executable, library]) {
	const commands = run('/usr/bin/otool', ['-l', binary], true);
	for (const match of commands.matchAll(/cmd LC_RPATH\s+cmdsize \d+\s+path (.*?) \(offset/g)) {
		if (match[1].startsWith('/') && !match[1].startsWith('/usr/lib/')) {
			throw new Error(`Nonportable runtime search path in ${basename(binary)}: ${match[1]}`);
		}
	}
	const dependencies = run('/usr/bin/otool', ['-L', binary], true).split('\n').slice(1);
	for (const line of dependencies) {
		const dependency = line.trim().split(' (compatibility version')[0];
		if (dependency && !dependency.startsWith('/System/Library/') && !dependency.startsWith('/usr/lib/')
			&& dependency !== '@rpath/libtscode_mac.dylib') {
			throw new Error(`Unbundled dependency in ${basename(binary)}: ${dependency}`);
		}
	}
}
const architecture = run('/usr/bin/lipo', ['-archs', executable], true).trim();
if (!['arm64', 'x86_64'].includes(architecture)
	|| run('/usr/bin/lipo', ['-archs', library], true).trim() !== architecture) {
	throw new Error('Expected matching, single-architecture Swift and Rust binaries.');
}

const signing = ['--force', '--sign', values.identity,
	...(adHoc ? ['--timestamp=none'] : ['--timestamp', '--options', 'runtime'])];
if (values.keychain) { signing.push('--keychain', values.keychain); }
for (const binary of [library, app]) { run('/usr/bin/codesign', [...signing, binary]); }
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
const signature = run('/usr/bin/codesign', ['--display', '--verbose=4', app], true);
if (adHoc && (!signature.includes('Signature=adhoc') || signature.includes('Authority='))) {
	throw new Error('Expected an ad-hoc signature without a certificate identity.');
}
if (!adHoc && !signature.includes('Authority=Developer ID Application:')) {
	throw new Error('The supplied identity must be a Developer ID Application certificate for direct distribution.');
}

const archive = resolve(output, `tucode-v${values.version}-macos-${architecture}.zip`);
function zip() { run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive]); }
zip();
if (values['notary-profile']) {
	const credentials = ['--keychain-profile', values['notary-profile']];
	if (values['notary-keychain']) { credentials.push('--keychain', values['notary-keychain']); }
	console.log('Submitting to Apple and waiting for notarization…');
	const result = spawnSync('/usr/bin/xcrun', ['notarytool', 'submit', archive, ...credentials, '--wait', '--output-format', 'json'],
		{ cwd: root, encoding: 'utf8' });
	if (result.error) { throw result.error; }
	writeFileSync(resolve(output, 'notarization.json'), result.stdout ?? '');
	if (result.stderr) { process.stderr.write(result.stderr); }
	let submission;
	try { submission = JSON.parse(result.stdout); } catch {
		throw new Error(`notarytool failed (${result.status}); see its output above and ${output}/notarization.json.`);
	}
	if (result.status !== 0 || submission.status !== 'Accepted') {
		throw new Error(`Notarization ${submission.status}; submission ${submission.id}. Use notarytool log with that ID and your profile to inspect the rejection.`);
	}
	run('/usr/bin/xcrun', ['stapler', 'staple', app]);
	run('/usr/bin/xcrun', ['stapler', 'validate', app]);
	run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', app]);
	zip();
}
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) { hash.update(chunk); }
writeFileSync(`${archive}.sha256`, `${hash.digest('hex')}  ${basename(archive)}\n`);
console.log(`\n${adHoc ? 'Ad-hoc signed (no certificate, not notarized)' : values['notary-profile'] ? 'Signed and notarized' : 'Signed (notarization not requested)'}:\n${archive}\n${archive}.sha256`);
