//! The `search` channel over `tscode_search`.
//!
//! The two events sit at two different stock boundaries. `fileSearch` is stock's
//! `IRawSearchService.fileSearch` (`vs/workbench/services/search/common/search.ts`),
//! so it takes a raw file query and needs the normalization below. `textSearch`
//! is stock's `TextSearchProvider2.provideTextSearchResults`, whose arguments are
//! already per-folder and already flattened by `TextSearchManager`, so it needs
//! none of it — and the sibling `when` clauses `resolvePatternsForProvider`
//! discards stay upstream, in the `QueryGlobTester` that re-tests every result.
//!
//! Both are `listen()` because stock streams progress items on the same channel
//! that finally delivers one completion; `clearCache` is a `call`.
//!
//! `SearchProgress` and `SearchComplete` are already stock's
//! `ISerializedSearchProgressItem` / `ISerializedSearchSuccess`, so a batch goes
//! down the sink as-is. Only the `type` discriminator, which lives on the
//! completion item rather than in the crate's result type, is added here.
//!
//! One [`CancellationToken`] per subscription, cancelled when the frontend
//! disposes the event — which is what stock's `CancellationToken` does one layer
//! up. The channel is shared: the search view's text query, the notebook
//! service's file queries and quick access's cache population are all in flight
//! at once, so no query may cancel another.

use std::sync::Arc;

use serde_json::{json as jsonf, Map, Value};
use tscode_fs::WorkspaceRoots;
use tscode_search::{
    file_search, text_search, CancellationToken, FileQuery, SearchComplete, SearchError,
    SearchProgress, TextSearchRequest,
};

use crate::channel::{ChannelError, EventSink, ServerChannel, Subscription};
use crate::channels::{unknown_command, unknown_event, Args, UriComponents};

const CHANNEL: &str = "search";

pub struct SearchChannel {
    roots: Arc<WorkspaceRoots>,
}

impl SearchChannel {
    pub fn new(roots: Arc<WorkspaceRoots>) -> Self {
        Self { roots }
    }

    /// Starts a query. `prepare` is the shape change the event's own stock
    /// boundary needs before the crate can deserialize it. Returns the teardown
    /// that cancels the query when the frontend disposes the event.
    fn start<Q, R, F>(
        &self,
        arg: Value,
        sink: EventSink,
        prepare: fn(&mut Value) -> Result<(), ChannelError>,
        run: R,
    ) -> Result<Subscription, ChannelError>
    where
        Q: serde::de::DeserializeOwned + Send + 'static,
        R: FnOnce(Q, Arc<WorkspaceRoots>, CancellationToken, Box<dyn FnMut(SearchProgress) + Send>) -> F
            + Send
            + 'static,
        F: std::future::Future<Output = Result<SearchComplete, SearchError>> + Send + 'static,
    {
        let mut query = Args::new(arg).at::<Value>(0)?;
        prepare(&mut query)?;
        let query: Q = serde_json::from_value(query)
            .map_err(|error| ChannelError::unknown(format!("bad search query: {error}")))?;

        let token = CancellationToken::new();
        let roots = Arc::clone(&self.roots);
        let cancel = token.clone();

        let progress_sink = sink.clone();
        let on_progress = Box::new(move |progress: SearchProgress| {
            emit(&progress_sink, &progress);
        });

        // `listen` runs under the registry's subscription lock, so the search
        // starts on the runtime rather than here.
        tokio::spawn(async move {
            let complete = run(query, roots, token, on_progress).await;
            emit(&sink, &completion_item(complete));
        });

        Ok(Subscription::new(move || cancel.cancel()))
    }
}

/// Pushes one payload, logging rather than failing — a search has no channel to
/// report a transport error on, and a disposed subscription swallows it anyway.
fn emit<T: serde::Serialize>(sink: &EventSink, payload: &T) {
    match serde_json::to_value(payload) {
        Ok(value) => {
            if let Err(error) = sink.emit(value) {
                log::warn!("search: dropping a progress item: {error}");
            }
        }
        Err(error) => log::error!("search: unserializable progress item: {error}"),
    }
}

