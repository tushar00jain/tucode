// A small, nonexecuting evaluator for the expressions used in shortcut declarations.
import ts from 'typescript';
export const UNRESOLVED = Symbol('unresolved expression');

export function evaluateNode(node, values) {
	if (!node) return undefined;
	if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return evaluateNode(node.expression, values);
	if (ts.isNumericLiteral(node)) return Number(node.text);
	if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
	if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
	if (ts.isIdentifier(node)) return node.text === 'undefined' ? undefined : Object.hasOwn(values, node.text) ? values[node.text] : UNRESOLVED;
	if (ts.isPropertyAccessExpression(node)) {
		const owner = evaluateNode(node.expression, values);
		return owner === UNRESOLVED ? UNRESOLVED : owner?.[node.name.text];
	}
	if (ts.isArrayLiteralExpression(node)) return node.elements.map(part => evaluateNode(part, values));
	if (ts.isConditionalExpression(node)) {
		const condition = evaluateNode(node.condition, values);
		return condition === UNRESOLVED ? UNRESOLVED : evaluateNode(condition ? node.whenTrue : node.whenFalse, values);
	}
	if (ts.isPrefixUnaryExpression(node)) {
		const value = evaluateNode(node.operand, values);
		if (value === UNRESOLVED) return UNRESOLVED;
		if (node.operator === ts.SyntaxKind.ExclamationToken) return !value;
		if (node.operator === ts.SyntaxKind.MinusToken) return -value;
	}
	if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'KeyChord') {
		const args = node.arguments.map(arg => evaluateNode(arg, values));
		return args.length === 2 && args.every(value => typeof value === 'number') ? values.KeyChord(...args) : UNRESOLVED;
	}
	if (ts.isBinaryExpression(node)) {
		const a = evaluateNode(node.left, values), b = evaluateNode(node.right, values);
		if (a === UNRESOLVED || b === UNRESOLVED) return UNRESOLVED;
		switch (node.operatorToken.kind) {
			case ts.SyntaxKind.BarToken: return a | b;
			case ts.SyntaxKind.AmpersandToken: return a & b;
			case ts.SyntaxKind.LessThanLessThanToken: return a << b;
			case ts.SyntaxKind.PlusToken: return a + b;
			case ts.SyntaxKind.EqualsEqualsEqualsToken: return a === b;
			case ts.SyntaxKind.ExclamationEqualsEqualsToken: return a !== b;
			case ts.SyntaxKind.AmpersandAmpersandToken: return a && b;
			case ts.SyntaxKind.BarBarToken: return a || b;
		}
	}
	return UNRESOLVED;
}

export function evaluate(expression, values) {
	if (!expression) return undefined;
	const source = ts.createSourceFile('binding.ts', `(${expression})`, ts.ScriptTarget.Latest, true);
	if (source.parseDiagnostics.length) return UNRESOLVED;
	return evaluateNode(source.statements[0]?.expression, values);
}

export function platformValues(platform, codes) {
	return { ...codes, isMacintosh: platform === 'mac', isWindows: platform === 'win', isLinux: platform === 'linux',
		isFirefox: false, isIOS: false };
}

export function variantKeys(variant, platform, codes) {
	// An explicit platform object replaces primary AND secondary, including primary: 0.
	const binding = variant[platform] ?? variant;
	const values = platformValues(platform, codes), keys = [];
	let unresolved = false;
	for (const expression of [binding.primary, binding.secondary]) {
		if (!expression || expression === 'undefined') continue;
		const value = evaluate(expression, values);
		for (const key of Array.isArray(value) ? value : [value]) {
			if (typeof key === 'number') { if (key) keys.push(key); }
			else if (key !== undefined) unresolved = true;
		}
	}
	return { keys, unresolved };
}
