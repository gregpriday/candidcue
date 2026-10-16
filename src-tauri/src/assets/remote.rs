//! Hardened remote image fetch (spec §24.2, §50.7).
//!
//! The old implementation checked the scheme of the FIRST url only, handed the
//! request to the shared reqwest client (which follows redirects, including
//! https→http), never looked at the address it actually connected to, and
//! buffered the whole body with `response.bytes()` before comparing it against
//! the size cap. That is a textbook SSRF plus an unbounded allocation: a link
//! in a Markdown file could reach `http://169.254.169.254/latest/meta-data/`,
//! any loopback service, or anything on the operator's LAN, and a chunked
//! response with no `Content-Length` could exhaust memory.
//!
//! What this module does instead, on EVERY hop:
//!   * https only, no credentials in the url, no proxy, no cookies, no referer;
//!   * redirects disabled in the client and followed manually so each `Location`
//!     is revalidated from scratch;
//!   * the host is resolved first, every resolved address must be publicly
//!     routable, and the connection is then PINNED to those addresses so a DNS
//!     rebind between check and connect cannot move the target;
//!   * the body is streamed into a bounded buffer that aborts at the cap
//!     instead of being materialised first;
//!   * the declared `Content-Type` must be one of four raster image types,
//!     the magic bytes must agree with it, and the payload must survive a real
//!     decode under width/height/allocation limits.
//!
//! The first three of those now live in `crate::net`, which the speech-model
//! downloader (§152) shares. They moved verbatim: the guard is the same code
//! answering for both callers rather than two that happen to agree today. What
//! stayed here is everything specific to an IMAGE — the 25 MB cap, the four
//! content types, the sniff agreement and the real decode — because none of it
//! means anything to a hash-pinned archive of model weights.
//!
//! SVG is refused outright rather than sanitised. It is an active-content
//! format (script, foreignObject, external references) and CandidCue renders
//! script images inside the stage webview, which is the one window that is
//! supposed to have no script surface of its own (spec §50.10). Nothing in the
//! product needs vector art, so there is no sanitiser to get wrong.

use std::time::Duration;

use reqwest::header::{ACCEPT, CONTENT_TYPE, LOCATION};

use crate::errors::{AppError, ErrorCategory};
use crate::net::{self, Deadline, HopPolicy};

/// Hard limit for a downloaded image (spec Appendix A.10).
pub const MAX_REMOTE_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
/// Redirect budget. Five is what browsers settle on in practice.
pub const MAX_REDIRECTS: u8 = net::MAX_REDIRECTS;

/// A total deadline, not an idle one: an image either arrives inside 30 seconds
/// or is not worth making the editor wait for. The model downloader takes the
/// other branch, because a 128 MB archive is legitimately slow.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Growth step for the streaming buffer. Never derived from `Content-Length`:
/// that header is attacker-controlled and pre-allocating from it is the
/// allocation bomb this module exists to prevent.
const READ_CHUNK_HINT: usize = 64 * 1024;

/// Raster types the app renders. `image/svg+xml` is deliberately absent.
const ALLOWED_CONTENT_TYPES: &[(&str, &str)] = &[
    ("image/png", "image/png"),
    ("image/jpeg", "image/jpeg"),
    ("image/jpg", "image/jpeg"),
    ("image/gif", "image/gif"),
    ("image/webp", "image/webp"),
];

/// A downloaded, validated image.
#[derive(Debug, Clone)]
pub struct FetchedImage {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub final_url: String,
}