/// Stock `ISerializedSearchComplete`. The error message is
/// `serializeSearchError`'s payload — `JSON.stringify({ message, code })` — so
/// `deserializeSearchError` rehydrates the stock `SearchError` with its code.
fn completion_item(complete: Result<SearchComplete, SearchError>) -> Value {
    match complete {
        Ok(success) => {
            let mut value = serde_json::to_value(success).unwrap_or_else(|_| jsonf!({}));
            if let Value::Object(fields) = &mut value {
                fields.insert("type".to_owned(), Value::String("success".to_owned()));
            }
            value
        }
        Err(error) => {
            let details = jsonf!({ "message": error.to_string(), "code": error.code() });
            jsonf!({
                "type": "error",
                "error": { "message": details.to_string(), "stack": "" },
            })
        }
    }
}

//#region Query normalization

/// `TextSearchProvider2`'s arguments already carry paths and flat glob lists —
/// `TextSearchManager` did both conversions — so nothing changes at that
/// boundary.
fn as_sent(_request: &mut Value) -> Result<(), ChannelError> {
    Ok(())
}

/// Rewrites a stock raw file query into the shape `tscode_search` deserializes.
///
/// Three things change at the boundary, and all are stock's own conversions:
/// `folder` and every `extraFileResources` entry arrive as `UriComponents` and
/// the crate wants paths, and include/exclude arrive as `glob.IExpression` and
/// the crate wants the flat glob list — the same list stock hands ripgrep as
/// `-g` args.
fn normalize_query(query: &mut Value) -> Result<(), ChannelError> {
    let Value::Object(fields) = query else {
        return Err(ChannelError::unknown("search query must be an object"));
    };

    let global_includes = take_expression(fields, "includePattern");
    let global_excludes = take_expression(fields, "excludePattern");

    fields.insert("includePattern".to_owned(), globs(&global_includes));
    fields.insert("excludePattern".to_owned(), globs(&global_excludes));

    if let Some(Value::Array(extra)) = fields.get_mut("extraFileResources") {
        for resource in extra.iter_mut() {
            *resource = Value::String(uri_to_path(resource)?);
        }
    }

    if let Some(Value::Array(folders)) = fields.get_mut("folderQueries") {
        for folder in folders.iter_mut() {
            let Value::Object(folder) = folder else { continue };

            if let Some(uri) = folder.get("folder") {
                let path = uri_to_path(uri)?;
                folder.insert("folder".to_owned(), Value::String(path));
            }

            let includes = merged(&global_includes, take_expression(folder, "includePattern"));
            let excludes = merged(&global_excludes, take_exclude_patterns(folder));
            folder.insert("includePattern".to_owned(), globs(&includes));
            folder.insert("excludePattern".to_owned(), globs(&excludes));
        }
    }

    Ok(())
}

/// Stock `URI.fsPath`, for the one query shape that still crosses as URIs.
fn uri_to_path(uri: &Value) -> Result<String, ChannelError> {
    let uri: UriComponents = serde_json::from_value(uri.clone())?;
    Ok(uri.to_fs_path().to_string_lossy().into_owned())
}

/// One `glob.IExpression` — a `{ pattern: boolean | siblingClause }` map.
type Expression = Map<String, Value>;

fn take_expression(fields: &mut Map<String, Value>, key: &str) -> Expression {
    match fields.remove(key) {
        Some(Value::Object(expression)) => expression,
        _ => Expression::new(),
    }
}

/// A folder query's `excludePattern` is `ExcludeGlobPattern[]`; every element's
/// `pattern` contributes, as `QueryGlobTester` treats them.
fn take_exclude_patterns(folder: &mut Map<String, Value>) -> Expression {
    let Some(Value::Array(entries)) = folder.remove("excludePattern") else {
        return Expression::new();
    };

    let mut merged = Expression::new();
    for entry in entries {
        if let Some(Value::Object(pattern)) = entry.get("pattern") {
            merged.extend(pattern.clone());
        }
    }
    merged
}

/// Stock's `{ ...globalPattern, ...folderPattern }`: the folder's entry wins.
fn merged(global: &Expression, folder: Expression) -> Expression {
    let mut merged = global.clone();
    merged.extend(folder);
    merged
}

/// Port of `resolvePatternsForProvider` in
/// `vs/workbench/services/search/common/search.ts` — the keys whose value is
/// literally `true`. A sibling clause is not a glob and is dropped, as it is
/// there; stock re-applies it above the engine, in `QueryGlobTester`.
fn globs(expression: &Expression) -> Value {
    Value::Array(
        expression
            .iter()
            .filter(|(_, value)| value.as_bool() == Some(true))
            .map(|(key, _)| Value::String(key.clone()))
            .collect(),
    )
}

