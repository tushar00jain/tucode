// Every interaction a module registers, read out of the module's syntax tree.
//
// tscode declares what a user can do rather than scattering it: a command is `registerAction2`
// or `CommandsRegistry.registerCommand`, a menu item is `MenuRegistry.appendMenuItem`, a
// shortcut is a `keybinding` on an action descriptor or a `KeybindingsRegistry` rule, a setting
// is a property in a `configuration` schema, a panel is a view descriptor. So an interaction
// inventory is a scan for those calls — over the boot file's closure, because a registration in
// a module nothing imports never runs.
//
// The scan is TypeScript's own parser rather than a regex, because an id is usually not a
// literal at the call site. `registerAction2(FocusFilesExplorer)` names a class imported from
// another file, whose constructor calls `super({ id: … })`, whose id may itself be a static on
// a third class. So resolution follows import edges, and a descriptor is always carried with the
// module it was found in — a constant resolved against the wrong module's tables is a wrong
// answer, which is worse than no answer.
//
// What still cannot be resolved is emitted as `?unresolved` with the call text, never dropped: a
// silent drop is how an inventory ends up looking complete when it is not. `?dynamic` is the
// honest subset of that — a registration whose id is a loop variable or a parameter, which has
// no static answer at all.
//
// One name has no declaration a call site can reach at all: a member of an **injected interface**.
// `registerWorkbenchCommands(workbench)` states two of its chords as `workbench.keys.<name>`, and
// the value is whichever per-frontend table the running frontend supplies — so the chord did not
// become unknowable, it moved. `injected` is where the caller says which table a closure reaches,
// and the walk into it is the same one a constant across an import already gets.
//
// Upstream counterpart: none — the registry scanner behind the functionality page, which tscode has no counterpart page for.
import { createRequire } from 'node:module';

/** TypeScript comes from the repo under measurement, so the parser matches the sources. */
export function loadTypeScript(repoRoot) {
	return createRequire(`${repoRoot.split('\\').join('/')}/package.json`)('typescript');
}

// What each registrar contributes, and where its descriptor sits. `kind` is the interaction's
// flavour on the page; `descriptor` says how to get from the call to the object literal carrying
// the id — `arg0`/`arg1` for a literal argument, `class` for a class whose constructor calls
// `super({…})`, `new` for a constructed instance of one. `named` means the identity is the
// argument's own name rather than a string: a service is `IFileService`, not an id.
//
// A Map, not an object literal: callee names are read out of arbitrary source, and `x.toString()`
// would otherwise match `Object.prototype.toString` and register hundreds of phantom rows.
//
// `keyFrom`, `whenFrom` and `viewFrom` are the arguments holding the key, its guard and the view it
// is scoped to, for a registrar that takes them positionally rather than on a descriptor. It is how
// the fork's own keybinding table is read: `tui/commands.ts` wraps `KeybindingsRegistry` in three
// helpers, so the literal `primary` is at *their* call sites and the vendored call sees only
// `command.primary`.
const REGISTRARS = new Map(Object.entries({
	// Commands: an id a user can end up invoking.
	'registerAction2': { kind: 'command', descriptor: 'class' },
	'CommandsRegistry.registerCommand': { kind: 'command', descriptor: 'arg0' },
	'KeybindingsRegistry.registerCommandAndKeybindingRule': { kind: 'command', descriptor: 'arg0' },
	'registerTuiCommand': { kind: 'command', descriptor: 'arg0' },
	'registerPaneCommand': { kind: 'command', descriptor: 'arg1', viewFrom: 0 },
	'registerTuiKeybinding': { kind: 'keybinding', descriptor: 'arg0', keyFrom: 1, whenFrom: 2 },
	// Binds nothing: it puts an upstream command carrying its own key on the status line, which is
	// the only way a user finds out that key is there. `declaresOnly` is how the keybinding map
	// tells that row from one this fork bound itself.
	'declareTuiCommand': { kind: 'command', descriptor: 'arg0', declaresOnly: true },
	'registerEditorAction': { kind: 'editorCommand', descriptor: 'class' },
	'registerMultiEditorAction': { kind: 'editorCommand', descriptor: 'class' },
	'registerEditorCommand': { kind: 'editorCommand', descriptor: 'new' },
	'registerTerminalAction': { kind: 'command', descriptor: 'arg0' },
	'registerActiveInstanceAction': { kind: 'command', descriptor: 'arg0' },
	'registerActiveXtermAction': { kind: 'command', descriptor: 'arg0' },
	'registerContextualInstanceAction': { kind: 'command', descriptor: 'arg0' },

	// Surfaces that put a command in front of the user.
	'MenuRegistry.appendMenuItem': { kind: 'menuItem', descriptor: 'arg1', menuFrom: 0 },
	'MenuRegistry.appendMenuItems': { kind: 'menuItem', descriptor: 'arg0', each: true },
	'KeybindingsRegistry.registerKeybindingRule': { kind: 'keybinding', descriptor: 'arg0' },

	// Panels, editors and the palette.
	'registerViewContainer': { kind: 'viewContainer', descriptor: 'arg0' },
	'registerViews': { kind: 'view', descriptor: 'arg0', each: true },
	'registerViewWelcomeContent': { kind: 'viewWelcome', descriptor: 'arg0' },
	'registerEditorPane': { kind: 'editorPane', descriptor: 'arg0' },
	'registerQuickAccessProvider': { kind: 'quickAccess', descriptor: 'arg0' },

	// Structure rather than interaction, but it sizes what stands up behind the panes.
	'registerConfiguration': { kind: 'setting', descriptor: 'arg0', settings: true },
	'registerSingleton': { kind: 'service', descriptor: 'arg0', named: true },
	'registerWorkbenchContribution2': { kind: 'contribution', descriptor: 'arg0', named: true },
	'registerTerminalContribution': { kind: 'terminalContribution', descriptor: 'arg0', named: true },
	'registerColor': { kind: 'color', descriptor: 'arg0' },
	'registerIcon': { kind: 'icon', descriptor: 'arg0' }
}));

