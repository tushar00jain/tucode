// The end-to-end entry for the source control watcher. One git repository, one app, one launch.
//
// A session of its own, and the reason is the same one the terminal entry has: what it needs from
// the machine is not what the editor entry's window is. This one **commits into its repository and
// writes into it continuously**, and the editor fixture's repositories are what four suites assert
// working sets, graphs and Sapling smartlogs against — a commit in one of them would be a state
// every later suite inherits, and adding a fifth repository would move constants three suites read.
// The trade is one more launch, a few seconds on a run that takes minutes.
//
// Run it with `npm run e2e` against a freshly built app; the harness refuses to run against a
// binary older than the sources it was built from.

import { createScmWatcherFixture } from './lib/fixture.mjs';
import { registerSession } from './lib/session.mjs';
import registerScmWatcherSuite from './suites/scmWatcher.mjs';

const context = { app: undefined, page: undefined, fixture: undefined };

registerSession(context, {
	binary: 'tscode',
	// Two past the editor entry point's, so none of the three sessions contends for another's port —
	// and off the same `TSCODE_E2E_PORT`, so moving one run off a machine-mate's ports moves all of
	// them.
	port: Number(process.env.TSCODE_E2E_PORT ?? 9432) + 2,
	createFixture: createScmWatcherFixture,
	open: async (app, fixture) => {
		await app.clearWorkbenchState();
		await app.openFolder(fixture.root);
	}
});

registerScmWatcherSuite(context);
