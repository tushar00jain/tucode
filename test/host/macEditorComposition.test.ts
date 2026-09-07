// The host transport cannot restart after disposal, so exercise the Mac composition in
// a separate test-file process while sharing all upstream lifecycle assertions.
process.env['TUCODE_TEST_MAC_EDITOR_COMPOSITION'] = '1';
await import('./editorLifecycle.test.js');
export {};
