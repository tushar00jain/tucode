// Both repositories use this generator configuration unchanged. Detect the shipped frontends.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function documentation(root) {
	const project = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name;
	const terminal = existsSync(join(root, 'src/tui/workbench/workbench.ts'));
	const pages = terminal ? [{ name: 'Terminal', file: 'terminal.html', root: 'src/main.ts',
		comparisons: [{ upstream: 'win', ours: 'linux' }, { upstream: 'mac', ours: 'linux' }] }]
		: [{ name: project, file: 'keys.html', root: 'src/main.ts',
			comparisons: [{ upstream: 'win', ours: 'win' }, { upstream: 'mac', ours: 'mac' }] }];
	if (existsSync(join(root, 'src/macWebMain.ts'))) pages.push({ name: 'Mac', file: 'mac.html', root: 'src/macWebMain.ts',
		comparisons: [{ upstream: 'mac', ours: 'mac' }] });
	return { project, pages };
}