/// The codes and copy the IMAGE path reports a refused url under.
///
/// Unchanged from before the transport moved to `crate::net`: these codes reach
/// support bundles and the Settings error list, so the shared guard is
/// parameterised with them rather than renumbering a contract that had no
/// reason to change.
pub(crate) const IMAGE_HOP_LABELS: net::HopLabels = net::HopLabels {
    insecure_code: "ASSET_URL_INSECURE",
    insecure_message: "Images can only be downloaded over https.",
    blocked_code: "ASSET_URL_BLOCKED",
    blocked_message: "That image address is not publicly reachable and was refused.",
    // Not a refusal: a host that cannot be looked up is a download failure,
    // reported under the code a dropped connection already uses.
    unreachable_code: "ASSET_DOWNLOAD_FAILED",
    unreachable_message: "The image could not be downloaded. Check your connection and try again.",
};

/// Fetch policy. Production always uses [`FetchPolicy::strict`]; the only
/// variation is a test-only exemption for a local mock server, which is
/// `#[cfg(test)]` so no production code path can construct it.
#[derive(Debug, Clone)]
pub struct FetchPolicy {
    pub max_bytes: u64,
    pub max_redirects: u8,
    /// Test seam: the single `host:port` allowed to be plaintext http on a
    /// non-public address. Compiled out of release builds entirely.
    #[cfg(test)]
    pub exempt_authority: Option<String>,
}

impl FetchPolicy {
    pub fn strict() -> Self {
        Self {
            max_bytes: MAX_REMOTE_IMAGE_BYTES,
            max_redirects: MAX_REDIRECTS,
            #[cfg(test)]
            exempt_authority: None,
        }
    }

    /// The per-hop half of this policy, as the shared guard wants it.
    fn hop_policy(&self) -> HopPolicy {
        HopPolicy {
            labels: IMAGE_HOP_LABELS,
            // An image url is whatever a document says it is, and nothing pins
            // its bytes, so a synthesised address gets no benefit of the doubt.
            addresses: net::AddressRule::Public,
            #[cfg(test)]
            exempt_authority: self.exempt_authority.clone(),
        }
    }
}

impl Default for FetchPolicy {
    fn default() -> Self {
        Self::strict()
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

fn blocked_url(reason: impl Into<String>) -> AppError {
    net::blocked_url(&IMAGE_HOP_LABELS, reason)
}

fn download_failed(reason: impl Into<String>) -> AppError {
    AppError::structured(
        "ASSET_DOWNLOAD_FAILED",
        ErrorCategory::Network,
        "The image could not be downloaded.",
        true,
    )
    .with_log(reason.into())
}

fn unsupported_type(reason: impl Into<String>) -> AppError {
    AppError::structured(
        "ASSET_UNSUPPORTED",
        ErrorCategory::Media,
        "Only PNG, JPEG, GIF, and WebP images can be imported.",
        true,
    )
    .with_log(reason.into())
}

fn too_large() -> AppError {
    AppError::structured(
        "ASSET_TOO_LARGE",
        ErrorCategory::Media,
        "Images larger than 25 MB cannot be imported.",
        true,
    )
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/// Download and validate a remote image.
///
/// The URL comes from the operator, so every hop is built its own client
/// (`net::client_for`) with automatic redirects OFF: a redirect is resolved
/// here and revalidated from scratch, which is the only way a hop into a
/// private address can be refused rather than merely noticed afterwards.
pub async fn fetch_remote_image(
    url: &str,
    policy: &FetchPolicy,
) -> Result<FetchedImage, AppError> {
    let mut current = reqwest::Url::parse(url)
        .map_err(|_| AppError::invalid_input("The image URL is not valid."))?;

    let hop_policy = policy.hop_policy();
    for _ in 0..=policy.max_redirects {
        let hop = net::check_hop(&current, &hop_policy).await?;
        let client = net::client_for(&hop, Deadline::Total(REQUEST_TIMEOUT))?;
        let response = client
            .get(hop.url.clone())
            .header(ACCEPT, "image/png,image/jpeg,image/gif,image/webp")
            .send()
            .await
            .map_err(|e| download_failed(format!("request failed: {e}")))?;

        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| download_failed(format!("{status} with no Location")))?
                .to_string();
            // Resolve relative redirects against the hop we actually fetched,
            // then loop so the new target is revalidated from scratch.
            current = current
                .join(&location)
                .map_err(|_| blocked_url(format!("unusable redirect target {location:?}")))?;
            continue;
        }
        if !status.is_success() {
            return Err(download_failed(format!("status {status}")));
        }
        return read_validated_body(response, policy).await;
    }
    Err(blocked_url("too many redirects"))
}

fn allowed_content_type(header: Option<&str>) -> Result<&'static str, AppError> {
    let raw = header.ok_or_else(|| unsupported_type("response has no Content-Type"))?;
    let base = raw
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    ALLOWED_CONTENT_TYPES
        .iter()
        .find(|(declared, _)| *declared == base)
        .map(|(_, canonical)| *canonical)
        .ok_or_else(|| unsupported_type(format!("Content-Type {base:?} is not an allowed image")))
}

