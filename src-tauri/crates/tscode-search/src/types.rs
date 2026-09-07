//! Result model. A direct port of the stock search types in
//! `vs/workbench/services/search/common/search.ts` — `ISerializedFileMatch`,
//! `ITextSearchResult`, `ISearchRange`, `SearchRangeSetPairing`,
//! `ISerializedSearchSuccess`. Field names serialize camelCase so the frontend
//! deserializes straight into the stock interfaces with no adapter layer.

use serde::Serialize;

/// Stock `ISearchRange`. Line numbers and columns are **0-based**, and columns
/// are UTF-16 code-unit offsets — the units the TS side counts in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRange {
    pub start_line_number: u32,
    pub start_column: u32,
    pub end_line_number: u32,
    pub end_column: u32,
}

impl SearchRange {
    pub fn new(
        start_line_number: u32,
        start_column: u32,
        end_line_number: u32,
        end_column: u32,
    ) -> Self {
        Self { start_line_number, start_column, end_line_number, end_column }
    }

    /// Stock `OneLineRange`.
    pub fn one_line(line_number: u32, start_column: u32, end_column: u32) -> Self {
        Self::new(line_number, start_column, line_number, end_column)
    }
}

/// Stock `SearchRangeSetPairing`: where the match is in the file, and where the
/// same match landed in the (possibly elided) preview text.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct SearchRangeSetPairing {
    pub source: SearchRange,
    pub preview: SearchRange,
}

/// Stock `ITextSearchMatch`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchMatch {
    pub range_locations: Vec<SearchRangeSetPairing>,
    pub preview_text: String,
}

/// Stock `ITextSearchContext` — a surrounding-context line, no match in it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchContext {
    pub text: String,
    /// 1-based, as stock emits it (`RipgrepParser.createTextSearchContexts`).
    pub line_number: u32,
}

/// Stock `ITextSearchResult` — an untagged union on the wire, discriminated by
/// `resultIsMatch` (presence of `rangeLocations` + `previewText`).
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum TextSearchResult {
    Match(TextSearchMatch),
    Context(TextSearchContext),
}

/// Stock `ISerializedFileMatch`. File search emits these with empty `results`,
/// exactly as `rawSearchService.rawMatchToSearchItem` does.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerializedFileMatch {
    pub path: String,
    pub results: Vec<TextSearchResult>,
    pub num_matches: usize,
}

impl SerializedFileMatch {
    pub fn new(path: String, results: Vec<TextSearchResult>) -> Self {
        let num_matches = results
            .iter()
            .map(|r| match r {
                TextSearchResult::Match(m) => m.range_locations.len(),
                TextSearchResult::Context(_) => 1,
            })
            .sum();
        Self { path, results, num_matches }
    }
}

/// Stock `IProgressMessage`.
#[derive(Debug, Clone, Serialize)]
pub struct ProgressMessage {
    pub message: String,
}

/// Stock `ISerializedSearchProgressItem`. Batches are the whole point: one
/// callback carries up to `batch::MAX_BATCH_SIZE` matches, never one per hit.
#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum SearchProgress {
    FileMatches(Vec<SerializedFileMatch>),
    Message(ProgressMessage),
}

/// Stock `ISearchEngineStats`. Times are milliseconds.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchEngineStats {
    pub file_walk_time: u64,
    pub directories_walked: usize,
    pub files_walked: usize,
    pub cmd_time: u64,
    pub cmd_result_count: usize,
}

/// Stock `ITextSearchCompleteMessage` minus the enum type, which we only ever
/// emit as `Information` (0).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchCompleteMessage {
    pub text: String,
    #[serde(rename = "type")]
    pub kind: u8,
}

/// Stock `ISerializedSearchSuccess`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchComplete {
    pub limit_hit: bool,
    pub stats: SearchEngineStats,
    pub messages: Vec<TextSearchCompleteMessage>,
}

/// Stock `IRawFileMatch`. Internal to file search — it is what the file-pattern
/// filter matches against before results are flattened to `SerializedFileMatch`.
#[derive(Debug, Clone)]
pub struct RawFileMatch {
    pub base: Option<String>,
    /// Path of the file relative to `base`, exactly as it appears on disk.
    pub relative_path: String,
    /// `relativePath` prefixed with the workspace folder name, when there is
    /// one, so the folder name is searchable too.
    pub search_path: Option<String>,
}

impl RawFileMatch {
    /// Port of `rawSearchService.rawMatchToSearchItem`.
    pub fn into_serialized(self) -> SerializedFileMatch {
        let path = match &self.base {
            Some(base) => std::path::Path::new(base)
                .join(&self.relative_path)
                .to_string_lossy()
                .into_owned(),
            None => self.relative_path.clone(),
        };
        SerializedFileMatch { path, results: Vec::new(), num_matches: 0 }
    }

    /// Port of `isFilePatternMatch`'s `pathToMatch`.
    pub fn path_to_match(&self) -> &str {
        self.search_path.as_deref().unwrap_or(&self.relative_path)
    }
}
