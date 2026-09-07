//! Port of the stock `TextSearchMatch` constructor in
//! `vs/workbench/services/search/common/search.ts`: it turns a matched line plus
//! its source ranges into the preview text the search view renders, eliding the
//! gaps between distant matches on the same line and shifting the preview ranges
//! to compensate.

use crate::query::PreviewOptions;
use crate::text::{get_n_lines, Utf16Text};
use crate::types::{SearchRange, SearchRangeSetPairing, TextSearchMatch};

const SEARCH_ELIDED_PREFIX: &str = "⟪ ";
const SEARCH_ELIDED_SUFFIX: &str = " characters skipped ⟫";
/// Stock: `(prefix.length + suffix.length + 5) * 2`, in UTF-16 units.
const SEARCH_ELIDED_MIN_LEN: usize = (2 + 21 + 5) * 2;

pub fn build_text_search_match(
    text: &str,
    ranges: Vec<SearchRange>,
    preview_options: Option<&PreviewOptions>,
) -> TextSearchMatch {
    if let Some(options) = preview_options {
        if options.match_lines == 1 && is_single_line_range_list(&ranges) {
            return build_elided_preview(text, ranges, options);
        }
    }

    let first_match_line = ranges.first().map_or(0, |r| r.start_line_number);
    let range_locations = ranges
        .into_iter()
        .map(|r| SearchRangeSetPairing {
            preview: SearchRange::new(
                r.start_line_number - first_match_line,
                r.start_column,
                r.end_line_number - first_match_line,
                r.end_column,
            ),
            source: r,
        })
        .collect();

    TextSearchMatch { range_locations, preview_text: text.to_string() }
}

fn build_elided_preview(
    text: &str,
    ranges: Vec<SearchRange>,
    preview_options: &PreviewOptions,
) -> TextSearchMatch {
    let line = get_n_lines(text, preview_options.match_lines);
    let line = Utf16Text::new(line);

    let leading_chars = preview_options.chars_per_line / 5;
    let mut result = String::new();
    let mut range_locations = Vec::with_capacity(ranges.len());
    let mut shift: i64 = 0;
    let mut last_end: usize = 0;

    for range in ranges {
        let start_column = range.start_column as usize;
        let preview_start = start_column.saturating_sub(leading_chars);
        let preview_end = start_column.saturating_add(preview_options.chars_per_line);

        if preview_start > last_end + leading_chars + SEARCH_ELIDED_MIN_LEN {
            let elision = format!(
                "{SEARCH_ELIDED_PREFIX}{}{SEARCH_ELIDED_SUFFIX}",
                preview_start - last_end
            );
            shift += preview_start as i64 - (last_end + elision.chars().count()) as i64;
            result.push_str(&elision);
            result.push_str(&line.slice(preview_start, preview_end));
        } else {
            result.push_str(&line.slice(last_end, preview_end));
        }

        last_end = preview_end;
        range_locations.push(SearchRangeSetPairing {
            source: range,
            preview: SearchRange::one_line(
                0,
                shift_column(range.start_column, shift),
                shift_column(range.end_column, shift),
            ),
        });
    }

    TextSearchMatch { range_locations, preview_text: result }
}

fn shift_column(column: u32, shift: i64) -> u32 {
    (column as i64 - shift).max(0) as u32
}

/// Port of stock `isSingleLineRangeList`.
fn is_single_line_range_list(ranges: &[SearchRange]) -> bool {
    let Some(first) = ranges.first() else { return true };
    let line = first.start_line_number;
    ranges
        .iter()
        .all(|r| r.start_line_number == line && r.end_line_number == line)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn one(line: u32, start: u32, end: u32) -> SearchRange {
        SearchRange::one_line(line, start, end)
    }

    #[test]
    fn single_line_match_previews_the_line_and_keeps_columns() {
        let opts = PreviewOptions { match_lines: 1, chars_per_line: 10_000 };
        let m = build_text_search_match("hello world\n", vec![one(3, 6, 11)], Some(&opts));
        assert_eq!(m.preview_text, "hello world");
        assert_eq!(m.range_locations.len(), 1);
        assert_eq!(m.range_locations[0].source, one(3, 6, 11));
        assert_eq!(m.range_locations[0].preview, one(0, 6, 11));
    }

    /// Stock trims only when `matchLines === 1`; the default is 100, so the default
    /// options take the full-text branch — trailing newline included.
    #[test]
    fn default_options_keep_the_full_text() {
        let m = build_text_search_match(
            "hello world\n",
            vec![one(3, 6, 11)],
            Some(&PreviewOptions::default()),
        );
        assert_eq!(m.preview_text, "hello world\n");
        assert_eq!(m.range_locations[0].preview, one(0, 6, 11));
    }

    #[test]
    fn distant_matches_on_one_line_are_elided_and_preview_ranges_shift() {
        // charsPerLine 10 => leadingChars 2, so the second match is far enough
        // past the first window to trigger an elision.
        let opts = PreviewOptions { match_lines: 1, chars_per_line: 10 };
        let text = format!("{}x{}x", "a".repeat(5), "b".repeat(200));
        let ranges = vec![one(0, 5, 6), one(0, 206, 207)];
        let m = build_text_search_match(&text, ranges, Some(&opts));
        assert!(m.preview_text.contains(SEARCH_ELIDED_PREFIX));
        assert_eq!(m.range_locations[0].preview, one(0, 5, 6));
        // The second preview range must land inside the preview text it describes.
        let second = m.range_locations[1].preview;
        assert!(second.start_column < crate::text::utf16_len(&m.preview_text));
        assert_eq!(m.range_locations[1].source, one(0, 206, 207));
    }

    #[test]
    fn multiline_match_keeps_full_text_and_rebases_lines() {
        let opts = PreviewOptions { match_lines: 1, chars_per_line: 100 };
        let m = build_text_search_match("aa\nbb\n", vec![SearchRange::new(7, 0, 8, 2)], Some(&opts));
        assert_eq!(m.preview_text, "aa\nbb\n");
        assert_eq!(m.range_locations[0].preview, SearchRange::new(0, 0, 1, 2));
    }
}
