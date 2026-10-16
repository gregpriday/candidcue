//! Is this file an ONNX model at all? Asked before the C library is.
//!
//! `OnlineRecognizer::create` cannot fail politely on a damaged graph. A file
//! that onnxruntime cannot parse makes it throw a C++ exception, the exception
//! reaches the FFI boundary, and the process aborts — `catch_unwind` cannot
//! catch a foreign exception, and release builds are `panic = "abort"` in any
//! case. Measured (#258): an `encoder.int8.onnx` cut to 50 MB and a
//! `decoder.onnx` of the right length filled with random bytes both end the
//! process with exit 134, and the `Err` arm of `create` is never reached.
//!
//! So the only place a damaged graph can be refused is BEFORE that call, and
//! the refusal has to be cheap: it runs every time a model directory is judged,
//! which includes every status read Settings makes. Hashing ~170 MB there is
//! out of the question (#257).
//!
//! An `.onnx` file is one serialised protobuf `ModelProto`. Its top level is a
//! handful of fields — the shipping graphs have 7 to 19 — and `graph` (field 7)
//! is a single length-delimited field spanning almost the whole file. Walking
//! the top level is therefore a few reads and a few seeks, and the payloads are
//! never read at all.
//!
//! What the walk catches: a file truncated anywhere inside a field (its length
//! runs past the end), bytes that were never a protobuf (random data, zero
//! fill, an HTML error page — all fail on the first tag or soon after),
//! trailing junk, and a protobuf that is not a model (no graph).
//!
//! What it cannot catch, stated so nobody mistakes it for a proof: damage
//! INSIDE the graph. A flipped bit in a weight tensor parses and loads as a
//! wrong weight. Damage to the structure of a nested message — a node, an
//! initializer — still fails onnxruntime's parse and still aborts, because a
//! walk that descended into the graph would read every one of the encoder's
//! ~25,000 nested fields on every status call. That class needs the full
//! SHA-256 the install already performed, or native containment, and is not
//! what this module claims to have.

use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

/// `ModelProto.graph` in `onnx.proto`.
const GRAPH_FIELD: u64 = 7;

/// `ModelProto.opset_import`, which the ONNX spec requires of every model
/// since IR version 3. Requiring it as well as the graph means a file cut
/// cleanly at the end of its graph field — a field boundary, so the walk alone
/// would accept it — is still refused.
const OPSET_FIELD: u64 = 8;

/// The largest field number protobuf allows.
const MAX_FIELD: u64 = (1 << 29) - 1;

/// More top-level fields than any real model has, by two orders of magnitude.
///
/// Bounds the work, not the file. A corrupt file whose bytes happen to decode
/// as a run of two-byte varint fields would otherwise turn a check of a few
/// reads into one read per pair of bytes across 150 MB.
const FIELD_BUDGET: usize = 4096;

/// Check that `path` is a whole ONNX model envelope.
///
/// The error names the file and what was wrong with it, for a log; it is not
/// written for a presenter.
pub fn check_onnx_envelope(path: &Path) -> Result<(), String> {
    let file = std::fs::File::open(path)
        .map_err(|err| format!("could not open {}: {err}", path.display()))?;
    let len = file
        .metadata()
        .map_err(|err| format!("could not read the size of {}: {err}", path.display()))?
        .len();
    walk(&mut io::BufReader::new(file), len)
        .map_err(|reason| format!("{} is not a readable ONNX model: {reason}", path.display()))
}

/// Walk the top-level fields of a `len`-byte protobuf, seeking past payloads.
///
/// Generic so the tests can hand it a cursor — and a reader that counts what
/// is actually read, which is the only way to prove the payloads are skipped.
fn walk<R: Read + Seek>(reader: &mut R, len: u64) -> Result<(), String> {
    let mut at: u64 = 0;
    let mut fields = 0usize;
    let mut saw_graph = false;
    let mut saw_opset = false;
    while at < len {
        fields += 1;
        if fields > FIELD_BUDGET {
            return Err(format!("more than {FIELD_BUDGET} top-level fields"));
        }
        let start = at;
        let tag = read_varint(reader, &mut at)?;
        let field = tag >> 3;
        let wire = tag & 7;
        if field == 0 || field > MAX_FIELD {
            return Err(format!("field number {field} at byte {start}"));
        }
        let payload = match wire {
            // A varint is its own payload, read rather than skipped.
            0 => {
                read_varint(reader, &mut at)?;
                0
            }
            1 => 8,
            2 => read_varint(reader, &mut at)?,
            5 => 4,
            // 3 and 4 are the deprecated groups, which `onnx.proto` never
            // uses; 6 and 7 are not wire types at all.
            other => return Err(format!("wire type {other} at byte {start}")),
        };
        // Bounds BEFORE the seek: seeking past the end of a file succeeds, so
        // the seek cannot be what notices a truncated field.
        let end = at
            .checked_add(payload)
            .filter(|end| *end <= len)
            .ok_or_else(|| {
                format!(
                    "field {field} at byte {start} claims {payload} bytes, past the end of \
                     the {len}-byte file"
                )
            })?;
        match field {
            GRAPH_FIELD if wire != 2 || payload == 0 => {
                return Err(format!("the graph field at byte {start} is not a message"));
            }
            GRAPH_FIELD => saw_graph = true,
            OPSET_FIELD => saw_opset = true,
            _ => {}
        }
        if payload > 0 {
            reader
                .seek(SeekFrom::Start(end))
                .map_err(|err| format!("could not seek to byte {end}: {err}"))?;
        }
        at = end;
    }
    if !saw_graph {
        return Err("it holds no graph".to_string());
    }
    if !saw_opset {
        return Err("it declares no opset".to_string());
    }
    Ok(())
}

