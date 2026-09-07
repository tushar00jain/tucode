import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { FileAccess, Schemas } from '../../src/vs/base/common/network.js';
import { URI } from '../../src/vs/base/common/uri.js';

test('embedded asset mapping is used for browser loads without changing document URIs', () => {
	const font = URI.file('/bundle/app/resources/extensions/theme-seti/icons/seti.woff');
	const browserFont = URI.parse('tucode://app/app-resource/resources/extensions/theme-seti/icons/seti.woff');
	const document = URI.file('/workspace/main.ts');
	const defaultDocument = FileAccess.uriToBrowserUri(document);
	FileAccess.setBrowserUriMapper(uri => uri.toString() === font.toString() ? browserFont : undefined);
	try {
		assert.equal(FileAccess.uriToBrowserUri(font).toString(), browserFont.toString());
		assert.equal(FileAccess.uriToBrowserUri(document).toString(), defaultDocument.toString());
		assert.equal(FileAccess.uriToFileUri(font).toString(), font.toString());
		const remote = URI.parse('https://example.com/font.woff');
		assert.equal(FileAccess.uriToBrowserUri(remote), remote);
	} finally {
		FileAccess.setBrowserUriMapper(undefined);
	}
	assert.notEqual(FileAccess.uriToBrowserUri(font).scheme, 'tucode');
});

test('Mac maps bundle resources and local assets without changing document URIs', () => {
	// Execute the small, DOM-independent registration from the actual Mac bootstrap.
	const source = readFileSync(new URL('../../src/macWebMain.ts', import.meta.url), 'utf8');
	const file = ts.createSourceFile('macWebMain.ts', source, ts.ScriptTarget.Latest, true);
	// Select the registration itself, independently of neighboring bootstrap declarations.
	const prefix = file.statements.find(statement => ts.isVariableStatement(statement)
		&& statement.declarationList.declarations.some(declaration => declaration.name.getText(file) === 'bundledResourcePrefix'));
	const mapper = file.statements.find(statement => ts.isExpressionStatement(statement)
		&& ts.isCallExpression(statement.expression)
		&& statement.expression.expression.getText(file) === 'FileAccess.setBrowserUriMapper');
	assert.ok(prefix, 'Mac bootstrap must declare its bundled resource prefix');
	assert.ok(mapper, 'Mac bootstrap must register its browser URI mapper');
	const register = new Function('URI', 'FileAccess', 'Schemas', 'location', 'macConfiguration',
		`${prefix.getText(file)}\n${mapper.getText(file)}`);
	for (const resourceRoot of ['/bundle/App Resources/app', '/bundle/App Resources/app/']) {
		register(URI, FileAccess, Schemas, { protocol: 'tucode:', host: 'app' }, { resourceRoot });
		try {
			const font = URI.file('/bundle/App Resources/app/resources/extensions/theme-seti/icons/seti.woff');
			assert.equal(FileAccess.uriToBrowserUri(font).toString(),
				'tucode://app/app-resource/resources/extensions/theme-seti/icons/seti.woff');
			const outside = URI.file('/bundle/App Resources/app-other/private.txt');
			assert.notEqual(FileAccess.uriToBrowserUri(outside).scheme, 'tucode');
			const image = URI.file('/workspace/images/logo # % café.png');
			assert.equal(FileAccess.uriToBrowserUri(image).toString(),
				'asset://localhost/workspace/images/logo%20%23%20%25%20caf%C3%A9.png');
			assert.equal(FileAccess.uriToFileUri(image).toString(), image.toString());
			const remote = URI.parse('https://example.com/image.png');
			assert.equal(FileAccess.uriToBrowserUri(remote), remote);
		} finally { FileAccess.setBrowserUriMapper(undefined); }
	}
});
