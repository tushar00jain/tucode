/*---------------------------------------------------------------------------------------------
 * Native Markdown paint over marked tokens. Fences use the editor's existing grammar registry,
 * encoded-token loop and span painter; document loading belongs to WorkbenchEditorAreaResolver.
 *--------------------------------------------------------------------------------------------*/
import { Token, Tokens } from '../../vs/base/common/marked/marked.js';
import { splitLines } from '../../vs/base/common/strings.js';
import { TokenizationRegistry } from '../../vs/editor/common/languages.js';
import { LanguageId } from '../../vs/editor/common/encodedTokenAttributes.js';
import { PLAINTEXT_LANGUAGE_ID } from '../../vs/editor/common/languages/modesRegistry.js';
import { ILanguageService } from '../../vs/editor/common/languages/language.js';
import { NullState, nullTokenizeEncoded } from '../../vs/editor/common/languages/nullTokenize.js';
import { IReducedTokenizationSupport } from '../../vs/editor/common/languages/textToHtmlTokenizer.js';
import { LineTokens } from '../../vs/editor/common/tokens/lineTokens.js';
import { IColorTheme } from '../../vs/platform/theme/common/themeService.js';
import { descriptionForeground, textBlockQuoteBackground, textBlockQuoteBorder, textCodeBlockBackground,
	textLinkForeground, textPreformatBackground, textPreformatForeground, textSeparatorForeground } from '../../vs/platform/theme/common/colors/baseColors.js';
import { editorForeground } from '../../vs/platform/theme/common/colors/editorColors.js';
import { tokenSpans } from '../../editor/textView.js';
import { ILine } from '../terminal/screen.js';
import { codeTokens, fillRow, renderTokens } from './markdownRows.js';

const NO_GRAMMAR: IReducedTokenizationSupport = {
	getInitialState: () => NullState,
	tokenizeEncoded: (_buffer, _hasEOL, state) => nullTokenizeEncoded(LanguageId.Null, state)
};

export async function renderMarkdown(tokens: readonly Token[], width: number, theme: IColorTheme, languages: ILanguageService): Promise<ILine[]> {
	const background = theme.getColor(textCodeBlockBackground);
	const foreground = theme.getColor(editorForeground);
	const fences = new Map<Tokens.Code, ILine[]>();
	for (const token of codeTokens(tokens)) {
		const language = (token.lang ? languages.getLanguageIdByLanguageName(token.lang) : undefined) ?? PLAINTEXT_LANGUAGE_ID;
		const support = await TokenizationRegistry.getOrCreate(language) ?? NO_GRAMMAR;
		let state = support.getInitialState();
		const rows: ILine[] = [];
		for (const line of splitLines(token.text)) {
			const result = support.tokenizeEncoded(line, true, state);
			LineTokens.convertToEndOffset(result.tokens, line.length);
			const lineTokens = new LineTokens(result.tokens, line, languages.languageIdCodec).inflate();
			rows.push(fillRow(tokenSpans(line, lineTokens, foreground, background), width, background));
			state = result.endState;
		}
		fences.set(token, rows);
	}
	return renderTokens(tokens, { width, code: token => fences.get(token) ?? [], style: {
		foreground, separator: theme.getColor(textSeparatorForeground), link: theme.getColor(textLinkForeground),
		codeForeground: theme.getColor(textPreformatForeground), codeBackground: theme.getColor(textPreformatBackground),
		quoteBackground: theme.getColor(textBlockQuoteBackground), quoteBorder: theme.getColor(textBlockQuoteBorder),
		muted: theme.getColor(descriptionForeground)
	} });
}
