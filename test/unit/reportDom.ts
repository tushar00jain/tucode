// Minimal DOM used to check that generated reports only create visible rows.
export function reportDOM() {
	let count = 0;
	const element = () => {
		count++;
		return { textContent: '', value: '', className: '', title: '', colSpan: 1, checked: false,
			dataset: {}, style: {}, open: false, append() {}, replaceChildren() {}, addEventListener() {} };
	};
	const ids = new Map<string, ReturnType<typeof element>>();
	const document = { createElement: element, createDocumentFragment: element,
		getElementById(id: string) {
			if (!ids.has(id)) ids.set(id, element());
			return ids.get(id)!;
		} };
	return { document, created: () => count };
}
