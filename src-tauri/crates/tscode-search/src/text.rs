//! String helpers ported from `vs/base/common/strings.ts`, plus the UTF-16
//! indexing they imply.
//!
//! Stock computes every search column with JavaScript `String.length` and slices
//! with JS indices, i.e. **UTF-16 code units**. Reproducing that exactly is what
//! makes ranges line up with the ranges Monaco expects.

/// A line of text indexable by UTF-16 code unit. ASCII — the overwhelmingly
/// common case — borrows and indexes by byte, since the two coincide there.
pub enum Utf16Text<'a> {
    Ascii(&'a str),
    Wide(Vec<u16>),
}

impl<'a> Utf16Text<'a> {
    pub fn new(s: &'a str) -> Self {
        if s.is_ascii() {
            Self::Ascii(s)
        } else {
            Self::Wide(s.encode_utf16().collect())
        }
    }

    pub fn len(&self) -> usize {
        match self {
            Self::Ascii(s) => s.len(),
            Self::Wide(v) => v.len(),
        }
    }

    /// Unused, but `len` without it trips `clippy::len_without_is_empty`.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// JS `String.prototype.slice` semantics: indices are clamped and an
    /// inverted range yields the empty string.
    pub fn slice(&self, start: usize, end: usize) -> String {
        let len = self.len();
        let start = start.min(len);
        let end = end.min(len);
        if start >= end {
            return String::new();
        }
        match self {
            Self::Ascii(s) => s[start..end].to_string(),
            Self::Wide(v) => String::from_utf16_lossy(&v[start..end]),
        }
    }
}

/// UTF-16 length of a `str`, i.e. what JS `String.length` would report.
pub fn utf16_len(s: &str) -> u32 {
    if s.is_ascii() {
        s.len() as u32
    } else {
        s.encode_utf16().count() as u32
    }
}

/// Port of `strings.getNLines`.
pub fn get_n_lines(s: &str, n: usize) -> &str {
    if n == 0 {
        return "";
    }

    let mut remaining = n;
    let mut idx;
    let mut from = 0usize;
    loop {
        idx = s[from..].find('\n').map(|i| i + from);
        remaining -= 1;
        match idx {
            Some(i) => from = i + 1,
            None => break,
        }
        if remaining == 0 {
            break;
        }
    }

    let Some(mut i) = idx else { return s };
    if i > 0 && s.as_bytes()[i - 1] == b'\r' {
        i -= 1;
    }
    &s[..i]
}

/// Port of `ripgrepTextSearchEngine.getNumLinesAndLastNewlineLength`, with the
/// last-line length in UTF-16 code units.
pub fn num_lines_and_last_line_len(text: &str) -> (u32, u32) {
    let mut num_lines = 0u32;
    let mut last_newline: Option<usize> = None;
    for (i, b) in text.bytes().enumerate() {
        if b == b'\n' {
            num_lines += 1;
            last_newline = Some(i);
        }
    }
    let last_line = match last_newline {
        Some(i) => &text[i + 1..],
        None => text,
    };
    (num_lines, utf16_len(last_line))
}

/// Port of `normalizeQuery` in `vs/base/common/fuzzyScorer.ts`, as
/// `prepareQuery(...).normalizedLowercase` — the form stock's `FileSearchEngine`
/// matches a file pattern in.
///
/// The separator rewrite goes *towards the native one*: a Windows user typing
/// `maha/lic` means `maha\lic`, which is how the relative path being matched is
/// spelled. Rewriting the other way makes every query containing a separator
/// match nothing, since no candidate path holds the foreign one.
pub fn normalize_query(query: &str) -> String {
    let path_normalized = if cfg!(windows) {
        query.replace('/', "\\")
    } else {
        query.replace('\\', "/")
    };

    // Quotes, wildcards, whitespace and the ellipsis steer the *scorer*, not the
    // match, so stock drops them; so is a trailing `#`, which some language
    // servers append as a query modifier.
    let mut normalized: String = path_normalized
        .chars()
        .filter(|c| !matches!(c, '*' | '\u{2026}' | '"') && !c.is_whitespace())
        .collect();
    if normalized.len() > 1 && normalized.ends_with('#') {
        normalized.pop();
    }

    normalized.to_lowercase()
}

/// Port of `strings.fuzzyContains` — every character of `query`, in order,
/// somewhere in `target`.
pub fn fuzzy_contains(target: &str, query: &str) -> bool {
    if target.is_empty() || query.is_empty() {
        return false;
    }
    if utf16_len(target) < utf16_len(query) {
        return false;
    }

    let target_lower: Vec<char> = target.to_lowercase().chars().collect();
    let mut last_index_of: isize = -1;
    for qc in query.to_lowercase().chars() {
        let from = (last_index_of + 1) as usize;
        match target_lower[from.min(target_lower.len())..].iter().position(|&c| c == qc) {
            Some(offset) => last_index_of = (from + offset) as isize,
            None => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_query_rewrites_towards_the_native_separator() {
        let native = std::path::MAIN_SEPARATOR;
        assert_eq!(normalize_query("maha/lic"), format!("maha{native}lic"));
        assert_eq!(normalize_query("maha\\lic"), format!("maha{native}lic"));
    }

    #[test]
    fn normalize_query_drops_the_characters_stock_drops() {
        assert_eq!(normalize_query("A *b\u{2026} \"c\""), "abc");
        assert_eq!(normalize_query("rust#"), "rust");
        // Stock's lookbehind keeps a lone `#`, which is a query in its own right.
        assert_eq!(normalize_query("#"), "#");
    }

    #[test]
    fn get_n_lines_matches_stock() {
        assert_eq!(get_n_lines("a\nb\nc", 0), "");
        assert_eq!(get_n_lines("a\nb\nc", 1), "a");
        assert_eq!(get_n_lines("a\nb\nc", 2), "a\nb");
        assert_eq!(get_n_lines("a\nb\nc", 9), "a\nb\nc");
        assert_eq!(get_n_lines("no newline", 1), "no newline");
        assert_eq!(get_n_lines("a\r\nb", 1), "a");
    }

    #[test]
    fn num_lines_and_last_line_len_counts_utf16() {
        assert_eq!(num_lines_and_last_line_len(""), (0, 0));
        assert_eq!(num_lines_and_last_line_len("abc"), (0, 3));
        assert_eq!(num_lines_and_last_line_len("abc\n"), (1, 0));
        assert_eq!(num_lines_and_last_line_len("abc\nde"), (1, 2));
        // Astral plane characters are two UTF-16 code units, as JS counts them.
        assert_eq!(num_lines_and_last_line_len("\u{1F600}"), (0, 2));
    }

    #[test]
    fn utf16_slice_clamps_like_js() {
        let t = Utf16Text::new("hello");
        assert_eq!(t.slice(1, 3), "el");
        assert_eq!(t.slice(3, 1), "");
        assert_eq!(t.slice(2, 99), "llo");
        let wide = Utf16Text::new("héllo");
        assert_eq!(wide.len(), 5);
        assert_eq!(wide.slice(0, 2), "hé");
    }

    #[test]
    fn fuzzy_contains_matches_stock() {
        assert!(fuzzy_contains("src/vs/base/common/uri.ts", "uri"));
        assert!(fuzzy_contains("src/vs/base/common/uri.ts", "vsuri"));
        assert!(!fuzzy_contains("src/vs/base/common/uri.ts", "uriz"));
        assert!(!fuzzy_contains("ab", "abc"));
        assert!(!fuzzy_contains("", "a"));
        assert!(!fuzzy_contains("a", ""));
    }
}
