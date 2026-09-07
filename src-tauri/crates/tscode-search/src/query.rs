//! Query model, mirroring the stock types the two searches are asked in.
//!
//! The two are asked at *different* stock boundaries, so they take different
//! shapes:
//!
//! - **File search** is stock's `IRawSearchService.fileSearch`, so it takes
//!   `IFileQueryProps` / `ICommonQueryProps` / `IFolderQuery` from
//!   `vs/workbench/services/search/common/search.ts`. One shape change at the
//!   boundary: stock carries include/exclude as `glob.IExpression` (a
//!   `{ pattern: boolean }` map) and the channel layer flattens it with stock's
//!   own `resolvePatternsForProvider`, so this crate takes the resulting glob
//!   list.
//! - **Text search** is stock's `TextSearchProvider2.provideTextSearchResults`,
//!   so it takes `TextSearchQuery2` and `TextSearchProviderOptions` from
//!   `common/searchExtTypes.ts` — already per-folder, already flattened to glob
//!   lists by `TextSearchManager.getSearchOptionsForFolder`. Everything above
//!   that boundary, including the sibling `when` clauses a glob list cannot
//!   express, stays in stock's `TextSearchManager`.

use std::path::PathBuf;

use serde::{Deserialize, Deserializer};

/// Stock `IFolderQuery`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderQuery {
    pub folder: PathBuf,
    #[serde(default)]
    pub folder_name: Option<String>,
    #[serde(default)]
    pub exclude_pattern: Vec<String>,
    #[serde(default)]
    pub include_pattern: Vec<String>,
    #[serde(default)]
    pub ignore_glob_case: bool,
    #[serde(default)]
    pub disregard_ignore_files: bool,
    #[serde(default)]
    pub disregard_global_ignore_files: bool,
    #[serde(default)]
    pub disregard_parent_ignore_files: bool,
    #[serde(default)]
    pub ignore_symlinks: bool,
}

/// Stock `ICommonQueryProps`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonQuery {
    pub folder_queries: Vec<FolderQuery>,
    #[serde(default)]
    pub include_pattern: Vec<String>,
    #[serde(default)]
    pub exclude_pattern: Vec<String>,
    /// Files outside every workspace folder that the query still covers — the
    /// open editors `getOutOfWorkspaceEditorResources` collects. The channel
    /// layer turns stock's `UriComponents[]` into paths.
    #[serde(default)]
    pub extra_file_resources: Vec<PathBuf>,
    #[serde(default)]
    pub ignore_glob_case: bool,
    /// Zero means *no* limit, never "return nothing": stock's query builder
    /// defaults `maxResults` to 0 (quick access's cache-population query is one),
    /// and `FileSearchEngine` reads it as `config.maxResults || null`.
    #[serde(default, deserialize_with = "zero_is_no_limit")]
    pub max_results: Option<usize>,
}

fn zero_is_no_limit<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<usize>, D::Error> {
    Ok(Option::<usize>::deserialize(deserializer)?.filter(|max| *max > 0))
}

/// Stock `IFileQueryProps`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileQuery {
    #[serde(flatten)]
    pub common: CommonQuery,
    #[serde(default)]
    pub file_pattern: Option<String>,
    /// When set, `file_pattern` is a glob rather than a fuzzy pattern.
    #[serde(default)]
    pub should_glob_match_file_pattern: bool,
    /// Return no results; `limit_hit` reports whether at least one exists.
    #[serde(default)]
    pub exists: bool,
}

/// Stock `TextSearchQuery2`. Smart case is resolved into `is_case_sensitive` by
/// the frontend before the query is sent, exactly as stock does for ripgrep.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchQuery {
    pub pattern: String,
    #[serde(default)]
    pub is_reg_exp: bool,
    #[serde(default)]
    pub is_word_match: bool,
    #[serde(default)]
    pub is_multiline: bool,
    #[serde(default)]
    pub is_case_sensitive: bool,
}

