// The end-to-end suite for the editor app. One generated workspace, one app, one launch.
//
// Run it with `npm run e2e` against a freshly built app; the harness refuses to
// run against a binary older than the sources it was built from.

import { BULK_RESULT_COUNT, createFixture, NEEDLES } from './lib/fixture.mjs';
import { WARM_SEARCH_TIMEOUT, warmSearch } from './lib/probes.mjs';
import { registerSession } from './lib/session.mjs';
import registerEditorSuite from './suites/editor.mjs';
import registerKeyboardSuite from './suites/keyboard.mjs';
import registerMarkdownPreviewSuite from './suites/markdownPreview.mjs';
import registerQuickOpenSuite from './suites/quickopen.mjs';
import registerSaplingSuite from './suites/sapling.mjs';
import registerScmSuite from './suites/scm.mjs';
import registerSearchSuite from './suites/search.mjs';
import registerViewRootFilterSuite from './suites/viewRootFilter.mjs';
import registerWorkspaceSuite from './suites/workspace.mjs';

const context = { app: undefined, page: undefined, fixture: undefined };

registerSession(context, {
	binary: 'tscode',
	// `TSCODE_E2E_PORT` moves this run's ports off another machine-mate's. A run that finds the port
	// already taken now refuses to launch at all rather than attaching to whatever holds it — the
	// port is a machine-wide address, and what answers on it used to be assumed to be this run's app.
	port: Number(process.env.TSCODE_E2E_PORT ?? 9432),
	createFixture,
	openTimeout: WARM_SEARCH_TIMEOUT,
	open: async (app, fixture) => {
		await app.clearWorkbenchState();
		await app.openFolder(fixture.root);
		// One query over the whole corpus before any step asserts, because the first read of each
		// file by this binary costs a millisecond every later read does not — `WARM_SEARCH_TIMEOUT`
		// is where that is measured and named. Paid here, it is a boot cost; left where it fell, it
		// was a forty-second text search that every search step then timed out against.
		await warmSearch(app.page, NEEDLES.bulk, BULK_RESULT_COUNT);
	}
});

registerWorkspaceSuite(context);
registerQuickOpenSuite(context);
registerSearchSuite(context);
registerEditorSuite(context);
registerMarkdownPreviewSuite(context);
registerScmSuite(context);
registerSaplingSuite(context);
// The keyboard model last: its steps move the keyboard between every pane and leave folders folded
// and boxes closed behind them, which is a state no earlier suite should have to start from.
registerKeyboardSuite(context);
registerViewRootFilterSuite(context);
