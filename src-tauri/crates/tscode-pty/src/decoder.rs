//! Incremental UTF-8 decoding, replacing Node's `StringDecoder`.
//!
//! `TerminalProcess` treats pty output as a `string` because `node-pty` hands it
//! one: `UnixTerminal` and `WindowsPtyAgent` both pipe the master through a
//! `StringDecoder('utf8')`. A pty read boundary falls wherever the OS put it, so
//! a multi-byte character routinely straddles two reads — decoding each read on
//! its own would emit replacement characters in the middle of ordinary output,
//! and flow control counts *characters*, so the counts would drift too.
//!
//! This keeps the incomplete tail for the next read and, like `StringDecoder`,
//! emits `U+FFFD` for bytes that can never complete.

/// Holds the trailing bytes of a partial UTF-8 sequence between reads.
#[derive(Debug, Default)]
pub struct Utf8Decoder {
    partial: Vec<u8>,
}

impl Utf8Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode one read, carrying any incomplete trailing sequence forward.
    pub fn push(&mut self, chunk: &[u8]) -> String {
        self.partial.extend_from_slice(chunk);

        let mut decoded = String::with_capacity(self.partial.len());
        let mut consumed = 0;
        loop {
            match std::str::from_utf8(&self.partial[consumed..]) {
                Ok(text) => {
                    decoded.push_str(text);
                    consumed = self.partial.len();
                    break;
                }
                Err(error) => {
                    let valid_up_to = error.valid_up_to();
                    // Safe by construction: `valid_up_to` is the length of the
                    // longest valid prefix.
                    decoded.push_str(
                        std::str::from_utf8(&self.partial[consumed..consumed + valid_up_to])
                            .unwrap_or_default(),
                    );
                    consumed += valid_up_to;

                    match error.error_len() {
                        // An incomplete tail that a later read may complete.
                        None => break,
                        Some(invalid) => {
                            decoded.push('\u{FFFD}');
                            consumed += invalid;
                        }
                    }
                }
            }
        }

        self.partial.drain(..consumed);
        decoded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_ascii_passes_through() {
        let mut decoder = Utf8Decoder::new();
        assert_eq!(decoder.push(b"hello"), "hello");
    }

    #[test]
    fn a_character_split_across_reads_is_reassembled() {
        // U+2764 HEAVY BLACK HEART is e2 9d a4.
        let mut decoder = Utf8Decoder::new();
        assert_eq!(decoder.push(&[b'a', 0xe2, 0x9d]), "a");
        assert_eq!(decoder.push(&[0xa4, b'b']), "\u{2764}b");
    }

    #[test]
    fn a_character_split_one_byte_at_a_time_still_arrives_whole() {
        let mut decoder = Utf8Decoder::new();
        assert_eq!(decoder.push(&[0xe2]), "");
        assert_eq!(decoder.push(&[0x9d]), "");
        assert_eq!(decoder.push(&[0xa4]), "\u{2764}");
    }

    #[test]
    fn an_impossible_byte_becomes_the_replacement_character() {
        let mut decoder = Utf8Decoder::new();
        assert_eq!(decoder.push(&[b'a', 0xff, b'b']), "a\u{FFFD}b");
    }

    #[test]
    fn several_invalid_bytes_do_not_swallow_the_rest_of_the_read() {
        let mut decoder = Utf8Decoder::new();
        assert_eq!(decoder.push(&[0xff, 0xfe, b'x']), "\u{FFFD}\u{FFFD}x");
    }

    #[test]
    fn nothing_is_retained_once_a_sequence_completes() {
        let mut decoder = Utf8Decoder::new();
        decoder.push(&[0xe2, 0x9d]);
        decoder.push(&[0xa4]);
        assert!(decoder.partial.is_empty());
    }
}
