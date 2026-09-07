// Launching the built app and attaching to its WebView2 over CDP.
//
// The window is created by the Rust process, never by playwright, so the only
// way in is to start the app with WebView2's debugging port enabled and connect
// to it. Everything the suite needs from the app's lifecycle lives here: launch,
// connect, console capture, workspace switching, cache clearing, and a teardown
// that kills the app and the processes it started.
//
// **Nothing here may reach an application this module did not start**, and the thing that decides
// that is the WebView2 user-data folder. One folder is one browser process however many
// applications are using it, and Tauri forces every build of this app onto the same one — so
// without `WEBVIEW2_USER_DATA_FOLDER`, which the app now honours for exactly this reason, a run
// shares a process with any other copy of the app that is open, and a teardown reaches through it
// into somebody's editor. That is what closed one, twice, and no kill discipline on this side could
// have prevented it: the process was genuinely a child of the app this module spawned.
//
// So isolation is *read* rather than assumed — `assertOwnBrowser` fails the run unless the app's
// browser process is serving this run's own folder — the kill is an enumerated list of process ids
// rather than `taskkill /T`, and the attach refuses a port something else already holds, a port the
// spawned process does not own, and a browser that answers with more than one page.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

import { PROFILES, REPO_ROOT, readyExe } from './exe.mjs';
import { EXIT_TIMEOUT, POLL, READ_TIMEOUT, STEP_TIMEOUT, delay, timedOut, waitFor } from './wait.mjs';

/** The localStorage key `TauriWorkspaceProvider` carries the workspace in. */
const WORKSPACE_KEY = 'tscode.workspace';

/** The prefix of the workbench's own IndexedDB databases. */
const WORKBENCH_DB_PREFIX = 'vscode-web-';

/**
 * Where the workbench keeps user settings, relative to the user data directory
 * `TSCODE_USER_DATA_DIR` points the app at. That override is the only thing
 * standing between a run and the developer's own `settings.json`, so every
 * launch sets it — see `launchApp`.
 */
const SETTINGS_FILE = 'settings.json';

const WORKBENCH = '.monaco-workbench';

/** WebView2's browser process, which is what a user-data folder is shared *through*. */
const WEBVIEW_PROCESS = 'msedgewebview2.exe';

/**
 * What a boot is allowed to take. A cold WebView2 first-run is the slow case and it is seconds,
 * so this is a few times the worst case rather than the tool's maximum — `wait.mjs`'s note on why
 * a bound only detects a hang when it is near what the thing should take.
 */
const BOOT_TIMEOUT_MS = STEP_TIMEOUT;

/** What attaching to the debugging port is allowed to take: the app has to start and open it. */
const CONNECT_TIMEOUT_MS = STEP_TIMEOUT;

/**
 * Where a driven window is put, as `TSCODE_WINDOW_POSITION`'s `"<x>,<y>"`.
 *
 * The window is real and it used to open on top of whatever the person running the suite was
 * doing, stealing the keyboard several times a run. It stays real: WebView2 has no headless
 * embedding mode, and hidden or minimised would throttle its rendering — which this suite reads
 * geometry out of. So it is moved somewhere no monitor is, where it lays out and paints exactly as
 * it would in front of you. `TSCODE_E2E_WINDOW_POSITION=screen` puts it back, for a run somebody
 * wants to watch.
 */
const OFFSCREEN = '-4000,-4000';

function windowPosition() {
	const requested = process.env.TSCODE_E2E_WINDOW_POSITION ?? OFFSCREEN;

	return requested === 'screen' ? {} : { TSCODE_WINDOW_POSITION: requested };
}

/** Every process this module started, so an aborted run cannot leave orphans. */
const started = new Set();

/**
 * Kills `pid` and everything descended from it, **as an enumerated list of process ids**.
 *
 * Not `taskkill /T`: the tree Windows walks there is every process whose parent id is in it, and a
 * process id is reused — so `/T` will follow an id back to a stranger that inherited it, and a
 * WebView2 browser process shared with another application is exactly the stranger that would be.
 * `descendantsOf` is the same walk with the one restriction that makes the list this module's own:
 * a child that started before its parent is not one. What is not on that list is not killed, and a
 * process this run leaked is reported by `close()` rather than swept up by a wider kill.
 */
