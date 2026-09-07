// Source control: several repositories open at once, and their groups.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { REPOSITORIES } from '../lib/fixture.mjs';
import { scmGraphRepositoryPicker, scmGraphSnapshot, scmSnapshot } from '../lib/probes.mjs';

const groupOf = (repository, name) => repository.groups.find(group => group.name.toLowerCase() === name.toLowerCase());

function repositoryOf(snapshot, name) {
	const repository = snapshot.repositories.find(candidate => candidate.name === name);
	assert.ok(repository, `no repository named ${name}; the view lists ${JSON.stringify(snapshot.repositories.map(entry => entry.name))}`);
	return repository;
}

function assertGroup(repository, name, resources) {
	const group = groupOf(repository, name);
	assert.ok(group, `${repository.name} has no ${name} group; it has ${JSON.stringify(repository.groups.map(entry => entry.name))}`);
	assert.equal(group.count, resources.length, `${repository.name} / ${name} count`);
	assert.deepEqual([...group.resources].sort(), [...resources].sort(), `${repository.name} / ${name} resources`);
}

export default function registerScmSuite(context) {
	describe('source control', () => {
		it('lists every repository in the workspace at once', async () => {
			const snapshot = await scmSnapshot(context.page, { expectedRepositories: REPOSITORIES.length });
			const names = snapshot.repositories.map(repository => repository.name).sort();
			assert.deepEqual(names, [...REPOSITORIES].sort());
		});

		it('groups staged, unstaged and untracked changes', async () => {
			const snapshot = await scmSnapshot(context.page, { expectedRepositories: REPOSITORIES.length });
			const alpha = repositoryOf(snapshot, 'alpha');
			assertGroup(alpha, 'Staged Changes', ['staged.txt']);
			assertGroup(alpha, 'Changes', ['tracked.txt', 'untracked.txt']);
		});

		it('reports a conflict in the merge group', async () => {
			const snapshot = await scmSnapshot(context.page, { expectedRepositories: REPOSITORIES.length });
			assertGroup(repositoryOf(snapshot, 'beta'), 'Merge Changes', ['conflict.txt']);
		});

		it('reports an untracked-only repository', async () => {
			const snapshot = await scmSnapshot(context.page, { expectedRepositories: REPOSITORIES.length });
			assertGroup(repositoryOf(snapshot, 'gamma'), 'Changes', ['notes.md']);
		});
	});

	// The graph is read-only: no checkout, fetch, pull or publish. What it has to prove is
	// that a history provider is attached at all — the view is registered behind
	// `scm.historyProviderCount != 0`, so an absent one leaves the pane missing rather than
	// empty — and that each repository's own commits reach it.
	describe('source control graph', () => {
		// `beta` is the discriminating one: three commits were made across two branches and
		// HEAD is `main`, so a graph that walked every ref rather than HEAD would also carry
		// 'other side'.
		const EXPECTED = {
			alpha: ['alpha base'],
			beta: ['main side', 'beta base'],
			// `delta` is the Sapling fixture, and its fork and merge sit on branches HEAD is
			// not on — so the same discrimination as `beta`, one repository further.
			delta: ['delta main', 'delta base'],
			gamma: ['gamma base']
		};

		for (const repository of REPOSITORIES) {
			it(`renders ${repository}'s commits`, async () => {
				const rows = await scmGraphSnapshot(context.page, { repository });
				assert.deepEqual(rows.map(row => row.subject), EXPECTED[repository]);
				assert.ok(rows.every(row => row.graph), `every row draws its swimlanes: ${JSON.stringify(rows)}`);
			});
		}

		// **A class, not this one picker.** Any labelled toolbar action that gains a chord grows a
		// second line under its label and outgrows the 22 px header, which then clips it from the
		// top — and the picker is only drawn past one repository, which is why the fixture's four
		// are what make this assertable at all.
		it('draws the repository picker inside its header rather than half above it', async () => {
			await scmGraphSnapshot(context.page);
			const picker = await scmGraphRepositoryPicker(context.page);

			assert.equal(picker.keybindings, 0, 'the picker renders its chord as a second line under the label');
			assert.ok(picker.clippedAbove <= 0, `the picker's top ${picker.clippedAbove}px is cut off by the header`);
			assert.ok(picker.clippedBelow <= 0, `the picker's bottom ${picker.clippedBelow}px is cut off by the header`);
		});
	});
}
