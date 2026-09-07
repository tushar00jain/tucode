// Generate the repository-wide provenance report.
// node docs/provenance/build.mjs [--rev origin/vendor]
// --keys also regenerates this repository’s keyboard reports.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO, options } from './args.mjs';
import { generateReport } from './classify.mjs';
import { renderReport } from './report.mjs';

const { rev, upstream } = options('tree.json');
const report = generateReport(REPO, rev, upstream);
writeFileSync(join(import.meta.dirname, 'provenance.html'), renderReport(report));
console.log(`Generated docs/provenance/provenance.html against ${report.baseline.ref} (${report.baseline.commit.slice(0, 12)}).`);
console.log(JSON.stringify(report.totals));

if (process.argv.includes('--keys')) {
	execFileSync(process.execPath, [join(import.meta.dirname, '../keyboard/build.mjs'),
		...(upstream ? ['--upstream', upstream] : ['--rev', rev])], { stdio: 'inherit', timeout: 30_000 });
}
