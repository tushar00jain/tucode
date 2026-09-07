//! Walker construction, shared by file and text search.
//!
//! Port of `ripgrepTextSearchEngine.getRgArgs` — every ripgrep flag stock passes
//! has a direct counterpart on `ignore::WalkBuilder`, since that is the crate
//! behind the flags. Include/exclude globs go through `OverrideBuilder`, which is
//! what ripgrep's `-g` builds too.
//!
//! The two searches are asked at different stock boundaries and so name the same
//! settings differently — `IFolderQuery`'s three `disregard*IgnoreFiles` flags
//! are `TextSearchProviderFolderOptions.useIgnoreFiles` at the provider
//! boundary. [`WalkSpec`] is the one shape the walker is built from, and each
//! caller converts into it.

use std::path::Path;

use ignore::overrides::{Override, OverrideBuilder};
use ignore::{WalkBuilder, WalkParallel};

use crate::error::SearchError;
use crate::query::{
    CommonQuery, FolderQuery, TextSearchFolderOptions, TextSearchProviderOptions, UseIgnoreFiles,
};

/// Port of `ripgrepSearchUtils.anchorGlob`.
fn anchor_glob(glob: &str) -> String {
    if glob.starts_with("**") || glob.starts_with('/') {
        glob.to_string()
    } else {
        format!("/{glob}")
    }
}

/// Port of `glob.splitGlobAware` — splits on `split_char` but not inside braces
/// or brackets.
fn split_glob_aware(pattern: &str, split_char: char) -> Vec<String> {
    if pattern.is_empty() {
        return Vec::new();
    }

    let mut segments = Vec::new();
    let mut in_braces = false;
    let mut in_brackets = false;
    let mut cur = String::new();

    for ch in pattern.chars() {
        if ch == split_char && !in_braces && !in_brackets {
            segments.push(std::mem::take(&mut cur));
            continue;
        }
        match ch {
            '{' => in_braces = true,
            '}' => in_braces = false,
            '[' => in_brackets = true,
            ']' => in_brackets = false,
            _ => {}
        }
        cur.push(ch);
    }

    if !cur.is_empty() {
        segments.push(cur);
    }
    segments
}

/// Port of `ripgrepTextSearchEngine.spreadGlobComponents`:
/// `foo/*bar/something` -> `["foo", "foo/*bar", "foo/*bar/something"]`, so an
/// include glob whitelists the directories on the way to its target rather than
/// pruning them.
fn spread_glob_components(glob: &str) -> Vec<String> {
    let components = split_glob_aware(glob, '/');
    (0..components.len())
        .map(|i| components[..=i].join("/"))
        .collect()
}

/// One folder's walk settings, as `getRgArgs` reads them off
/// `TextSearchProviderFolderOptions`.
pub(crate) struct WalkSpec {
    pub includes: Vec<String>,
    pub excludes: Vec<String>,
    pub ignore_glob_case: bool,
    pub use_ignore_files: UseIgnoreFiles,
    pub follow_symlinks: bool,
    pub max_file_size: Option<u64>,
}

impl WalkSpec {
    /// File search's boundary is `IRawSearchService`, so its patterns arrive
    /// query-wide *and* per folder; the merge is the one `QueryGlobTester` does.
    pub fn for_file_query(common: &CommonQuery, folder: &FolderQuery) -> Self {
        let use_local = !folder.disregard_ignore_files;
        Self {
            includes: common
                .include_pattern
                .iter()
                .chain(folder.include_pattern.iter())
                .cloned()
                .collect(),
            excludes: common
                .exclude_pattern
                .iter()
                .chain(folder.exclude_pattern.iter())
                .cloned()
                .collect(),
            ignore_glob_case: common.ignore_glob_case || folder.ignore_glob_case,
            use_ignore_files: UseIgnoreFiles {
                local: use_local,
                parent: use_local && !folder.disregard_parent_ignore_files,
                global: use_local && !folder.disregard_global_ignore_files,
            },
            follow_symlinks: !folder.ignore_symlinks,
            max_file_size: None,
        }
    }