function killTree(pid) {
	if (pid === undefined) {
		return;
	}
	if (process.platform === 'win32') {
		// A process table this run cannot read narrows the kill to the one process it is certain of,
		// and never widens it: whatever that leaves behind is what `close()` reports as a survivor.
		let tree = [pid];
		try {
			tree = [...descendantsOf(pid).map(entry => entry.pid), pid];
		} catch { /* reported as survivors below */ }
		spawnSync('taskkill', [...tree.flatMap(entry => ['/PID', String(entry)]), '/F'], { stdio: 'ignore' });
	} else {
		try {
			process.kill(-pid, 'SIGKILL');
		} catch {
			try {
				process.kill(pid, 'SIGKILL');
			} catch { /* already gone */ }
		}
	}
	started.delete(pid);
}

for (const signal of ['exit', 'SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		for (const pid of [...started]) {
			killTree(pid);
		}
	});
}

/**
 * Every live process as `{ pid, ppid, startedAt, name }`, where a larger
 * `startedAt` means later.
 *
 * Real parentage, not a name match: what the app owns is whatever descends from
 * it, and a terminal's shell is exactly that. `wmic` is gone from current Windows
 * builds, so the process table comes from CIM.
 */
function processTable() {
	const [command, args] = process.platform === 'win32'
		? ['powershell', ['-NoProfile', '-NonInteractive', '-Command',
			'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.Ticks) $($_.Name)" }']]
		// `etimes` is seconds since start, so the older process has the larger one.
		: ['ps', ['-eo', 'pid=,ppid=,etimes=,comm=']];
	const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
	if (result.status !== 0) {
		throw new Error(`could not read the process table with ${command} (${result.status}): ${result.stderr}`);
	}
	const sign = process.platform === 'win32' ? 1 : -1;
	return result.stdout.split(/\r?\n/).flatMap(line => {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*\S)\s*$/.exec(line);
		return match
			? [{ pid: Number(match[1]), ppid: Number(match[2]), startedAt: sign * Number(match[3]), name: match[4] }]
			: [];
	});
}

/**
 * The processes descended from `pid`, itself excluded. Reads as `{ pid, name }`
 * so a failure can name what survived rather than only count it.
 *
 * A child that started *before* its recorded parent is not one: Windows reuses
 * process ids, so a long-dead parent's id can be the app's, and the stranger that
 * still names it would otherwise be reported as a leak.
 */
function descendantsOf(pid) {
	const table = processTable();
	const byParent = new Map();
	for (const entry of table) {
		byParent.set(entry.ppid, [...byParent.get(entry.ppid) ?? [], entry]);
	}
	const found = [];
	const frontier = table.filter(entry => entry.pid === pid);
	while (frontier.length > 0) {
		const parent = frontier.pop();
		for (const child of byParent.get(parent.pid) ?? []) {
			if (child.startedAt >= parent.startedAt) {
				found.push({ pid: child.pid, name: child.name });
				frontier.push(child);
			}
		}
	}
	return found;
}

/**
 * Every listening TCP socket as `{ port, pid }`.
 *
 * Read whole rather than queried one port at a time, because "nothing holds that port" and "the
 * query failed" come back the same way from both platforms' tools — and a guard that cannot tell
 * those apart is a guard that silently stops guarding. A machine always listens on something, so
 * an empty table is the failure rather than an answer.
 */
function listeningSockets() {
	const [command, args] = process.platform === 'win32'
		? ['powershell', ['-NoProfile', '-NonInteractive', '-Command',
			'Get-NetTCPConnection -State Listen | ForEach-Object { "$($_.LocalPort) $($_.OwningProcess)" }']]
		: ['lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']];
	const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
	const pattern = process.platform === 'win32'
		? /^\s*(\d+)\s+(\d+)\s*$/
		: /^\S+\s+(\d+)\s+.*:(\d+)\s+\(LISTEN\)\s*$/;
	const sockets = (result.stdout ?? '').split(/\r?\n/).flatMap(line => {
		const match = pattern.exec(line);
		if (!match) {
			return [];
		}
		const [port, pid] = process.platform === 'win32' ? [match[1], match[2]] : [match[2], match[1]];
		return [{ port: Number(port), pid: Number(pid) }];
	});
	if (sockets.length === 0) {
		throw new Error(`could not read the listening sockets with ${command} (${result.status}): ${result.stderr}`);
	}
	return sockets;
}

/** What holds `port`, as `{ pid, name }`, or nothing when it is free. */
function portOwner(port) {
	const socket = listeningSockets().find(entry => entry.port === port);
	if (!socket) {
		return undefined;
	}
	return { pid: socket.pid, name: processTable().find(entry => entry.pid === socket.pid)?.name ?? '(gone)' };
}