const REGISTRATION_CALL = new RegExp('\\b(?:' + [...new Set([...REGISTRARS.keys()].map(name => name.split('.').at(-1)))].join('|') + ')\\s*\\(');
export const hasRegistrations = body => REGISTRATION_CALL.test(body);

/** The keys an id can arrive under, in the order a descriptor is likely to carry them. */
const ID_KEYS = ['id', 'commandId', 'command', 'prefix', 'viewId', 'typeId'];
const LABEL_KEYS = ['title', 'label', 'name', 'content', 'placeholder', 'value', 'original'];
const MAX_HOPS = 5;

/** One `.name` or `[0]` step of a path, so `A.b[0].c` reads as the walk it describes. */
const PATH_STEP = /\.(\w+)|\[(\d+)\]/y;

/**
 * The steps a dotted/indexed path takes after its root, or null when it is not a plain path — a
 * call, an arithmetic expression and anything else with a shape has no member to walk to.
 */
function pathSteps(path) {
	const out = [];
	PATH_STEP.lastIndex = 0;
	while (PATH_STEP.lastIndex < path.length) {
		const match = PATH_STEP.exec(path);
		if (!match) {
			return null;
		}
		out.push(match[1] ?? Number(match[2]));
	}
	return out;
}

/**
 * @param ts the TypeScript the measured repository builds with
 * @param injected the tables an injected interface member is declared in, as `prefix -> {file, name}`
 */
