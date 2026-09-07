if (globalThis.fixturePollution !== undefined) {
	throw new Error('focused fixture inherited another test process global');
}