/// Stream the body into a bounded buffer, then prove it really is the image it
/// claims to be.
async fn read_validated_body(
    response: reqwest::Response,
    policy: &FetchPolicy,
) -> Result<FetchedImage, AppError> {
    let final_url = response.url().to_string();
    let declared = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let mime = allowed_content_type(declared.as_deref())?;

    // An honest Content-Length short-circuits the download; a missing or lying
    // one changes nothing, because the cap is enforced per chunk below.
    if let Some(len) = response.content_length() {
        if len > policy.max_bytes {
            return Err(too_large());
        }
    }

    let mut response = response;
    let mut bytes: Vec<u8> = Vec::with_capacity(READ_CHUNK_HINT);
    loop {
        let chunk = response
            .chunk()
            .await
            .map_err(|e| download_failed(format!("stream failed: {e}")))?;
        let Some(chunk) = chunk else { break };
        if bytes.len() as u64 + chunk.len() as u64 > policy.max_bytes {
            // Dropping the response here closes the connection, so an endless
            // chunked body stops arriving instead of filling memory.
            return Err(too_large());
        }
        bytes.extend_from_slice(&chunk);
    }

    let sniffed = crate::assets::sniff_mime(&bytes)
        .ok_or_else(|| unsupported_type("payload is not a supported raster image"))?;
    if sniffed != mime {
        return Err(unsupported_type(format!(
            "Content-Type {mime} disagrees with the payload, which sniffs as {sniffed}"
        )));
    }
    crate::assets::validate_image_payload(&bytes, sniffed)?;

    Ok(FetchedImage {
        bytes,
        mime,
        final_url,
    })
}