export function scanner(ts, injected = new Map()) {
	const cache = new Map();                                    // rel -> parsed module | null

	/** Parses a module and tables everything a descriptor elsewhere might name. */
	function parse(rel, body) {
		const source = ts.createSourceFile(rel, body, ts.ScriptTarget.ESNext, true);
		const constants = new Map();                            // 'X' | 'X.Y' -> string
		const exprs = new Map();                                // 'X' | 'X.Y' -> unresolved node
		const objects = new Map();                              // 'X' -> ObjectLiteralExpression
		const classes = new Map();                              // 'X' -> ClassDeclaration
		const imports = new Map();                              // local name -> { spec, exported }

		const literal = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
			? node.text : undefined;

		// An id is often a static or a constant whose own initializer is an expression —
		// `static readonly ID = TerminalCommandId.Help`. Tabling the node rather than skipping it
		// lets the same resolver finish the job in this module's own scope.
		const table = (name, node) => {
			const value = literal(node);
			if (value !== undefined) constants.set(name, value);
			else if (node) exprs.set(name, node);
			if (node && ts.isObjectLiteralExpression(node)) {
				objects.set(name, node);
				for (const member of node.properties) if (ts.isPropertyAssignment(member)) table(`${name}.${member.name.getText(source)}`, member.initializer);
			}
		};

		for (const statement of source.statements) {
			if (ts.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
				const spec = literal(statement.moduleSpecifier);
				const bindings = statement.importClause.namedBindings;
				if (spec && bindings && ts.isNamedImports(bindings)) {
					for (const element of bindings.elements) {
						if (element.isTypeOnly) continue;
						imports.set(element.name.text, { spec, exported: (element.propertyName ?? element.name).text });
					}
				} else if (spec && bindings && ts.isNamespaceImport(bindings)) {
					// `import * as Constants` — the qualifier is the module, so `Constants.A.B` is
					// `A.B` over there. Search's command ids are all reached this way.
					imports.set(bindings.name.text, { spec, exported: null });
				}
			} else if (ts.isVariableStatement(statement)) {
				for (const declaration of statement.declarationList.declarations) {
					if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
					const name = declaration.name.text;
					if (!ts.isObjectLiteralExpression(declaration.initializer)) { table(name, declaration.initializer); continue; }
					objects.set(name, declaration.initializer);
					for (const member of declaration.initializer.properties) {
						if (!ts.isPropertyAssignment(member) || !member.name) continue;
						table(`${name}.${member.name.getText(source)}`, member.initializer);
					}
				}
			} else if (ts.isEnumDeclaration(statement)) {
				for (const member of statement.members) {
					table(`${statement.name.text}.${member.name.getText(source)}`, member.initializer);
				}
			}
		}

		// Statics carry ids all over the workbench — `SaplingViewPane.ID`, `SearchView.ID`.
		(function declarations(node) {
			if (ts.isClassDeclaration(node) && node.name) {
				classes.set(node.name.text, node);
				for (const member of node.members) {
					if (!ts.isPropertyDeclaration(member) || !member.name) continue;
					if (!member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword)) continue;
					table(`${node.name.text}.${member.name.getText(source)}`, member.initializer);
				}
			}
			ts.forEachChild(node, declarations);
		})(source);

		return { rel, source, constants, exprs, objects, classes, imports };
	}

	function moduleOf(rel, tree) {
		if (cache.has(rel)) return cache.get(rel);
		const body = tree.read(rel);
		const parsed = body === null ? null : parse(rel, body);
		cache.set(rel, parsed);
		return parsed;
	}

	/**
	 * Follows a dotted name across one import edge, and answers where it landed — so a caller
	 * that wanted a string and a caller that wanted a class both use the same hop.
	 *
	 * @returns { module, name } | null
	 */
	function hop(ctx, name, depth) {
		if (depth >= MAX_HOPS) return null;
		const root = name.split('.')[0];
		const imported = ctx.module.imports.get(root);
		if (!imported) return null;
		const target = ctx.resolveEdge(imported.spec, ctx.module.rel);
		if (!target) return null;
		const other = moduleOf(target, ctx.tree);
		if (!other) return null;
		// `import { A as B }` means the other file tables it under A; a namespace import has no
		// name of its own, so the qualifier is simply dropped.
		const rest = name.slice(root.length);
		return { module: other, name: imported.exported === null ? rest.replace(/^\./, '') : imported.exported + rest };
	}

	/** A descriptor expression as a string, following imports for a constant declared elsewhere. */
	function asString(node, ctx, depth = 0) {
		if (!node || depth >= MAX_HOPS) return undefined;
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
		if (ts.isCallExpression(node) && /(?:^|\.)(?:localize|localize2)$/.test(node.expression.getText(ctx.module.source))) return asString(node.arguments[1], ctx, depth + 1);
		if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return asString(node.expression, ctx, depth);
		if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
			const left = asString(node.left, ctx, depth);
			const right = asString(node.right, ctx, depth);
			return left !== undefined && right !== undefined ? left + right : undefined;
		}
		// `` `^${PASTE_FILE_ID}` `` — a keybinding rule's "when this command, negated" form.
		if (ts.isTemplateExpression(node)) {
			let out = node.head.text;
			for (const span of node.templateSpans) {
				const value = asString(span.expression, ctx, depth + 1);
				if (value === undefined) return undefined;
				out += value + span.literal.text;
			}
			return out;
		}
		if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return undefined;
		return byName(ctx, node.getText(ctx.module.source), depth);
	}

	/**
	 * The source of the expression a name stands for — `globalQuickAccessKeybinding.primary` is
	 * `KeyMod.CtrlCmd | KeyCode.KeyP`, declared at the top of its own module. `asString` answers only
	 * for a name that resolves to a string, and a key is arithmetic rather than a string.
	 */
	function expressionText(node, ctx, depth = 0) {
		if (!node || depth >= MAX_HOPS) return undefined;
		if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return undefined;

		const local = ctx.module.exprs.get(node.getText(ctx.module.source));
		if (local) {
			return expressionText(local, ctx, depth + 1) ?? local.getText(ctx.module.source).replace(/\s+/g, ' ');
		}
		const next = hop(ctx, node.getText(ctx.module.source), depth);
		const other = next?.module.exprs.get(next.name);
		return other ? other.getText(next.module.source).replace(/\s+/g, ' ') : undefined;
	}

	// Expand constants inside arithmetic, arrays and chords for the documentation reader.
	function expandedKey(node, ctx, depth = 0) {
		if (!node || depth > 12) return node?.getText(ctx.module.source);
		const raw = node.getText(ctx.module.source);
		if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
			if (/^(?:KeyCode|KeyMod|KeyChord)(?:\.|$)/.test(raw)) return raw;
			const local = ctx.module.exprs.get(raw);
			if (local) return `(${expandedKey(local, ctx, depth + 1)})`;
			const next = hop(ctx, raw, 0);
			const other = next?.module.exprs.get(next.name);
			if (other) return `(${expandedKey(other, { ...ctx, module: next.module }, depth + 1)})`;
		}
		if (ts.isElementAccessExpression(node) && ts.isNumericLiteral(node.argumentExpression)) {
			const array = ctx.module.exprs.get(node.expression.getText(ctx.module.source));
			if (array && ts.isArrayLiteralExpression(array)) return expandedKey(array.elements[Number(node.argumentExpression.text)], ctx, depth + 1);
		}
		const part = child => expandedKey(child, ctx, depth + 1);
		if (ts.isBinaryExpression(node)) return `(${part(node.left)} ${node.operatorToken.getText(ctx.module.source)} ${part(node.right)})`;
		if (ts.isArrayLiteralExpression(node)) return `[${node.elements.map(part).join(', ')}]`;
		if (ts.isConditionalExpression(node)) return `(${part(node.condition)} ? ${part(node.whenTrue)} : ${part(node.whenFalse)})`;
		if (ts.isParenthesizedExpression(node)) return `(${part(node.expression)})`;
		if (ts.isCallExpression(node) && node.expression.getText(ctx.module.source) === 'KeyChord') return `KeyChord(${node.arguments.map(part).join(', ')})`;
		return raw;
	}

	/** The same lookup entered by name, which is what an import hop continues with. */
	function byName(ctx, name, depth) {
		if (ctx.module.constants.has(name)) return ctx.module.constants.get(name);
		// A tabled expression resolves in the module that declared it, not in the caller's.
		const expr = ctx.module.exprs.get(name);
		if (expr) {
			const value = asString(expr, ctx, depth + 1);
			if (value !== undefined) return value;
		}
		const next = hop(ctx, name, depth);
		return next ? byName({ ...ctx, module: next.module }, next.name, depth + 1) : undefined;
	}

	/**
	 * A declaration a node refers to — either because it *is* one, or because it names one, here or
	 * one import away. The pair returned carries the module it was found in, because a constant read
	 * out of it has to resolve against that module's tables and not the caller's.
	 */
	function declaration(node, ctx, table, isSelf, depth) {
		if (!node || depth >= MAX_HOPS) return null;
		if (isSelf(node)) return { node, ctx };
		if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return null;
		const name = node.getText(ctx.module.source);
		const local = ctx.module[table].get(name);
		if (local) return { node: local, ctx };
		const next = hop(ctx, name, depth);
		if (!next) return null;
		const found = next.module[table].get(next.name);
		return found ? { node: found, ctx: { ...ctx, module: next.module } } : null;
	}

	const asObject = (node, ctx, depth = 0) =>
		declaration(node, ctx, 'objects', ts.isObjectLiteralExpression, depth);

	const asClass = (node, ctx, depth = 0) =>
		declaration(node, ctx, 'classes', n => ts.isClassExpression(n) || ts.isClassDeclaration(n), depth);

	/** The `super({…})` a class hands its descriptor to, in that class's own module. */
	function superDescriptor(found) {
		let object;
		(function find(node) {
			if (object) return;
			if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.SuperKeyword) {
				object = node.arguments.find(ts.isObjectLiteralExpression);
				if (object) return;
			}
			ts.forEachChild(node, find);
		})(found.node);
		return object ? { node: object, ctx: found.ctx } : null;
	}

	// `{ id, title }` inside a loop body is a shorthand assignment, so the value is the name.
	const valueOf = (member) => member.initializer ?? member.name;

	const memberOf = (found, key) => found && ts.isObjectLiteralExpression(found.node)
		? found.node.properties.find(p =>
			(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name &&
			p.name.getText(found.ctx.module.source) === key)
		: undefined;

	/** A member's initializer as it is written, in the module that wrote it. */
	const memberText = (found, key) => {
		const member = memberOf(found, key);
		return member ? valueOf(member).getText(found.ctx.module.source).replace(/\s+/g, ' ') : undefined;
	};

	/**
	 * Where an injected name lands: `{ node }` for a member the table states, `{ node: null }` for one
	 * it deliberately omits — a rule with no `when` is unguarded rather than unread — and null when no
	 * injection supplies the name or the path leaves what this can follow.
	 */
	function injectedMember(text, ctx) {
		for (const [prefix, where] of injected) {
			const steps = text.startsWith(prefix) ? pathSteps(text.slice(prefix.length)) : null;
			const module = steps ? moduleOf(where.file, ctx.tree) : null;
			let at = module?.objects.has(where.name) ? { node: module.objects.get(where.name), ctx: { ...ctx, module } } : null;

			for (const step of steps ?? []) {
				if (!at?.node) break;
				if (typeof step === 'number') {
					at = ts.isArrayLiteralExpression(at.node) && at.node.elements[step]
						? { node: at.node.elements[step], ctx: at.ctx }
						: null;
					continue;
				}
				const object = asObject(at.node, at.ctx);
				const member = memberOf(object, step);
				// A table that states nothing under a name has answered: the member is absent, not
				// unread, and the two are as different here as everywhere else in this file.
				at = object ? { node: member ? valueOf(member) : null, ctx: object.ctx } : null;
			}
			if (at) return at;
		}
		return null;
	}

	/**
	 * An injected member's declaration as source text, `''` for one the table omits, and undefined
	 * when nothing supplies the name — which leaves the caller with the text it already had.
	 */
	const injectedText = (text, ctx) => {
		const found = text === undefined ? null : injectedMember(text, ctx);
		if (!found) return undefined;
		return found.node ? found.node.getText(found.ctx.module.source).replace(/\s+/g, ' ') : '';
	};

	/**
	 * Where a registration states its key. `KeybindingsRegistry`'s own rule shape — and the fork's
	 * three helpers over it — put `primary`, `secondary` and `when` on the descriptor itself; an
	 * `Action2` carries them on a nested `keybinding`, and an editor command on `kbOpts`. Upstream
	 * states nearly every key the second way, so a scan that reads only the first sees almost none
	 * of tscode's own bindings — which is the half a keybinding map is built from.
	 */
	function keybindingsOf(found) {
		if (!found || !ts.isObjectLiteralExpression(found.node)) return [];
		if (['primary', 'mac', 'win', 'linux'].some(key => memberOf(found, key))) return [found];

		for (const key of ['keybinding', 'kbOpts']) {
			const member = memberOf(found, key);
			if (!member) continue;
			// Preserve every rule in a keybinding array. For Object.assign descriptors,
			// search from the right for the object that declares the binding.
			const value = valueOf(member);
			const parts = ts.isArrayLiteralExpression(value) ? [...value.elements]
				: ts.isCallExpression(value) && value.expression.getText(found.ctx.module.source) === 'Object.assign'
					? [...value.arguments].reverse()
					: [value];

			const rules = parts.map(part => part ? asObject(part, found.ctx) : null)
				.filter(nested => nested && ['primary', 'mac', 'win', 'linux'].some(key => memberOf(nested, key)));
			if (rules.length) return ts.isArrayLiteralExpression(value) ? rules : [rules[0]];
		}
		return [];
	}

	/** The first of `keys` a descriptor answers, following nested objects and `localize(…)` calls. */
	function property(found, keys) {
		if (!found) return undefined;
		for (const key of keys) {
			const member = memberOf(found, key);
			if (!member) continue;
			const initializer = valueOf(member);
			const direct = asString(initializer, found.ctx);
			if (direct !== undefined) return direct;
			// `command: { id: … }` on a menu item, `title: localize2('key', "Text")` on an action.
			const nested = asObject(initializer, found.ctx);
			if (nested) {
				const inner = property(nested, keys);
				if (inner !== undefined) return inner;
			}
			if (ts.isCallExpression(initializer)) {
				const localized = /(?:^|\.)(?:localize|localize2)$/.test(initializer.expression.getText(found.ctx.module.source));
				for (const argument of [...initializer.arguments].slice(localized ? 1 : 0)) {
					const inner = asString(argument, found.ctx);
					if (inner !== undefined) return inner;
				}
			}
		}
		return undefined;
	}

	/** Every registration a module makes. `resolveEdge` is the closure walk's own resolver. */
	function scan(rel, tree, resolveEdge, { detailedKeys = false } = {}) {
		const module = moduleOf(rel, tree);
		if (!module) return [];
		const { source } = module;
		const root = { module, tree, resolveEdge };
		const records = [];
		const at = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

		/** What `this.viewId` is, read off the class the call sits in. */
		const thisProperty = (call, name) => {
			for (let owner = call.parent; owner; owner = owner.parent) {
				if (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) continue;
				return owner.members.find(member =>
					ts.isPropertyDeclaration(member) && member.name?.getText(source) === name)?.initializer;
			}
			return undefined;
		};

		/**
		 * A guard written inside a pane names `this.viewId`, which means nothing outside the class it
		 * was written in — and a guard that cannot be read outside its own file cannot be compared
		 * with another pane's. Substituting what the class initialises the property to is what makes
		 * the two comparable.
		 */
		const portable = (text, call) => text?.replace(/\bthis\.(\w+)\b/g, (whole, name) => {
			const value = asString(thisProperty(call, name), root);
			return value === undefined ? whole : `'${value}'`;
		});

		const descriptorOf = (call, spec) => {
			const argument = call.arguments[spec.descriptor === 'arg1' ? 1 : 0];
			if (!argument) return null;
			if (spec.descriptor === 'class') {
				const found = asClass(argument, root);
				return found ? superDescriptor(found) : null;
			}
			if (spec.descriptor === 'new') {
				if (!ts.isNewExpression(argument)) return null;
				// `new BaseMoveToCommand({ id: '_moveTo', … })` carries the id at the construction
				// site; only a no-argument construction has to go looking in the class.
				const own = argument.arguments?.find(ts.isObjectLiteralExpression);
				if (own && memberOf({ node: own, ctx: root }, 'id')) return { node: own, ctx: root };
				const found = asClass(argument.expression, root);
				return found ? superDescriptor(found) : null;
			}
			return asObject(argument, root) ?? { node: argument, ctx: root };
		};

		/** Configuration schemas nest: `properties` under a node, and nodes under `allOf`. */
		function settings(found, call) {
			if (!found) return;
			const { node, ctx } = found;
			if (ts.isArrayLiteralExpression(node)) {
				for (const item of node.elements) settings(asObject(item, ctx), call);
				return;
			}
			if (!ts.isObjectLiteralExpression(node)) return;
			for (const member of node.properties) {
				if (!ts.isPropertyAssignment(member) || !member.name) continue;
				const key = member.name.getText(ctx.module.source);
				if (key === 'allOf') { settings(asObject(member.initializer, ctx) ?? { node: member.initializer, ctx }, call); continue; }
				if (key !== 'properties') continue;
				const properties = asObject(member.initializer, ctx);
				if (!properties) continue;
				for (const entry of properties.node.properties) {
					if (!ts.isPropertyAssignment(entry) || !entry.name) continue;
					const name = ts.isStringLiteral(entry.name) || ts.isNoSubstitutionTemplateLiteral(entry.name)
						? entry.name.text
						: asString(entry.name, properties.ctx) ??
						asString(ts.isComputedPropertyName(entry.name) ? entry.name.expression : entry.name, properties.ctx);
					const schema = asObject(entry.initializer, properties.ctx);
					records.push({
						kind: 'setting',
						id: name ?? unresolved(entry, properties.ctx.module.source),
						label: property(schema, ['description', 'markdownDescription']),
						file: rel,
						line: at(entry.pos < source.text.length ? entry : call)
					});
				}
			}
		}

		(function visit(node) {
			if (ts.isCallExpression(node)) {
				const spec = registrarFor(node.expression, source);
				if (spec) {
					if (detailedKeys && spec.descriptor === 'class' && ts.isIdentifier(node.arguments[0])) {
						for (let owner = node.parent; owner; owner = owner.parent) {
							if (!ts.isForOfStatement(owner) || !ts.isVariableDeclarationList(owner.initializer)) continue;
							if (owner.initializer.declarations[0]?.name.getText(source) !== node.arguments[0].text) continue;
							let expression = owner.expression, ctx = root;
							if (ts.isIdentifier(expression)) {
								const next = hop(root, expression.text, 0);
								if (next) { ctx = { ...root, module: next.module }; expression = next.module.exprs.get(next.name); }
								else expression = module.exprs.get(expression.text);
							}
							if (expression && ts.isArrayLiteralExpression(expression)) {
								for (const item of expression.elements) { const found = asClass(item, ctx); if (found) emit(spec, superDescriptor(found), node); }
								return;
							}
						}
					}
					const found = descriptorOf(node, spec);
					if (spec.settings) {
						settings(found, node);
					} else if (spec.each && found && ts.isArrayLiteralExpression(found.node)) {
						for (const item of found.node.elements) emit(spec, asObject(item, found.ctx), node);
					} else {
						emit(spec, found, node);
					}
				}
			}
			ts.forEachChild(node, visit);
		})(source);

		function emit(spec, found, call) {
			const argument = call.arguments[spec.descriptor === 'arg1' ? 1 : 0];
			const isLiteralObject = found && ts.isObjectLiteralExpression(found.node);

			// A registrar whose id is a bare string argument rather than a descriptor object.
			let id = isLiteralObject ? property(found, ID_KEYS) : asString(argument, root);
			// An editor pane and a quick-access provider arrive as `Descriptor.create(Class, ID, …)`,
			// so the id is inside the factory call rather than on an object.
			if (id === undefined && argument && ts.isCallExpression(argument)) {
				for (const inner of argument.arguments) {
					id = asString(inner, root);
					if (id !== undefined) break;
				}
			}
			// A service or a contribution is identified by the name it is registered under.
			if (id === undefined && spec.named && argument) id = argument.getText(source);
			// A descriptor that was found but whose id did not resolve is a computed id — the
			// per-view actions `viewsService.ts` registers one of per view descriptor. That is a
			// different fact from "the descriptor could not be found", so it is labelled as one.
			if (id === undefined) {
				id = memberOf(found, 'id')
					? `?dynamic: ${call.getText(source).replace(/\s+/g, ' ').slice(0, 70)}`
					: unresolved(call, source, argument);
			}

			const has = (key) => memberOf(found, key) !== undefined;
			// The key itself, as it is written — `KeyMod.CtrlCmd | KeyCode.Enter`. Left as source text
			// on purpose: resolving it to a label needs `USLayoutResolvedKeybinding`, which is the
			// program's job and not a scanner's, and the expression is what a reader recognises.
			const positional = (which) => spec[which] !== undefined && call.arguments[spec[which]]
				? call.arguments[spec[which]].getText(source).replace(/\s+/g, ' ')
				: undefined;
			const rules = keybindingsOf(found);
			const rule = rules[0];
			// A key stated as a name rather than as arithmetic — `globalQuickAccessKeybinding.primary`
			// — is followed one step, because the name is not what a reader of a key recognises. An
			// injected member is followed first: it is the one name whose declaration is in neither
			// this module nor a module this one imports.
			const keyOf = (owner, name) => {
				const text = memberText(owner, name);
				if (detailedKeys && text) {
					return injectedText(text, root) ?? expandedKey(valueOf(memberOf(owner, name)), owner.ctx);
				}
				return text && !/\b(?:KeyCode|KeyMod|KeyChord)\b/.test(text)
					? injectedText(text, root) ?? expressionText(valueOf(memberOf(owner, name)), owner.ctx) ?? text
					: text;
			};
			const key = (rule && keyOf(rule, 'primary')) ?? positional('keyFrom');
			// The guard, from wherever the registrar puts it: on the rule, on the descriptor around
			// it (an `Action2` states `when` on its `keybinding` and `precondition` beside it), or in
			// an argument of its own. Only the injected substitution is applied to it: a guard term is
			// a name on purpose — following `EditorAreaFocusContext` to the `RawContextKey` that
			// declares it would replace the vocabulary a reader compares guards in.
			const stated = (rule && memberText(rule, 'when'))
				?? (found && ts.isObjectLiteralExpression(found.node)
					? memberText(found, 'when') ?? memberText(found, 'precondition') : undefined)
				?? positional('whenFrom');
			const when = injectedText(stated, root) ?? stated;
			// `registerPaneCommand(this.viewId, …)` — the view a pane's key is scoped to, resolved
			// against the enclosing class's own property rather than guessed from the file, because
			// two files can declare keys for one view and `editorCommands`/`terminalCommands` do.
			const viewArgument = spec.viewFrom !== undefined ? call.arguments[spec.viewFrom] : undefined;
			const view = viewArgument
				? asString(viewArgument, root)
					?? (ts.isPropertyAccessExpression(viewArgument) && viewArgument.expression.kind === ts.SyntaxKind.ThisKeyword
						? asString(thisProperty(call, viewArgument.name.getText(source)), root)
						: undefined)
				: undefined;

			const conditions = [];
			if (detailedKeys) for (let child = call, parent = call.parent; parent; child = parent, parent = parent.parent) {
				if (ts.isIfStatement(parent)) conditions.push([parent.expression.getText(source), child === parent.thenStatement]);
			}
			records.push({
				kind: spec.kind,
				id,
				key: portable(key, call),
				...(detailedKeys ? { registrar: call.expression.getText(source), conditions, variants: rules.map(binding => {
					const read = owner => owner ? { primary: keyOf(owner, 'primary'), secondary: keyOf(owner, 'secondary') } : { primary: 'unresolvedPlatformBinding' };
					const platforms = Object.fromEntries(['mac', 'win', 'linux'].flatMap(platform => {
						const member = memberOf(binding, platform);
						return member ? [[platform, read(asObject(valueOf(member), binding.ctx))]] : [];
					}));
					return { ...read(binding), ...platforms, when: memberText(binding, 'when') };
				}) } : {}),
				...(rule && keyOf(rule, 'secondary') ? { secondary: portable(keyOf(rule, 'secondary'), call) } : {}),
				...(when ? { when: portable(when, call) } : {}),
				...(view ? { view } : {}),
				...(found && ts.isObjectLiteralExpression(found.node) && memberText(found, 'whileEditing') === 'true'
					? { whileEditing: true } : {}),
				...(spec.declaresOnly ? { declaresOnly: true } : {}),
				label: property(found, LABEL_KEYS),
				// A palette entry, a menu item and a shortcut are three reaches for one command, so
				// each is recorded on the command rather than counted as a separate interaction.
				palette: has('f1') ? property(found, ['f1']) !== 'false' : undefined,
				inMenu: has('menu') || has('menuOpts') || undefined,
				bound: has('keybinding') || has('kbOpts') || has('primary') || undefined,
				menu: spec.menuFrom !== undefined ? menuName(call.arguments[spec.menuFrom], source) : undefined,
				file: rel,
				line: at(call)
			});
		}

		return records;
	}

	return { scan, moduleOf };
}

