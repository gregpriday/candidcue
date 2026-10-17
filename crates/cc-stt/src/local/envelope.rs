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

/// `ModelProto.ir_version` in `onnx.proto`.
const IR_VERSION_FIELD: u64 = 1;

/// `ModelProto.graph`.
const GRAPH_FIELD: u64 = 7;

/// `ModelProto.opset_import`, which the ONNX spec requires of every model
/// since IR version 3. Requiring it as well as the graph means a file cut
/// cleanly at the end of its graph field — a field boundary, so the walk alone
/// would accept it — is still refused.
const OPSET_FIELD: u64 = 8;

/// The largest field number protobuf allows.
const MAX_FIELD: u64 = (1 << 29) - 1;

/// More top-level fields than any real model has, by three orders of
/// magnitude — the shipping graphs have 7 to 19, nearly all `metadata_props`.
///
/// Bounds the work, not the file. A corrupt file whose bytes happen to decode
/// as a run of two-byte varint fields would otherwise turn a check of a few
/// reads into one read per pair of bytes across 150 MB. With [`SCAN_BUFFER`]
/// the worst case this allows is a few megabytes of reading, which is the
/// price of not refusing a legitimate model that carries a lot of metadata.
const FIELD_BUDGET: usize = 1 << 16;

/// The read buffer for the walk, deliberately tiny.
///
/// Every length-delimited field ends in a seek, and a seek empties a
/// `BufReader`. The default 8 KiB buffer would refill — 8 KiB of reading — at
/// every top-level field to use a dozen bytes of it. Sixty-four bytes holds a
/// tag and a length many times over.
const SCAN_BUFFER: usize = 64;

/// An `opset_import` entry is a domain name and a version number. One larger
/// than this is not an `OperatorSetIdProto`, and is not read into memory to
/// find that out.
const OPSET_ENTRY_LIMIT: u64 = 1024;

/// The wire type `onnx.proto` gives each `ModelProto` field it defines.
///
/// A single flipped bit in a tag can keep a field's length and change its
/// type: `opset_import` read as a varint is a model with no opset, which
/// onnxruntime refuses by throwing. So a KNOWN field of the wrong type is
/// refused rather than skipped. An unknown field is skipped whatever its type —
/// a newer exporter is allowed fields this walk has never heard of.
fn expected_wire(field: u64) -> Option<u64> {
    match field {
        // ir_version, model_version.
        1 | 5 => Some(0),
        // producer_name, producer_version, domain, doc_string, graph,
        // opset_import, metadata_props, training_info, functions,
        // configuration.
        2 | 3 | 4 | 6 | 7 | 8 | 14 | 20 | 25 | 26 => Some(2),
        _ => None,
    }
}

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
    walk(&mut io::BufReader::with_capacity(SCAN_BUFFER, file), len)
        .map_err(|reason| format!("{} is not a readable ONNX model: {reason}", path.display()))
}

/// Walk the top-level fields of a `len`-byte protobuf, seeking past payloads.
///
/// Generic so the tests can hand it a cursor — and a reader that counts what
/// is actually read, which is the only way to prove the payloads are skipped.
fn walk<R: Read + Seek>(reader: &mut R, len: u64) -> Result<(), String> {
    let mut at: u64 = 0;
    let mut fields = 0usize;
    let mut saw_ir_version = false;
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
        if let Some(expected) = expected_wire(field) {
            if wire != expected {
                return Err(format!(
                    "field {field} at byte {start} has wire type {wire} where onnx.proto \
                     gives it {expected}"
                ));
            }
        }
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
            IR_VERSION_FIELD => saw_ir_version = true,
            GRAPH_FIELD if payload == 0 => {
                return Err(format!("the graph field at byte {start} is empty"));
            }
            GRAPH_FIELD => saw_graph = true,
            OPSET_FIELD => {
                // Small enough to read, and read rather than skipped: an opset
                // entry that is not a domain and a version is an opset
                // onnxruntime cannot resolve.
                if payload == 0 || payload > OPSET_ENTRY_LIMIT {
                    return Err(format!(
                        "the opset entry at byte {start} is {payload} bytes, which is not \
                         an opset"
                    ));
                }
                let mut entry = vec![0u8; payload as usize];
                reader
                    .read_exact(&mut entry)
                    .map_err(|err| format!("could not read byte {at}: {err}"))?;
                check_opset_entry(&entry)
                    .map_err(|reason| format!("the opset entry at byte {start} {reason}"))?;
                saw_opset = true;
                at = end;
                continue;
            }
            _ => {}
        }
        if payload > 0 {
            reader
                .seek(SeekFrom::Start(end))
                .map_err(|err| format!("could not seek to byte {end}: {err}"))?;
        }
        at = end;
    }
    if !saw_ir_version {
        return Err("it declares no IR version".to_string());
    }
    if !saw_graph {
        return Err("it holds no graph".to_string());
    }
    if !saw_opset {
        return Err("it declares no opset".to_string());
    }
    Ok(())
}