/// Read one base-128 varint, advancing `at` by the bytes it took.
fn read_varint<R: Read>(reader: &mut R, at: &mut u64) -> Result<u64, String> {
    let mut value: u64 = 0;
    for index in 0..10u32 {
        let mut byte = [0u8; 1];
        reader.read_exact(&mut byte).map_err(|err| {
            if err.kind() == io::ErrorKind::UnexpectedEof {
                format!("the file ends inside a field at byte {at}")
            } else {
                format!("could not read byte {at}: {err}")
            }
        })?;
        *at += 1;
        // The tenth byte carries bit 63 and nothing above it — which also
        // makes it the last: a tenth byte of 0 or 1 has no continuation bit.
        if index == 9 && byte[0] > 1 {
            return Err(format!("a varint overflows 64 bits at byte {at}"));
        }
        value |= u64::from(byte[0] & 0x7f) << (7 * index);
        if byte[0] & 0x80 == 0 {
            return Ok(value);
        }
    }
    // Not reached — the tenth byte always returns above — but an `Err` rather
    // than `unreachable!`: a panic here is an abort, in the one function whose
    // job is to prevent one.
    Err(format!("a varint runs past ten bytes at byte {at}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn varint(mut value: u64) -> Vec<u8> {
        let mut out = Vec::new();
        loop {
            let byte = (value & 0x7f) as u8;
            value >>= 7;
            if value == 0 {
                out.push(byte);
                return out;
            }
            out.push(byte | 0x80);
        }
    }

    fn tag(field: u64, wire: u64) -> Vec<u8> {
        varint(field << 3 | wire)
    }

    fn varint_field(field: u64, value: u64) -> Vec<u8> {
        [tag(field, 0), varint(value)].concat()
    }

    fn bytes_field(field: u64, payload: &[u8]) -> Vec<u8> {
        [tag(field, 2), varint(payload.len() as u64), payload.to_vec()].concat()
    }

    /// The shape of the shipping graphs: ir_version, producer, graph, opset.
    fn model(graph: &[u8]) -> Vec<u8> {
        [
            varint_field(1, 7),
            bytes_field(2, b"pytorch"),
            bytes_field(GRAPH_FIELD, graph),
            bytes_field(OPSET_FIELD, &varint_field(2, 13)),
        ]
        .concat()
    }

    fn check(bytes: &[u8]) -> Result<(), String> {
        walk(&mut Cursor::new(bytes), bytes.len() as u64)
    }

    /// Deterministic noise, so a failure reproduces.
    fn noise(len: usize) -> Vec<u8> {
        let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
        (0..len)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                (state >> 24) as u8
            })
            .collect()
    }

    #[test]
    fn a_whole_model_passes() {
        check(&model(&[0x0a, 0x03, b'a', b'd', b'd'])).unwrap();
    }

    /// Every wire type `onnx.proto` can put at the top level, in any order —
    /// a serialiser is not obliged to write fields in field-number order.
    #[test]
    fn every_wire_type_and_any_field_order_is_accepted() {
        let bytes = [
            bytes_field(OPSET_FIELD, &varint_field(2, 13)),
            [tag(20, 1), vec![0; 8]].concat(),
            bytes_field(GRAPH_FIELD, b"graph"),
            [tag(21, 5), vec![0; 4]].concat(),
            varint_field(1, u64::MAX),
            bytes_field(14, b"metadata"),
        ]
        .concat();
        check(&bytes).unwrap();
    }

    /// The truncated encoder from #258, in miniature. A cut anywhere is
    /// refused — including at a field boundary after the graph, which is why
    /// the opset is required too.
    #[test]
    fn every_truncation_is_refused() {
        let whole = model(&noise(300));
        for cut in 0..whole.len() {
            assert!(
                check(&whole[..cut]).is_err(),
                "a model cut to {cut} of {} bytes was accepted",
                whole.len()
            );
        }
    }

    /// The other #258 case: the right length, the wrong bytes.
    #[test]
    fn random_bytes_of_the_right_length_are_refused() {
        let len = model(&noise(4096)).len();
        let error = check(&noise(len)).unwrap_err();
        assert!(!error.is_empty());
    }

    #[test]
    fn zero_fill_is_refused() {
        let error = check(&[0u8; 4096]).unwrap_err();
        assert!(error.contains("field number 0"), "{error}");
    }

    /// What a captive portal hands back in place of a file.
    #[test]
    fn an_html_page_is_refused() {
        let error = check(b"<!DOCTYPE html><html><body>Sign in</body></html>").unwrap_err();
        assert!(error.contains("wire type"), "{error}");
    }

    #[test]
    fn an_empty_file_is_refused() {
        let error = check(&[]).unwrap_err();
        assert!(error.contains("no graph"), "{error}");
    }

    #[test]
    fn trailing_junk_is_refused() {
        let mut bytes = model(b"graph");
        bytes.extend_from_slice(&noise(64));
        assert!(check(&bytes).is_err());
    }

    #[test]
    fn a_protobuf_without_a_graph_is_refused() {
        let bytes = [varint_field(1, 7), bytes_field(OPSET_FIELD, &varint_field(2, 13))].concat();
        let error = check(&bytes).unwrap_err();
        assert!(error.contains("no graph"), "{error}");
    }

    #[test]
    fn a_model_without_an_opset_is_refused() {
        let bytes = [varint_field(1, 7), bytes_field(GRAPH_FIELD, b"graph")].concat();
        let error = check(&bytes).unwrap_err();
        assert!(error.contains("no opset"), "{error}");
    }

    #[test]
    fn a_graph_that_is_not_a_message_is_refused() {
        for graph in [
            varint_field(GRAPH_FIELD, 1),
            bytes_field(GRAPH_FIELD, b""),
        ] {
            let bytes = [graph, bytes_field(OPSET_FIELD, b"x")].concat();
            let error = check(&bytes).unwrap_err();
            assert!(error.contains("graph field"), "{error}");
        }
    }

    #[test]
    fn groups_and_invalid_wire_types_are_refused() {
        for wire in [3, 4, 6, 7] {
            let bytes = [tag(1, wire), model(b"graph")].concat();
            let error = check(&bytes).unwrap_err();
            assert!(error.contains(&format!("wire type {wire}")), "{error}");
        }
    }

    #[test]
    fn an_overflowing_varint_is_refused() {
        let mut bytes = tag(1, 0);
        bytes.extend_from_slice(&[0xff; 9]);
        bytes.push(0x02);
        let error = check(&bytes).unwrap_err();
        assert!(error.contains("overflows"), "{error}");
    }

    /// A length near `u64::MAX` must not wrap round to something in bounds.
    #[test]
    fn a_length_that_would_overflow_is_refused() {
        let bytes = [tag(GRAPH_FIELD, 2), varint(u64::MAX - 1)].concat();
        let error = check(&bytes).unwrap_err();
        assert!(error.contains("past the end"), "{error}");
    }

    #[test]
    fn a_field_past_the_largest_protobuf_number_is_refused() {
        let bytes = [varint((MAX_FIELD + 1) << 3), varint(0)].concat();
        let error = check(&bytes).unwrap_err();
        assert!(error.contains("field number"), "{error}");
    }

    /// The work is bounded even when the bytes decode as an endless run of
    /// tiny fields.
    #[test]
    fn a_file_of_endless_tiny_fields_runs_out_of_budget() {
        let bytes: Vec<u8> = std::iter::repeat(varint_field(1, 0))
            .take(FIELD_BUDGET + 1)
            .flatten()
            .collect();
        let error = check(&bytes).unwrap_err();
        assert!(error.contains("top-level fields"), "{error}");
    }

    /// Counts the bytes actually read, which is what this check costs.
    struct Counting<R> {
        inner: R,
        read: u64,
    }

    impl<R: Read> Read for Counting<R> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            let n = self.inner.read(buf)?;
            self.read += n as u64;
            Ok(n)
        }
    }

    impl<R: Seek> Seek for Counting<R> {
        fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
            self.inner.seek(pos)
        }
    }

    /// The point of the design: a megabyte of graph costs a few bytes of
    /// reading, because the payload is seeked past rather than read.
    #[test]
    fn the_graph_payload_is_skipped_not_read() {
        let bytes = model(&vec![0u8; 1 << 20]);
        let mut reader = Counting {
            inner: Cursor::new(&bytes),
            read: 0,
        };
        walk(&mut reader, bytes.len() as u64).unwrap();
        assert!(reader.read < 64, "read {} bytes of a {}-byte model", reader.read, bytes.len());
    }

    #[test]
    fn a_file_that_is_not_there_says_so() {
        let error = check_onnx_envelope(Path::new("/nonexistent/encoder.onnx")).unwrap_err();
        assert!(error.contains("could not open"), "{error}");
    }

    /// Through the real file API, not only a cursor.
    #[test]
    fn a_file_on_disk_is_checked_the_same_way() {
        let dir = std::env::temp_dir().join("cc-stt-envelope-on-disk");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("good.onnx");
        let cut = dir.join("cut.onnx");
        let whole = model(&noise(10_000));
        std::fs::write(&good, &whole).unwrap();
        std::fs::write(&cut, &whole[..whole.len() / 2]).unwrap();

        check_onnx_envelope(&good).unwrap();
        let error = check_onnx_envelope(&cut).unwrap_err();
        assert!(error.contains("cut.onnx"), "{error}");
        assert!(error.contains("past the end"), "{error}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