//#endregion

#[async_trait::async_trait]
impl ServerChannel for SearchChannel {
    async fn call(&self, command: &str, _arg: Value) -> Result<Value, ChannelError> {
        match command {
            // We run in process and keep no file cache, so stock's cache key has
            // nothing to clear.
            "clearCache" => Ok(Value::Null),
            other => Err(unknown_command(CHANNEL, other)),
        }
    }

    fn listen(&self, event: &str, arg: Value, sink: EventSink) -> Result<Subscription, ChannelError> {
        match event {
            "fileSearch" => {
                self.start::<FileQuery, _, _>(arg, sink, normalize_query, |query, roots, token, on_progress| {
                    file_search(query, roots, token, on_progress)
                })
            }
            "textSearch" => {
                self.start::<TextSearchRequest, _, _>(arg, sink, as_sent, |request, roots, token, on_progress| {
                    text_search(request, roots, token, on_progress)
                })
            }
            other => Err(unknown_event(CHANNEL, other)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_expressions_and_uris() {
        let mut query = jsonf!({
            "excludePattern": { "**/node_modules": true, "**/off": false },
            "folderQueries": [{
                "folder": { "scheme": "file", "path": "/w/project" },
                "excludePattern": [{ "pattern": { "**/dist": true } }],
                "includePattern": { "src/**": true }
            }]
        });

        normalize_query(&mut query).unwrap();

        assert_eq!(query["excludePattern"], jsonf!(["**/node_modules"]));

        let folder = &query["folderQueries"][0];
        assert!(folder["folder"].as_str().unwrap().ends_with("project"));
        assert_eq!(folder["includePattern"], jsonf!(["src/**"]));

        let mut excludes: Vec<&str> = folder["excludePattern"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        excludes.sort_unstable();
        assert_eq!(excludes, ["**/dist", "**/node_modules"]);
    }

    /// The whole backend hop, from the JSON stock's `TextSearchManager` hands a
    /// `TextSearchProvider2` to matches out of the crate.
    #[tokio::test]
    async fn a_stock_provider_call_finds_a_match_at_the_workspace_root() {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(tmp.path().join("root.txt"), "alpha needle omega\r\n").unwrap();
        let roots = Arc::new(tscode_fs::WorkspaceRoots::new());
        roots.add_root(tmp.path()).await.unwrap();

        // The payload `ChannelTextSearchProvider` sends: stock's
        // `TextSearchProviderOptions`, with each folder as the `fsPath` the
        // backend addresses rather than the renderer's `URI`.
        let mut request = jsonf!({
            "query": { "pattern": "needle", "isRegExp": false, "isCaseSensitive": false },
            "options": {
                "folderOptions": [{
                    "folder": tmp.path().to_string_lossy(),
                    "includes": [],
                    "excludes": ["**/node_modules", "**/.git"],
                    "useIgnoreFiles": { "local": true, "parent": true, "global": true },
                    "followSymlinks": true,
                    "encoding": "",
                }],
                "maxResults": 20000,
                "previewOptions": { "matchLines": 1, "charsPerLine": 250 },
                "surroundingContext": 0,
            },
        });
        as_sent(&mut request).unwrap();
        let request: TextSearchRequest = serde_json::from_value(request).unwrap();

        let (tx, rx) = std::sync::mpsc::channel();
        text_search(request, roots, CancellationToken::new(), move |progress| {
            if let SearchProgress::FileMatches(matches) = progress {
                for one in matches {
                    let _ = tx.send(one);
                }
            }
        })
        .await
        .unwrap();

        let matches: Vec<_> = rx.into_iter().collect();
        assert_eq!(matches.len(), 1, "{matches:?}");
        assert!(matches[0].path.ends_with("root.txt"), "{matches:?}");
        assert_eq!(matches[0].num_matches, 1);
    }

    #[test]
    fn a_success_carries_stocks_type_discriminator() {
        let item = completion_item(Ok(SearchComplete::default()));
        assert_eq!(item["type"], jsonf!("success"));
        assert_eq!(item["limitHit"], jsonf!(false));
    }
}