/// Check one `opset_import` entry: an `OperatorSetIdProto`, which is a domain
/// (field 1, a string) and a version (field 2, a varint) and nothing else.
///
/// The version is required. The domain is not: the default domain is the
/// empty string, which protobuf does not write at all.
fn check_opset_entry(entry: &[u8]) -> Result<(), String> {
    let len = entry.len() as u64;
    let mut reader = io::Cursor::new(entry);
    let mut at: u64 = 0;
    let mut saw_version = false;
    while at < len {
        let tag = read_varint(&mut reader, &mut at)?;
        match (tag >> 3, tag & 7) {
            (2, 0) => {
                read_varint(&mut reader, &mut at)?;
                saw_version = true;
            }
            (1, 2) => {
                let name = read_varint(&mut reader, &mut at)?;
                at = at
                    .checked_add(name)
                    .filter(|end| *end <= len)
                    .ok_or_else(|| "names a domain longer than itself".to_string())?;
                reader.set_position(at);
            }
            (field, wire) => {
                return Err(format!("holds field {field} with wire type {wire}"));
            }
        }
    }
    if !saw_version {
        return Err("has no version".to_string());
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

    /// Fields in any order — a serialiser is not obliged to write them in
    /// field-number order — and fields `onnx.proto` does not define, of every
    /// wire type, skipped: a newer exporter may add fields this has never seen.
    #[test]
    fn any_field_order_and_unknown_fields_of_every_wire_type_are_accepted() {
        let bytes = [
            bytes_field(OPSET_FIELD, &[bytes_field(1, b"com.microsoft"), varint_field(2, 1)].concat()),
            [tag(100, 1), vec![0; 8]].concat(),
            bytes_field(GRAPH_FIELD, b"graph"),
            [tag(101, 5), vec![0; 4]].concat(),
            varint_field(102, 7),
            bytes_field(103, b"future"),
            varint_field(1, u64::MAX),
            bytes_field(14, b"metadata"),
            bytes_field(OPSET_FIELD, &varint_field(2, 13)),
        ]
        .concat();
        check(&bytes).unwrap();
    }

    /// One flipped bit in a tag can keep a field's length and change its type.
    /// `42 02 10 0d` is `opset_import { version: 13 }`; `40 02 10 0d` is the
    /// same four bytes read as two varints, which is a model with no opset —
    /// and onnxruntime refuses one of those by throwing.
    #[test]
    fn an_opset_whose_tag_lost_a_bit_is_refused() {
        let mut bytes = model(b"graph");
        let opset = bytes.len() - 4;
        assert_eq!(bytes[opset..], [0x42, 0x02, 0x10, 0x0d]);
        bytes[opset] = 0x40;
        let error = check(&bytes).unwrap_err();
        assert!(error.contains("field 8"), "{error}");
    }

    /// Every field `onnx.proto` defines is held to its declared type.
    #[test]
    fn a_known_field_of_the_wrong_type_is_refused() {
        for wrong in [
            bytes_field(1, b"7"),
            varint_field(2, 1),
            [tag(14, 5), vec![0; 4]].concat(),
        ] {
            let bytes = [wrong, model(b"graph")].concat();
            let error = check(&bytes).unwrap_err();
            assert!(error.contains("where onnx.proto gives it"), "{error}");
        }
    }

    #[test]
    fn an_opset_entry_that_is_not_a_domain_and_a_version_is_refused() {
        for (entry, reason) in [
            (bytes_field(1, b"ai.onnx"), "no version"),
            (bytes_field(2, b"13"), "field 2 with wire type 2"),
            (varint_field(3, 1), "field 3"),
            ([tag(1, 2), varint(40), b"short".to_vec(), varint_field(2, 13)].concat(), "longer"),
            (vec![0x10], "ends inside a field"),
        ] {
            let bytes = [
                varint_field(1, 7),
                bytes_field(GRAPH_FIELD, b"graph"),
                bytes_field(OPSET_FIELD, &entry),
            ]
            .concat();
            let error = check(&bytes).unwrap_err();
            assert!(error.contains("opset entry"), "{reason}: {error}");
            assert!(error.contains(reason), "{reason}: {error}");
        }
    }

    #[test]
    fn an_opset_entry_too_large_to_be_one_is_refused_without_being_read() {
        let bytes = [
            varint_field(1, 7),
            bytes_field(GRAPH_FIELD, b"graph"),
            bytes_field(OPSET_FIELD, &vec![0x10; OPSET_ENTRY_LIMIT as usize + 1]),
        ]
        .concat();
        let error = check(&bytes).unwrap_err();
        assert!(error.contains("not an opset"), "{error}");
    }

    #[test]
    fn a_model_without_an_ir_version_is_refused() {
        let bytes = [bytes_field(GRAPH_FIELD, b"graph"), bytes_field(OPSET_FIELD, &varint_field(2, 13))]
            .concat();
        let error = check(&bytes).unwrap_err();
        assert!(error.contains("no IR version"), "{error}");
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
        assert!(error.contains("no IR version"), "{error}");
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
        let opset = bytes_field(OPSET_FIELD, &varint_field(2, 13));
        let as_varint = [varint_field(GRAPH_FIELD, 1), opset.clone()].concat();
        let error = check(&as_varint).unwrap_err();
        assert!(error.contains("field 7"), "{error}");

        let empty = [bytes_field(GRAPH_FIELD, b""), opset].concat();
        let error = check(&empty).unwrap_err();
        assert!(error.contains("graph field") && error.contains("empty"), "{error}");
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
        let bytes: Vec<u8> = std::iter::repeat_n(varint_field(1, 0), FIELD_BUDGET + 1)
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

    /// The point of the design: a megabyte of graph costs a few hundred bytes
    /// of reading, because the payload is seeked past rather than read.
    ///
    /// Counted UNDER the same small `BufReader` `check_onnx_envelope` uses,
    /// because that is where the cost is: every seek empties the buffer, and
    /// what it refills with is what the check actually reads from disk.
    #[test]
    fn the_graph_payload_is_skipped_not_read() {
        let bytes = model(&vec![0u8; 1 << 20]);
        let mut reader = io::BufReader::with_capacity(
            SCAN_BUFFER,
            Counting {
                inner: Cursor::new(&bytes),
                read: 0,
            },
        );
        walk(&mut reader, bytes.len() as u64).unwrap();
        let read = reader.get_ref().read;
        assert!(
            read <= 4 * SCAN_BUFFER as u64,
            "read {read} bytes of a {}-byte model",
            bytes.len()
        );
    }

    #[test]
    fn a_file_that_is_not_there_says_so() {
        let error = check_onnx_envelope(Path::new("/nonexistent/encoder.onnx")).unwrap_err();
        assert!(error.contains("could not open"), "{error}");
    }

    /// Through the real file API, not only a cursor.
    #[test]
    fn a_file_on_disk_is_checked_the_same_way() {
        // Per process, so two checkouts running the suite at once cannot
        // delete each other's fixture.
        let dir = std::env::temp_dir().join(format!("cc-stt-envelope-{}", std::process::id()));
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