/** `MenuRegistry.appendMenuItem` names its menu by enum member, and the member is the answer. */
const menuName = (node, source) =>
	node ? node.getText(source).replace(/^MenuId\./, '') : undefined;

/**
 * A registration with no static id, labelled by why. `?passthrough` is a registry handing on
 * something a caller gave it — `registerEditorAction(action)` inside `editorExtensions.ts` — which
 * is plumbing, not a declaration, and is counted separately so it cannot inflate the gap.
 * `?dynamic` is a real registration whose id is computed, so there is no static answer to find.
 */
function unresolved(call, source, argument) {
	const text = call.getText(source).replace(/\s+/g, ' ').slice(0, 70);
	if (!argument) return `?unresolved: ${text}`;

	const name = argument.escapedText !== undefined ? String(argument.escapedText) : null;
	if (name) {
		for (let node = argument.parent; node; node = node.parent) {
			if (node.parameters?.some(p => p.name?.escapedText === name)) return `?passthrough: ${text}`;
		}
		return `?dynamic: ${text}`;
	}
	return `?unresolved: ${text}`;
}

/**
 * The registrar a callee names. The qualified form is tried first, because `MenuRegistry` is part
 * of the identity of `appendMenuItem`, and then the bare property — a registry is just as often
 * held in a local, so `viewsRegistry.registerViews(…)`, `Registry.as(X).registerViews(…)` and a
 * bare `registerViews(…)` are one registrar reached three ways. Matching only the qualified form
 * silently lost every view Sapling registers.
 */
function registrarFor(node, source) {
	if (node.kind === undefined) return undefined;
	if (node.escapedText !== undefined) return REGISTRARS.get(String(node.escapedText));
	if (!node.name || !node.expression) return undefined;

	const property = String(node.name.escapedText ?? node.name.getText(source));
	const qualifier = node.expression.escapedText;
	return (qualifier !== undefined ? REGISTRARS.get(`${qualifier}.${property}`) : undefined)
		?? REGISTRARS.get(property);
}