/// Stock `TextSearchProviderFolderOptions.useIgnoreFiles`, which is how stock
/// spells `IFolderQuery`'s three `disregard*IgnoreFiles` flags at the provider
/// boundary.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UseIgnoreFiles {
    pub local: bool,
    pub parent: bool,
    pub global: bool,
}

/// Stock `GlobPattern` — a plain glob, or a `RelativePattern` carrying a base
/// URI. `getRgArgs` reads `typeof e === 'string' ? e : e.pattern`, so the base
/// URI is dropped here too.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum GlobPattern {
    Plain(String),
    Relative { pattern: String },
}

impl GlobPattern {
    pub fn pattern(&self) -> &str {
        match self {
            Self::Plain(pattern) => pattern,
            Self::Relative { pattern } => pattern,
        }
    }
}

/// Stock `TextSearchProviderFolderOptions`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchFolderOptions {
    pub folder: PathBuf,
    #[serde(default)]
    pub includes: Vec<String>,
    #[serde(default)]
    pub excludes: Vec<GlobPattern>,
    #[serde(default)]
    pub ignore_glob_case: bool,
    #[serde(default)]
    pub follow_symlinks: bool,
    #[serde(default)]
    pub use_ignore_files: UseIgnoreFiles,
    /// The canonical encoding name `TextSearchManager` resolved from the
    /// folder's `files.encoding`. Empty, or `utf8`, means the default — stock
    /// passes `--encoding` only for anything else.
    #[serde(default)]
    pub encoding: String,
}

/// Stock `ITextSearchPreviewOptions`.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewOptions {
    pub match_lines: usize,
    pub chars_per_line: usize,
}

impl Default for PreviewOptions {
    /// Stock `DEFAULT_TEXT_SEARCH_PREVIEW_OPTIONS`.
    fn default() -> Self {
        Self { match_lines: 100, chars_per_line: 10_000 }
    }
}

/// Stock `TextSearchProviderOptions`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextSearchProviderOptions {
    pub folder_options: Vec<TextSearchFolderOptions>,
    #[serde(default, deserialize_with = "zero_is_no_limit")]
    pub max_results: Option<usize>,
    #[serde(default)]
    pub preview_options: PreviewOptions,
    /// Stock caps this at 16 GB in `rawSearchService.getPlatformFileLimits`.
    #[serde(default)]
    pub max_file_size: Option<u64>,
    #[serde(default)]
    pub surrounding_context: usize,
}

/// The `textSearch` event's argument: the first two parameters of stock
/// `TextSearchProvider2.provideTextSearchResults`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TextSearchRequest {
    pub query: TextSearchQuery,
    pub options: TextSearchProviderOptions,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn max_results_zero_means_unlimited() {
        let unlimited: CommonQuery =
            serde_json::from_value(serde_json::json!({ "folderQueries": [], "maxResults": 0 }))
                .unwrap();
        assert_eq!(unlimited.max_results, None);

        let capped: CommonQuery =
            serde_json::from_value(serde_json::json!({ "folderQueries": [], "maxResults": 512 }))
                .unwrap();
        assert_eq!(capped.max_results, Some(512));

        let absent: CommonQuery =
            serde_json::from_value(serde_json::json!({ "folderQueries": [] })).unwrap();
        assert_eq!(absent.max_results, None);
    }

    #[test]
    fn a_glob_pattern_reads_the_same_whether_or_not_it_carries_a_base_uri() {
        let patterns: Vec<GlobPattern> = serde_json::from_value(serde_json::json!([
            "**/node_modules",
            { "baseUri": { "scheme": "file", "path": "/w" }, "pattern": "**/dist" }
        ]))
        .unwrap();

        let patterns: Vec<&str> = patterns.iter().map(GlobPattern::pattern).collect();
        assert_eq!(patterns, ["**/node_modules", "**/dist"]);
    }
}