/// Image fixtures shared by the unit tests in this crate.
#[cfg(test)]
pub(crate) mod tests_support {
    /// A real, decodable 1×1 PNG.
    pub(crate) const TINY_PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
        0x77, 0x53, 0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, 0x54, 0x78, 0xDA, 0x63, 0xF8,
        0xCF, 0xC0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0xF7, 0x03, 0x41, 0x43, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    /// A 30000×30000 PNG header (900 megapixels) with a trivial payload — the
    /// classic decompression bomb.
    pub(crate) fn huge_png_header() -> Vec<u8> {
        fn crc(bytes: &[u8]) -> u32 {
            let mut table = [0u32; 256];
            for (i, entry) in table.iter_mut().enumerate() {
                let mut c = i as u32;
                for _ in 0..8 {
                    c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
                }
                *entry = c;
            }
            let mut c = 0xFFFF_FFFFu32;
            for b in bytes {
                c = table[((c ^ u32::from(*b)) & 0xFF) as usize] ^ (c >> 8);
            }
            c ^ 0xFFFF_FFFF
        }
        let mut ihdr = b"IHDR".to_vec();
        ihdr.extend_from_slice(&30_000u32.to_be_bytes());
        ihdr.extend_from_slice(&30_000u32.to_be_bytes());
        ihdr.extend_from_slice(&[8, 2, 0, 0, 0]);
        let mut out = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        out.extend_from_slice(&13u32.to_be_bytes());
        out.extend_from_slice(&ihdr);
        out.extend_from_slice(&crc(&ihdr).to_be_bytes());
        // Enough trailing bytes that sniffing and header parsing both succeed.
        out.extend_from_slice(&[0u8; 64]);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::tests_support::{huge_png_header, TINY_PNG};
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    /// A dependency-free HTTP/1.1 origin. Each connection is answered once and
    /// closed; that is all these tests need and it keeps the mock ~40 lines.
    struct MockOrigin {
        port: u16,
    }

    impl MockOrigin {
        fn start() -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind mock origin");
            let port = listener.local_addr().unwrap().port();
            let spare = TcpListener::bind("127.0.0.1:0").expect("bind spare");
            let other_port = spare.local_addr().unwrap().port();
            drop(spare);

            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    let mut buf = [0u8; 2048];
                    let read = stream.read(&mut buf).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..read]).to_string();
                    let path = request
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("/")
                        .to_string();
                    let _ = respond(&mut stream, &path, port, other_port);
                    let _ = stream.flush();
                }
            });
            Self { port }
        }

        fn url(&self, path: &str) -> String {
            format!("http://127.0.0.1:{}{path}", self.port)
        }

        fn policy(&self) -> FetchPolicy {
            FetchPolicy {
                exempt_authority: Some(format!("127.0.0.1:{}", self.port)),
                ..FetchPolicy::strict()
            }
        }
    }

    fn ok_response(content_type: &str, body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    fn redirect(location: &str) -> Vec<u8> {
        format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            .into_bytes()
    }

    fn respond(
        stream: &mut std::net::TcpStream,
        path: &str,
        port: u16,
        other_port: u16,
    ) -> std::io::Result<()> {
        match path {
            "/ok.png" => stream.write_all(&ok_response("image/png", TINY_PNG)),
            "/mismatch.png" => {
                // Declares PNG, ships a GIF.
                let mut gif = b"GIF89a".to_vec();
                gif.extend_from_slice(&[0u8; 32]);
                stream.write_all(&ok_response("image/png", &gif))
            }
            "/logo.svg" => stream.write_all(&ok_response(
                "image/svg+xml",
                b"<svg xmlns='http://www.w3.org/2000/svg'><script>fetch('/')</script></svg>",
            )),
            "/svg-as-png" => stream.write_all(&ok_response(
                "image/png",
                b"<svg xmlns='http://www.w3.org/2000/svg'><script>x</script></svg>",
            )),
            "/bomb.png" => {
                // A 30000x30000 PNG header with a trivial payload: 900 MP.
                stream.write_all(&ok_response("image/png", &huge_png_header()))
            }
            "/endless.png" => {
                // Chunked, no Content-Length, never ends. The client must stop.
                stream.write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nTransfer-Encoding: chunked\r\n\r\n",
                )?;
                let payload = vec![0x41u8; 64 * 1024];
                loop {
                    stream.write_all(format!("{:x}\r\n", payload.len()).as_bytes())?;
                    stream.write_all(&payload)?;
                    stream.write_all(b"\r\n")?;
                }
            }
            "/redirect-relative" => stream.write_all(&redirect("/ok.png")),
            "/redirect-http" => {
                stream.write_all(&redirect(&format!("http://127.0.0.1:{other_port}/ok.png")))
            }
            "/redirect-loopback" => {
                stream.write_all(&redirect(&format!("https://127.0.0.1:{other_port}/ok.png")))
            }
            "/redirect-private" => stream.write_all(&redirect("https://10.1.2.3/ok.png")),
            "/redirect-metadata" => {
                stream.write_all(&redirect("https://169.254.169.254/latest/meta-data/"))
            }
            "/redirect-self" => {
                stream.write_all(&redirect(&format!("http://127.0.0.1:{port}/redirect-self")))
            }
            _ => stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"),
        }
    }

    // -- transport --------------------------------------------------------

    #[tokio::test]
    async fn a_valid_png_downloads() {
        let origin = MockOrigin::start();
        let image = fetch_remote_image(&origin.url("/ok.png"), &origin.policy())
            .await
            .expect("a small valid PNG must still import");
        assert_eq!(image.mime, "image/png");
        assert_eq!(image.bytes, TINY_PNG);
    }

    #[tokio::test]
    async fn a_relative_redirect_to_an_allowed_hop_still_works() {
        let origin = MockOrigin::start();
        let image = fetch_remote_image(&origin.url("/redirect-relative"), &origin.policy())
            .await
            .expect("a same-origin redirect is legitimate");
        assert_eq!(image.bytes, TINY_PNG);
    }

    #[tokio::test]
    async fn a_redirect_that_downgrades_to_http_is_refused() {
        let origin = MockOrigin::start();
        let err = fetch_remote_image(&origin.url("/redirect-http"), &origin.policy())
            .await
            .expect_err("https must be re-required on every hop");
        assert_eq!(err.code(), "ASSET_URL_INSECURE", "{err:?}");
    }

    #[tokio::test]
    async fn a_redirect_to_loopback_is_refused() {
        let origin = MockOrigin::start();
        let err = fetch_remote_image(&origin.url("/redirect-loopback"), &origin.policy())
            .await
            .expect_err("loopback must be refused on a redirect hop");
        assert_eq!(err.code(), "ASSET_URL_BLOCKED", "{err:?}");
    }

    #[tokio::test]
    async fn a_redirect_into_a_private_range_is_refused() {
        let origin = MockOrigin::start();
        let err = fetch_remote_image(&origin.url("/redirect-private"), &origin.policy())
            .await
            .expect_err("RFC1918 must be refused on a redirect hop");
        assert_eq!(err.code(), "ASSET_URL_BLOCKED", "{err:?}");
    }

    #[tokio::test]
    async fn a_redirect_to_cloud_metadata_is_refused() {
        let origin = MockOrigin::start();
        let err = fetch_remote_image(&origin.url("/redirect-metadata"), &origin.policy())
            .await
            .expect_err("169.254.169.254 must be refused");
        assert_eq!(err.code(), "ASSET_URL_BLOCKED", "{err:?}");
    }

    #[tokio::test]
    async fn a_redirect_loop_terminates() {
        let origin = MockOrigin::start();
        let err = fetch_remote_image(&origin.url("/redirect-self"), &origin.policy())
            .await
            .expect_err("an endless redirect chain must be bounded");
        assert_eq!(err.code(), "ASSET_URL_BLOCKED", "{err:?}");
    }

    #[tokio::test]
    async fn an_endless_chunked_body_is_capped() {
        let origin = MockOrigin::start();
        let policy = FetchPolicy {
            // Keep the test quick; the production cap is 25 MB and the logic is
            // identical.
            max_bytes: 512 * 1024,
            ..origin.policy()
        };
        let err = fetch_remote_image(&origin.url("/endless.png"), &policy)
            .await
            .expect_err("a body with no Content-Length must still be capped");
        assert_eq!(err.code(), "ASSET_TOO_LARGE", "{err:?}");
    }

    #[tokio::test]
    async fn a_content_type_that_disagrees_with_the_payload_is_refused() {
        let origin = MockOrigin::start();
        let err = fetch_remote_image(&origin.url("/mismatch.png"), &origin.policy())
            .await
            .expect_err("declared type and magic bytes must agree");
        assert_eq!(err.code(), "ASSET_UNSUPPORTED", "{err:?}");
    }

    #[tokio::test]
    async fn svg_is_refused_by_content_type() {
        let origin = MockOrigin::start();
        let err = fetch_remote_image(&origin.url("/logo.svg"), &origin.policy())
            .await
            .expect_err("SVG is active content and is never imported");
        assert_eq!(err.code(), "ASSET_UNSUPPORTED", "{err:?}");
    }

    #[tokio::test]
    async fn svg_disguised_as_png_is_refused() {
        let origin = MockOrigin::start();
        let err = fetch_remote_image(&origin.url("/svg-as-png"), &origin.policy())
            .await
            .expect_err("an SVG body cannot smuggle itself in under image/png");
        assert_eq!(err.code(), "ASSET_UNSUPPORTED", "{err:?}");
    }

    #[tokio::test]
    async fn a_decompression_bomb_is_refused_before_it_is_decoded() {
        let origin = MockOrigin::start();
        let err = fetch_remote_image(&origin.url("/bomb.png"), &origin.policy())
            .await
            .expect_err("900 megapixels in 100 bytes must not be decoded");
        assert_eq!(err.code(), "ASSET_UNSUPPORTED", "{err:?}");
    }

    #[tokio::test]
    async fn the_strict_policy_refuses_the_mock_origin_outright() {
        // The same url the tests above drive successfully is rejected before a
        // socket is opened once the test exemption is gone — which is the proof
        // that the exemption, not a weakened check, is what makes them pass.
        let origin = MockOrigin::start();
        let err = fetch_remote_image(&origin.url("/ok.png"), &FetchPolicy::strict())
            .await
            .expect_err("plaintext loopback must be refused in production");
        assert_eq!(err.code(), "ASSET_URL_INSECURE", "{err:?}");
    }

    #[test]
    fn an_unreachable_image_host_is_a_download_failure_not_a_refusal() {
        // Being offline is not a blocked address: same code and category as a
        // transfer that dropped, so the user is told to check the connection.
        let unreachable = net::unreachable_host(&IMAGE_HOP_LABELS, "dns lookup failed");
        let dropped = download_failed("stream failed");

        assert_eq!(unreachable.code(), dropped.code());
        assert_ne!(unreachable.code(), IMAGE_HOP_LABELS.blocked_code);
        assert_eq!(unreachable.category(), dropped.category());
        assert_eq!(unreachable.recoverable(), dropped.recoverable());
        let message = unreachable.user_message();
        assert!(message.contains("Check your connection"), "{message}");
        assert!(!message.contains("refused"), "{message}");
    }

    #[test]
    fn an_image_never_accepts_a_synthesised_address() {
        // The model download accepts fake-IP and NAT64 answers because its
        // bytes are digest-pinned. An image's are not.
        assert_eq!(FetchPolicy::strict().hop_policy().addresses, net::AddressRule::Public);
    }

    #[tokio::test]
    async fn credentials_in_the_url_are_refused() {
        let err = fetch_remote_image("https://user:secret@example.com/a.png", &FetchPolicy::strict())
            .await
            .expect_err("basic-auth credentials must never be forwarded");
        assert_eq!(err.code(), "ASSET_URL_BLOCKED", "{err:?}");
    }

    #[tokio::test]
    async fn non_http_schemes_are_refused() {
        for url in ["file:///etc/passwd", "ftp://example.com/a.png", "data:image/png;base64,AAAA"] {
            let err = fetch_remote_image(url, &FetchPolicy::strict())
                .await
                .expect_err("a non-http(s) scheme must be refused");
            assert!(
                matches!(err.code(), "ASSET_URL_INSECURE" | "ASSET_URL_BLOCKED"),
                "{url} → {err:?}"
            );
        }
    }

    #[tokio::test]
    async fn an_ip_literal_in_a_private_range_is_refused_on_the_first_hop() {
        for url in [
            "https://127.0.0.1/a.png",
            "https://169.254.169.254/latest/meta-data/",
            "https://10.0.0.1/a.png",
            "https://[::1]/a.png",
        ] {
            let err = fetch_remote_image(url, &FetchPolicy::strict())
                .await
                .expect_err("must be refused");
            assert_eq!(err.code(), "ASSET_URL_BLOCKED", "{url} → {err:?}");
        }
    }
}
