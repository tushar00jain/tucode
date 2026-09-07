import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../../src/vs/base/node/browserGlobals.js';
import { Emitter } from '../../src/vs/base/common/event.js';
import { DisposableStore } from '../../src/vs/base/common/lifecycle.js';
import { extUri } from '../../src/vs/base/common/resources.js';
import { URI } from '../../src/vs/base/common/uri.js';
import { DecorationsService } from '../../src/vs/workbench/services/decorations/browser/decorationsService.js';
import { IDecorationData } from '../../src/vs/workbench/services/decorations/common/decorations.js';

test('native decoration badge text shares upstream ordering, updates and icon/bubble precedence', () => {
	const store = new DisposableStore();
	const file = URI.file('/fixture/folder/file.txt');
	const changes = store.add(new Emitter<readonly URI[]>());
	let decoration: IDecorationData = { letter: 'M', weight: 1, bubble: true };
	const service = store.add(new DecorationsService({ extUri } as never, {
		getColorTheme: () => ({ getColor: () => undefined })
	} as never));
	store.add(service.registerDecorationsProvider({ label: 'Git', onDidChange: changes.event,
		provideDecorations: uri => uri.toString() === file.toString() ? decoration : undefined }));
	const read = () => store.add(service.getDecoration(file, false)!);
	try {
		const initial = read();
		assert.equal(initial.badgeText, 'M');
		assert.equal(read().badgeText, 'M', 'cached rules must retain their literal badge');
		const additional = service.registerDecorationsProvider({ label: 'Other', onDidChange: changes.event,
			provideDecorations: uri => uri.toString() === file.toString() ? { letter: 'A', weight: 2 } : undefined });
		assert.equal(read().badgeText, 'A, M', 'native text must use the browser rule precedence');
		additional.dispose();
		decoration = { letter: 'U', bubble: true }; changes.fire([file]);
		assert.equal(read().badgeText, 'U');
		assert.equal(initial.badgeText, 'M', 'a new decoration must not mutate retained paint');
		assert.equal(store.add(service.getDecoration(URI.file('/fixture/folder'), true)!).badgeText, undefined,
			'a folder bubble must not claim its child file status');
		decoration = { letter: { id: 'unregistered-test-icon' } }; changes.fire([file]);
		assert.equal(read().badgeText, undefined, 'an icon badge must not become text');
	} finally { store.dispose(); }
});
