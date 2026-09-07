//! Matcher construction. Port of the pattern half of
//! `ripgrepTextSearchEngine.getRgArgs`: every flag stock passes ripgrep maps to a
//! `grep_regex::RegexMatcherBuilder` setting, because that is the crate behind the
//! flags. Notably nothing here rewrites the pattern — `--fixed-strings`,
//! `--word-regexp` and `--crlf` are builder options, so the escaping dance stock
//! does on the command line has no counterpart in-process.

use grep_matcher::LineTerminator;
use grep_regex::{RegexMatcher, RegexMatcherBuilder};

use crate::error::SearchError;
use crate::query::TextSearchQuery;

/// The line terminator the matcher *and* the searcher are both built with.
///
/// `grep-searcher` refuses to run a matcher whose terminator differs from its
/// own, so ripgrep derives both from one value (`args::line_terminator`) rather
/// than setting each independently. Stock passes `--crlf`, which is the CRLF
/// form: the terminator byte is still `\n`, and `$` matches before the `\r`.
pub fn line_terminator() -> LineTerminator {
    LineTerminator::crlf()
}

pub fn build_matcher(query: &TextSearchQuery) -> Result<RegexMatcher, SearchError> {
    if query.pattern.is_empty() {
        return Err(SearchError::InvalidLiteral("empty search pattern".into()));
    }

    let terminator = line_terminator();
    RegexMatcherBuilder::new()
        .case_insensitive(!query.is_case_sensitive)
        .fixed_strings(!query.is_reg_exp)
        .word(query.is_word_match)
        .multi_line(query.is_multiline)
        .dot_matches_new_line(query.is_multiline)
        .line_terminator(Some(terminator.as_byte()))
        .crlf(terminator.is_crlf())
        .build(&query.pattern)
        .map_err(|e| SearchError::RegexParse(e.to_string()))
}