/** The command line `pid` was started with, or nothing when it is already gone. */
function commandLineOf(pid) {
	const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
		`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: 'utf8' });
	const line = result.stdout?.trim();
	return line ? line : undefined;
}

/**
 * The WebView2 browser process the app started, proved to be serving *this run's* user-data folder.
 *
 * The folder is the whole of the isolation. WebView2 serves every client of one folder from a
 * single browser process, and Tauri forces that folder to `<local app data>/<identifier>` for every
 * build of the app at once — so a build that does not honour `WEBVIEW2_USER_DATA_FOLDER` shares a
 * process with the editor somebody is working in, and teardown reaches through it into their
 * window. `--user-data-dir` on the browser process is where the answer is legible, so it is read
 * rather than assumed.
 */
function assertOwnBrowser(pid, webviewDir, exe) {
	const browser = descendantsOf(pid).find(entry => entry.name.toLowerCase() === WEBVIEW_PROCESS);
	const commandLine = browser && commandLineOf(browser.pid);
	// The generated directory name rather than the whole path: it is unique to this run either way,
	// and a path that has been through a canonicalization on the way to a command line is still the
	// same one.
	if (!commandLine?.toLowerCase().includes(basename(webviewDir).toLowerCase())) {
		throw new Error(
			`${exe.binary} (pid ${pid}) is not serving its own WebView2 user-data folder.\n` +
			`  wanted: a ${WEBVIEW_PROCESS} of its own under ${webviewDir}\n` +
			`  found:  ${browser ? `pid ${browser.pid} started with ${commandLine}` : `no ${WEBVIEW_PROCESS} descended from it, so it joined another application's`}\n` +
			`This build does not honour WEBVIEW2_USER_DATA_FOLDER, so it shares one browser process — and one ` +
			`teardown — with every other copy of the app running. Rebuild it (${PROFILES[exe.profile].build}) and run again.`
		);
	}
}

/**
 * Waits for a set of processes to be gone, and answers with those that are not. The wait is the
 * whole point of the bound: a survivor is a leak, and a leak that is merely slow to die is not one.
 */
async function waitForExit(processes, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	let survivors = processes;
	while (survivors.length > 0 && Date.now() < deadline) {
		const live = new Set(processTable().map(entry => entry.pid));
		survivors = survivors.filter(entry => live.has(entry.pid));
		if (survivors.length > 0) {
			await delay(POLL * 10);
		}
	}
	return survivors;
}

async function connectWithRetry(port, child, output) {
	// The app dying before its port opens is the failure, not a slow start — so it is what ends the
	// wait, rather than something the bound eventually notices.
	const died = () => child.exitCode === null
		? undefined
		: `the app exited with code ${child.exitCode} before its debugging port opened.\n` +
		`An orphaned tscode.exe or msedgewebview2.exe from an earlier run holds the WebView2 ` +
		`user-data folder and produces HRESULT(0x8007139F) here.\n--- app output ---\n${output.join('')}`;
	return waitFor(
		() => chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => undefined),
		{
			what: `no CDP endpoint on port ${port}.\n--- app output ---\n${output.join('')}`,
			timeoutMs: CONNECT_TIMEOUT_MS,
			poll: POLL * 10,
			alive: died
		}
	);
}

/**
 * Starts one of the two applications, attaches to its page, and returns the handle
 * the probes and suites drive. Always pair with `app.close()`.
 */
export async function launchApp({ repoRoot = REPO_ROOT, binary = 'tscode', port = 9432, log = () => { }, exe = readyExe(repoRoot, binary, log) } = {}) {

	// Before the spawn, because a port something else already holds is not a slow start: whatever
	// answers on it would be attached to and driven, and the app has not even been started yet.
	const holder = portOwner(port);
	if (holder) {
		throw new Error(
			`port ${port} is already open before ${exe.binary} was started, so a process this run did not spawn is serving it ` +
			`(pid ${holder.pid}, ${holder.name}).\n` +
			`Attaching would drive that application's window. Close it, or move this run with TSCODE_E2E_PORT. Nothing was killed.`
		);
	}

	// **The per-run WebView2 user-data folder is the isolation, not a tidiness measure.** One folder
	// is one browser process however many applications are using it, so a run that shared the app's
	// default folder would share a process — and a teardown — with any other copy of the app that is
	// running, including the editor somebody is working in. The app honours this variable for that
	// reason and `assertOwnBrowser` proves the build under test does.
	const webviewDir = mkdtempSync(join(tmpdir(), 'tscode-e2e-webview-'));
	// And a per-run workbench user data directory, because the app's own is the
	// developer's `settings.json` — a suite that seeded settings there would
	// overwrite the settings of whoever ran it.
	const userDataDir = mkdtempSync(join(tmpdir(), 'tscode-e2e-userdata-'));
	const output = [];
	const child = spawn(exe.path, [], {
		env: {
			...process.env,
			WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`,
			WEBVIEW2_USER_DATA_FOLDER: webviewDir,
			TSCODE_USER_DATA_DIR: userDataDir,
			...windowPosition()
		},
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: process.platform !== 'win32'
	});
	started.add(child.pid);
	child.stdout.on('data', chunk => output.push(String(chunk)));
	child.stderr.on('data', chunk => output.push(String(chunk)));

	// **A launch that throws has to take the app with it.** Everything below has spawned a process
	// and may have attached to it, and neither is anything the caller can be handed to close — so a
	// failed boot left an app running and a CDP socket open, and the run could not exit. `node --test`
	// then reported the boot's failure and hung, which is the shape `PLAN` §3.5 calls a defect rather
	// than slow work: the whole suite failed in ten seconds and took the tool's bound to say so.
	// By the process ids this run started, and only those: the user's editor runs under the same name.
	try {
		return await attach();
	} catch (error) {
		killTree(child.pid);
		throw error;
	}

	async function attach() {
		const browser = await connectWithRetry(port, child, output);

		// The folder, and so the browser process, is WebView2's — there is nothing to prove where the
		// webview is WebKitGTK's, which gets a data directory per process either way.
		if (process.platform === 'win32') {
			assertOwnBrowser(child.pid, webviewDir, exe);
		}

		// The port was free a moment ago, so what answers on it should be that same browser process.
		// Anything else opened the port while this app was booting, and it is not this run's to drive.
		const owner = portOwner(port);
		if (!owner || (owner.pid !== child.pid && !descendantsOf(child.pid).some(entry => entry.pid === owner.pid))) {
			throw new Error(
				`port ${port} is served by ${owner ? `pid ${owner.pid} (${owner.name})` : 'a process that has already gone'}, ` +
				`which ${exe.binary} (pid ${child.pid}) does not own — so the CDP endpoint on it belongs to another application.`
			);
		}

		// One window is launched, so one page is what the browser may answer with. More than one
		// means the browser process is shared — a second client joined it after the port opened —
		// and *which* of them is this run's is exactly what cannot be told from here.
		const pages = await waitFor(
			() => {
				const open = browser.contexts().flatMap(context => context.pages()).filter(candidate => !candidate.url().startsWith('devtools://'));
				return open.length > 0 ? open : undefined;
			},
			{ what: 'connected over CDP but the app served no page', timeoutMs: CONNECT_TIMEOUT_MS, poll: POLL * 10 }
		);
		if (pages.length > 1) {
			throw new Error(
				`port ${port} serves ${pages.length} pages (${pages.map(candidate => candidate.url()).join(', ')}), ` +
				`so the WebView2 browser process ${exe.binary} (pid ${child.pid}) started is shared with another client. ` +
				`Driving either window would be a guess, and closing this one would close both.`
			);
		}
		const [page] = pages;

		// **The bound `wait.mjs` puts on its own waits, applied to playwright's.** `waitForSelector`
		// and `waitForFunction` are wrapped there and take the bound as an argument;
		// `locator().click()`, `page.$$` and `page.$` are not wrapped and still carried playwright's
		// 30 s default — past `--test-timeout`, so one of them wedging reports as node's silence over
		// a whole step rather than as the read that never came back. One call closes the class,
		// because every unwrapped call reads the same default.
		page.setDefaultTimeout(READ_TIMEOUT);

		const consoleErrors = [];
		page.on('console', message => {
			if (message.type() === 'error') {
				consoleErrors.push(message.text());
			}
		});
		page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));

		// An app that dies mid-run reaches every probe after it as playwright's "Target page,
		// context or browser has been closed" — which names neither the process that went away
		// nor what it printed on the way out, and leaves the teardown reporting an app that owned
		// no processes. So the exit is announced where it happens, with the output that until now
		// was only ever printed when the launch itself failed.
		let closing = false;
		/** @type {{ code: number | null, signal: string | null } | undefined} */
		let exit;
		child.on('exit', (code, signal) => {
			exit = { code, signal };
			if (closing) {
				return;
			}
			log(`the app exited on its own with code ${code}${signal ? ` on ${signal}` : ''}`);
			log(`--- app output ---\n${output.join('')}`);
		});

		// **The clipboard read, which the app cannot grant itself.** WebView2 leaves
		// `clipboard-read` at `prompt` on a fresh profile and never answers the request it raises,
		// so `navigator.clipboard.readText()` neither resolves nor rejects and every paste that
		// goes through a *command* — the terminal's — stops at its first `await`. Granting it here
		// is `Browser.grantPermissions`, the thing a user's own profile has once they have answered
		// the prompt, and it is what lets a paste be asserted at all. It does not fix the app:
		// `TODO.md` carries the host-side permission decision that would.
		await browser.contexts()[0]?.grantPermissions(['clipboard-read', 'clipboard-write']).catch(error => {
			log(`could not grant the clipboard permissions: ${error.message}`);
		});

		// A workbench that never mounts has already said why in the console, and the
		// bare selector timeout would throw that away.
		try {
			await page.waitForSelector(WORKBENCH, { timeout: BOOT_TIMEOUT_MS });
		} catch (error) {
			throw new Error(
				`${exe.binary} never mounted ${WORKBENCH} at ${page.url()}: ${error.message}\n` +
				`--- console ---\n${[...new Set(consoleErrors)].join('\n')}\n` +
				`--- app output ---\n${output.join('')}`
			);
		}

		const app = {
			page,
			exe,
			consoleErrors,
			appOutput: output,

			/**
			 * Drops the workbench's persisted storage. Without this the icon theme's
			 * cached stylesheet survives across boots and serves resource URLs from
			 * wherever the *previous* build stood, which reads as a 404 on the icon font.
			 */
			async clearWorkbenchState() {
				const cleared = await page.evaluate(async prefix => {
					const databases = await indexedDB.databases();
					const names = databases.map(entry => entry.name).filter(name => name?.startsWith(prefix));
					await Promise.all(names.map(name => new Promise(resolve => {
						const request = indexedDB.deleteDatabase(name);
						request.onsuccess = request.onerror = request.onblocked = () => resolve();
					})));
					localStorage.clear();
					return names;
				}, WORKBENCH_DB_PREFIX);
				log(`cleared workbench state: ${cleared.join(', ') || '(no databases)'}`);
				return cleared;
			},

			/** Reboots the window and waits for the workbench to come back up. */
			async reload() {
				await page.reload();
				await page.waitForSelector(WORKBENCH, { timeout: BOOT_TIMEOUT_MS });
			},

			/**
			 * Replaces the user settings the next boot will read. Only the workbench
			 * itself writes this file, so a whole-file replacement is what a settings
			 * edit is; it takes effect on the next `reload()`.
			 */
			async writeUserSettings(settings) {
				writeFileSync(join(userDataDir, SETTINGS_FILE), `${JSON.stringify(settings, undefined, '\t')}\n`);
				log(`user settings ${Object.keys(settings).join(', ')}`);
			},

			/**
			 * The path `TauriWorkspaceProvider.open` itself takes — persist the folder
			 * and reload. The native folder picker in front of it cannot be driven.
			 */
			async openFolder(folder) {
				const folderUri = pathToFileURL(folder).href;
				await page.evaluate(([key, value]) => localStorage.setItem(key, value), [WORKSPACE_KEY, JSON.stringify({ folderUri })]);
				await this.reload();
				await page.waitForFunction(
					() => document.querySelectorAll('.explorer-folders-view .monaco-list-row').length > 0,
					undefined,
					{ timeout: BOOT_TIMEOUT_MS }
				);
				log(`workspace ${folderUri}`);
				return folderUri;
			},

			/** Everything the app process currently owns, shells included. */
			descendants() {
				return descendantsOf(child.pid);
			},

			/**
			 * Kills the app and everything under it, and reports what was still running
			 * when the kill went out and what outlived it. A survivor is never benign: an
			 * orphaned `msedgewebview2.exe` holds the WebView2 user-data folder, and a
			 * leaked shell is the same failure one level down.
			 *
			 * `exit` is set only when the app went away before this was called — a run whose
			 * assertions were made against an application that was no longer there.
			 *
			 * @returns {Promise<{ owned: { pid: number, name: string }[], survivors: { pid: number, name: string }[], exit?: { code: number | null, signal: string | null } }>}
			 */
			async close() {
				// Before the kill: once the app is gone, so is the parentage that says
				// which processes were its.
				const owned = descendantsOf(child.pid);
				const died = exit;
				closing = true;
				// Bounded, and by PID below: a CDP close against an app that is already on its way out
				// can never answer, and a teardown that waits forever on it is exactly the shape where a
				// finished run and a wedged one look the same.
				const closed = browser.close().catch(() => { /* the app may already be gone */ });
				if (await timedOut(closed, EXIT_TIMEOUT)) {
					log(`the CDP connection did not close within ${EXIT_TIMEOUT} ms; killing anyway`);
				}
				killTree(child.pid);
				const survivors = await waitForExit(owned, EXIT_TIMEOUT);
				for (const directory of [webviewDir, userDataDir]) {
					rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
				}
				return { owned, survivors, exit: died };
			}
		};
		return app;
	}
}
