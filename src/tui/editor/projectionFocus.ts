import type { TextProjectionSnapshot } from '../../editor/textProjection.js';

/**
 * The projected cursor row a TUI pane should reveal, or nothing when a passive viewer publication
 * must preserve its independently navigated row focus.
 */
export function textCursorRevealRow(previous: TextProjectionSnapshot | undefined, text: TextProjectionSnapshot | undefined): number | undefined {
	if (text?.kind !== 'text') { return undefined; }
	if (text.mode !== 'viewer') { return text.primaryCursorView.lineNumber - 1; }

	const previousText = previous;
	const previousCursor = previousText?.kind === 'text' ? previousText.primaryCursorView : undefined;
	const cursor = text.primaryCursorView;
	return previous?.documentId !== text.documentId || previousCursor?.lineNumber !== cursor.lineNumber || previousCursor?.column !== cursor.column
		? cursor.lineNumber - 1 : undefined;
}
