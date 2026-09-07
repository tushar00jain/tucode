//! Errors, numbered to match stock `SearchErrorCode` in
//! `vs/workbench/services/search/common/search.ts` so `deserializeSearchError`
//! rehydrates them on the frontend.

/// Mirrors stock `SearchErrorCode`. The numbering is load-bearing — it crosses
/// the IPC boundary as an integer, which is what `serde_repr` emits; a plain
/// `Serialize` would send the variant name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde_repr::Serialize_repr)]
#[repr(u8)]
pub enum SearchErrorCode {
    UnknownEncoding = 1,
    RegexParseError = 2,
    GlobParseError = 3,
    InvalidLiteral = 4,
    RgProcessError = 5,
    Other = 6,
    Canceled = 7,
}

#[derive(Debug, thiserror::Error)]
pub enum SearchError {
    #[error("unknown encoding: {0}")]
    UnknownEncoding(String),
    #[error("{0}")]
    RegexParse(String),
    #[error("{0}")]
    GlobParse(String),
    #[error("{0}")]
    InvalidLiteral(String),
    #[error("{0}")]
    Engine(String),
    #[error("search canceled")]
    Canceled,
    #[error("{0}")]
    Other(String),
}

impl SearchError {
    pub fn code(&self) -> SearchErrorCode {
        match self {
            Self::UnknownEncoding(_) => SearchErrorCode::UnknownEncoding,
            Self::RegexParse(_) => SearchErrorCode::RegexParseError,
            Self::GlobParse(_) => SearchErrorCode::GlobParseError,
            Self::InvalidLiteral(_) => SearchErrorCode::InvalidLiteral,
            Self::Engine(_) => SearchErrorCode::RgProcessError,
            Self::Canceled => SearchErrorCode::Canceled,
            Self::Other(_) => SearchErrorCode::Other,
        }
    }
}

impl From<std::io::Error> for SearchError {
    fn from(e: std::io::Error) -> Self {
        Self::Engine(e.to_string())
    }
}