    /// Text search's boundary is `TextSearchProvider2`, so `TextSearchManager`
    /// has already merged and flattened everything.
    pub fn for_folder_options(
        options: &TextSearchProviderOptions,
        folder: &TextSearchFolderOptions,
    ) -> Self {
        Self {
            includes: folder.includes.clone(),
            excludes: folder.excludes.iter().map(|e| e.pattern().to_owned()).collect(),
            ignore_glob_case: folder.ignore_glob_case,
            use_ignore_files: folder.use_ignore_files,
            follow_symlinks: folder.follow_symlinks,
            max_file_size: options.max_file_size,
        }
    }
}

/// Builds the `Override` for one folder.
fn build_overrides(root: &Path, spec: &WalkSpec) -> Result<Override, SearchError> {
    let mut builder = OverrideBuilder::new(root);
    builder
        .case_insensitive(spec.ignore_glob_case)
        .map_err(|e| SearchError::GlobParse(e.to_string()))?;

    for include in &spec.includes {
        if include.starts_with("**") {
            builder
                .add(include)
                .map_err(|e| SearchError::GlobParse(e.to_string()))?;
        } else {
            for component in spread_glob_components(include) {
                builder
                    .add(&anchor_glob(&component))
                    .map_err(|e| SearchError::GlobParse(e.to_string()))?;
            }
        }
    }

    for exclude in &spec.excludes {
        builder
            .add(&format!("!{}", anchor_glob(exclude)))
            .map_err(|e| SearchError::GlobParse(e.to_string()))?;
    }

    builder.build().map_err(|e| SearchError::GlobParse(e.to_string()))
}

/// Builds the parallel walker for one folder.
///
/// `root` is the folder as [`crate::roots::validate_roots`] resolved it, not as
/// the query spelled it: the walk and the `strip_prefix` that turns an entry
/// into a relative path must start from the same string, or every entry falls
/// out of the search with nothing said.
pub(crate) fn build_walker(root: &Path, spec: &WalkSpec) -> Result<WalkParallel, SearchError> {
    let local = spec.use_ignore_files.local;
    let mut builder = WalkBuilder::new(root);
    builder
        // stock passes --hidden --no-require-git
        .hidden(false)
        .require_git(false)
        .ignore(local)
        .git_ignore(local)
        .git_exclude(local)
        .git_global(local && spec.use_ignore_files.global)
        .parents(local && spec.use_ignore_files.parent)
        .follow_links(spec.follow_symlinks)
        .max_filesize(spec.max_file_size)
        .overrides(build_overrides(root, spec)?);

    Ok(builder.build_parallel())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchor_glob_matches_stock() {
        assert_eq!(anchor_glob("src/**"), "/src/**");
        assert_eq!(anchor_glob("**/*.ts"), "**/*.ts");
        assert_eq!(anchor_glob("/already"), "/already");
    }

    #[test]
    fn split_glob_aware_ignores_separators_inside_braces_and_brackets() {
        assert_eq!(split_glob_aware("a/b/c", '/'), vec!["a", "b", "c"]);
        assert_eq!(split_glob_aware("a/{b,c/d}/e", '/'), vec!["a", "{b,c/d}", "e"]);
        assert_eq!(split_glob_aware("a/[b/c]/d", '/'), vec!["a", "[b/c]", "d"]);
        assert!(split_glob_aware("", '/').is_empty());
    }

    #[test]
    fn spread_glob_components_whitelists_each_prefix() {
        assert_eq!(
            spread_glob_components("foo/*bar/something"),
            vec!["foo", "foo/*bar", "foo/*bar/something"]
        );
    }

    /// Stock's `--no-ignore` turns *all three* off, so a folder query that
    /// disregards local ignore files must not keep reading parent or global ones.
    #[test]
    fn disregarding_local_ignore_files_disregards_parent_and_global_too() {
        let folder = FolderQuery {
            folder: "/root".into(),
            folder_name: None,
            exclude_pattern: Vec::new(),
            include_pattern: Vec::new(),
            ignore_glob_case: false,
            disregard_ignore_files: true,
            disregard_global_ignore_files: false,
            disregard_parent_ignore_files: false,
            ignore_symlinks: false,
        };

        let spec = WalkSpec::for_file_query(&CommonQuery::default(), &folder);
        assert!(!spec.use_ignore_files.local);
        assert!(!spec.use_ignore_files.parent);
        assert!(!spec.use_ignore_files.global);
    }
}
