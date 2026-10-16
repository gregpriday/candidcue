//! The hardened outbound-HTTP discipline, shared by everything that fetches.
//!
//! This is a straight lift of the transport half of `assets::remote`, which
//! grew it for remote images (spec §24.2, §50.7) and is still its largest
//! caller. Nothing about the policy changed in the move; what changed is who
//! can reach it, because the speech-model downloader (§152) has to make the
//! same guarantees about the same class of URL and reimplementing them would
//! mean maintaining two SSRF guards that are only accidentally identical.
//!
//! What stayed behind in `assets::remote` is everything that is about IMAGES:
//! the 25 MB cap, the four allowed content types, the magic-byte agreement
//! check and the real decode under allocation limits. None of that means
//! anything to a `.tar.bz2` of ONNX graphs, which is verified by SHA-256
//! against a catalogue the binary compiles in.
//!
//! On EVERY hop:
//!   * https only, no credentials in the url, no proxy, no cookies, no referer;
//!   * redirects disabled in the client and followed manually by the caller so
//!     each `Location` is revalidated from scratch through [`check_hop`];
//!   * the host is resolved first, every resolved address must be publicly
//!     routable, and the connection is then PINNED to those addresses so a DNS
//!     rebind between check and connect cannot move the target.
//!
//! Bounding the BODY is the caller's job and deliberately not done here: an
//! image is capped at a constant, and a model archive is capped at the exact
//! byte count its catalogue entry promises. One shared "max bytes" would have
//! to be the larger of the two, which is the same as not having one.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use crate::errors::{AppError, ErrorCategory};

/// Redirect budget. Five is what browsers settle on in practice.
pub const MAX_REDIRECTS: u8 = 5;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How long one request may take, end to end.
///
/// Two shapes, because a total timeout is the right bound for one caller and a
/// fatal one for the other. A 25 MB image either arrives inside 30 seconds or
/// is not worth waiting for; a 128 MB model archive on a domestic connection
/// legitimately takes many minutes, and a total deadline would abort it for
/// being slow rather than for being stuck.
#[derive(Debug, Clone, Copy)]
pub enum Deadline {
    /// Abort the whole request after this long, however healthy it is.
    Total(Duration),
    /// Abort only when this long passes with NO bytes arriving.
    ///
    /// The honest test for a stalled transfer: it bounds how long a dead
    /// connection can be held open without bounding how long a live one may
    /// take. Requires reqwest ≥ 0.12.5 for `read_timeout`.
    Idle(Duration),
}

/// How a caller names a refusal — and a host it could not reach.
///
/// Parameterised rather than fixed because an error code is a contract: images
/// have reported `ASSET_URL_BLOCKED` since spec §24.2, that code reaches a
/// support bundle and the Settings error list, and a shared guard is not a
/// reason to renumber it. The checks are identical for every caller; only the
/// label on the way out differs.
///
/// `unreachable_*` is not a refusal. A lookup that fails is what a machine with
/// no network sees first, and telling that user the address was refused (or
/// that the release is broken) hides the one remedy that works: getting online.
#[derive(Debug, Clone, Copy)]
pub struct HopLabels {
    pub insecure_code: &'static str,
    pub insecure_message: &'static str,
    pub blocked_code: &'static str,
    pub blocked_message: &'static str,
    pub unreachable_code: &'static str,
    pub unreachable_message: &'static str,
}

/// Per-hop policy. Production carries no exemption at all; the only variation
/// is a test-only allowance for a local mock server, which is `#[cfg(test)]` so
/// no production code path can construct one.
#[derive(Debug, Clone)]
pub struct HopPolicy {
    pub labels: HopLabels,
    /// Test seam: the single `host:port` allowed to be plaintext http on a
    /// non-public address. Compiled out of release builds entirely.
    #[cfg(test)]
    pub exempt_authority: Option<String>,
}

impl HopPolicy {
    pub fn strict(labels: HopLabels) -> Self {
        Self {
            labels,
            #[cfg(test)]
            exempt_authority: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// A url that is not https (or otherwise not a transport we will speak).
pub fn insecure_url(labels: &HopLabels, reason: impl Into<String>) -> AppError {
    AppError::structured(
        labels.insecure_code,
        ErrorCategory::Network,
        labels.insecure_message,
        true,
    )
    .with_log(reason.into())
}

/// A url that resolves somewhere the public internet cannot route to.
pub fn blocked_url(labels: &HopLabels, reason: impl Into<String>) -> AppError {
    AppError::structured(
        labels.blocked_code,
        ErrorCategory::Network,
        labels.blocked_message,
        true,
    )
    .with_log(reason.into())
}

/// A host whose name could not be turned into an address.
///
/// A connection problem, not a policy decision: the guard has nothing to judge
/// yet. It still fails closed — no address means no socket is ever opened.
pub fn unreachable_host(labels: &HopLabels, reason: impl Into<String>) -> AppError {
    AppError::structured(
        labels.unreachable_code,
        ErrorCategory::Network,
        labels.unreachable_message,
        true,
    )
    .with_log(reason.into())
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/// Is this address one the public internet can route to?
///
/// `Ipv4Addr::is_global`/`Ipv6Addr::is_global` are still unstable, so the
/// special-purpose registries are spelled out here. Everything not explicitly
/// public is refused: the safe direction for an SSRF guard is to fail closed.
pub fn is_publicly_routable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => ipv4_is_public(v4),
        IpAddr::V6(v6) => ipv6_is_public(v6),
    }
}

fn ipv4_is_public(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    if ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local() // 169.254/16 — cloud instance metadata lives here
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
    {
        return false;
    }
    // 0.0.0.0/8 "this network"
    if o[0] == 0 {
        return false;
    }
    // 100.64.0.0/10 carrier-grade NAT
    if o[0] == 100 && (o[1] & 0xC0) == 64 {
        return false;
    }
    // 192.0.0.0/24 IETF protocol assignments
    if o[0] == 192 && o[1] == 0 && o[2] == 0 {
        return false;
    }
    // 192.88.99.0/24 6to4 relay anycast
    if o[0] == 192 && o[1] == 88 && o[2] == 99 {
        return false;
    }
    // 198.18.0.0/15 benchmarking
    if o[0] == 198 && (o[1] & 0xFE) == 18 {
        return false;
    }
    // 240.0.0.0/4 reserved (includes 255.255.255.255)
    if o[0] >= 240 {
        return false;
    }
    true
}

fn ipv6_is_public(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() {
        return false;
    }
    // ::ffff:a.b.c.d and the deprecated ::a.b.c.d both reach an IPv4 target.
    if let Some(v4) = ip.to_ipv4_mapped() {
        return ipv4_is_public(v4);
    }
    if let Some(v4) = ip.to_ipv4() {
        return ipv4_is_public(v4);
    }
    let s = ip.segments();
    // fc00::/7 unique local
    if (s[0] & 0xFE00) == 0xFC00 {
        return false;
    }
    // fe80::/10 link local
    if (s[0] & 0xFFC0) == 0xFE80 {
        return false;
    }
    // 100::/64 discard-only
    if s[0] == 0x0100 && s[1] == 0 && s[2] == 0 && s[3] == 0 {
        return false;
    }
    // 64:ff9b::/96 and 64:ff9b:1::/48 NAT64
    if s[0] == 0x0064 && s[1] == 0xFF9B {
        return false;
    }
    // 2001::/23 IETF protocol assignments (Teredo, ORCHID, benchmarking...)
    if s[0] == 0x2001 && (s[1] & 0xFE00) == 0x0000 {
        return false;
    }
    // 2001:db8::/32 documentation
    if s[0] == 0x2001 && s[1] == 0x0DB8 {
        return false;
    }
    true
}

// ---------------------------------------------------------------------------
// Per-hop validation
// ---------------------------------------------------------------------------

/// One validated, resolved hop.
#[derive(Debug)]
pub struct Hop {
    pub url: reqwest::Url,
    /// Addresses the connection is pinned to. Empty for an IP-literal host.
    addrs: Vec<SocketAddr>,
}

fn authority_of(url: &reqwest::Url) -> Option<String> {
    let host = url.host_str()?;
    let port = url.port_or_known_default()?;
    Some(format!("{host}:{port}"))
}

/// Validate one hop and resolve it. Every check that matters happens here, so
/// the initial url and every `Location` go through exactly the same gate.
pub async fn check_hop(url: &reqwest::Url, policy: &HopPolicy) -> Result<Hop, AppError> {
    check_hop_resolving(url, policy, |host, port| async move {
        tokio::net::lookup_host((host.as_str(), port))
            .await
            .map(|addrs| addrs.collect())
    })
    .await
}

/// [`check_hop`] with the name lookup handed in, so a test can stand in for a
/// resolver that fails. A real lookup of an unresolvable name is no substitute:
/// a captive portal or a hijacking resolver will happily answer for `.invalid`.
async fn check_hop_resolving<F, Fut>(
    url: &reqwest::Url,
    policy: &HopPolicy,
    lookup: F,
) -> Result<Hop, AppError>
where
    F: FnOnce(String, u16) -> Fut,
    Fut: std::future::Future<Output = std::io::Result<Vec<SocketAddr>>>,
{
    let labels = &policy.labels;
    let authority = authority_of(url)
        .ok_or_else(|| blocked_url(labels, "url has no host or usable port"))?;

    #[cfg(test)]
    let exempt = policy.exempt_authority.as_deref() == Some(authority.as_str());
    #[cfg(not(test))]
    let exempt = {
        let _ = (&authority, policy);
        false
    };

    // Credentials in the url would be sent as HTTP basic auth on every hop —
    // including, after a redirect, to a host the author never wrote down.
    if !url.username().is_empty() || url.password().is_some() {
        return Err(blocked_url(labels, "url carries embedded credentials"));
    }
    if url.scheme() != "https" && !(exempt && url.scheme() == "http") {
        return Err(insecure_url(
            labels,
            format!("scheme {} refused", url.scheme()),
        ));
    }

    let host = url
        .host_str()
        .ok_or_else(|| blocked_url(labels, "url has no host"))?
        .to_string();
    let port = url.port_or_known_default().unwrap_or(443);

    let resolved: std::io::Result<Vec<SocketAddr>> = match host.parse::<IpAddr>() {
        Ok(ip) => Ok(vec![SocketAddr::new(ip, port)]),
        Err(_) => {
            // Strip the brackets an IPv6 literal carries in a url authority.
            let bare = host.trim_start_matches('[').trim_end_matches(']');
            match bare.parse::<IpAddr>() {
                Ok(ip) => Ok(vec![SocketAddr::new(ip, port)]),
                Err(_) => lookup(bare.to_string(), port).await,
            }
        }
    };
    // A lookup that fails is a connection problem, not a refusal: it is the
    // first thing a machine with no network hits, and the guard has nothing to
    // judge yet. `getaddrinfo` reports no-network and no-such-host alike, as
    // platform text with no usable kind, so no attempt is made to tell them
    // apart — that text goes to the log, never to the user.
    let addrs = match resolved {
        Ok(addrs) if !addrs.is_empty() => addrs,
        Ok(_) => return Err(unreachable_host(labels, "host resolved to no addresses")),
        Err(e) => return Err(unreachable_host(labels, format!("dns lookup failed: {e}"))),
    };
    if !exempt {
        // ALL resolved addresses must be public. A host that answers with one
        // public and one loopback address is a rebinding attempt, not a
        // multi-homed CDN.
        for addr in &addrs {
            if !is_publicly_routable(addr.ip()) {
                return Err(blocked_url(
                    labels,
                    format!("{host} resolves to non-public address {}", addr.ip()),
                ));
            }
        }
    }

    // Pin only for DNS names: an IP-literal host needs no override, and reqwest
    // would reject one anyway.
    let pin = host.parse::<IpAddr>().is_err();
    Ok(Hop {
        url: url.clone(),
        addrs: if pin { addrs } else { Vec::new() },
    })
}

/// A credential-free client for exactly one hop, pinned to the addresses that
/// were just validated.
pub fn client_for(hop: &Hop, deadline: Deadline) -> Result<reqwest::Client, AppError> {
    let mut builder = reqwest::Client::builder()
        // Manual redirect handling: the client must never follow a Location we
        // have not re-validated.
        .redirect(reqwest::redirect::Policy::none())
        // A configured proxy would resolve and connect on our behalf, defeating
        // the address check entirely.
        .no_proxy()
        .referer(false)
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(concat!("CandidCue/", env!("CARGO_PKG_VERSION")));
    builder = match deadline {
        Deadline::Total(after) => builder.timeout(after),
        Deadline::Idle(after) => builder.read_timeout(after),
    };
    if !hop.addrs.is_empty() {
        if let Some(host) = hop.url.host_str() {
            builder = builder.resolve_to_addrs(host, &hop.addrs);
        }
    }
    builder
        .build()
        .map_err(|e| AppError::Internal(format!("http client: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_LABELS: HopLabels = HopLabels {
        insecure_code: "URL_INSECURE",
        insecure_message: "https only.",
        blocked_code: "URL_BLOCKED",
        blocked_message: "not publicly reachable.",
        unreachable_code: "URL_UNREACHABLE",
        unreachable_message: "check your connection.",
    };

    #[test]
    fn non_public_addresses_are_refused() {
        for raw in [
            "127.0.0.1",
            "0.0.0.0",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254", // cloud instance metadata
            "100.64.0.1",      // CGNAT
            "192.0.0.1",
            "198.18.0.1",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
            "::",
            "::ffff:127.0.0.1",
            "fc00::1",
            "fd12:3456::1",
            "fe80::1",
            "64:ff9b::7f00:1",
            "2001:db8::1",
        ] {
            let ip: IpAddr = raw.parse().unwrap();
            assert!(!is_publicly_routable(ip), "{raw} must be refused");
        }
    }

    #[test]
    fn genuinely_public_addresses_are_allowed() {
        for raw in ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "2a00:1450::1"] {
            let ip: IpAddr = raw.parse().unwrap();
            assert!(is_publicly_routable(ip), "{raw} must be allowed");
        }
    }

    #[tokio::test]
    async fn credentials_in_the_url_are_refused() {
        let url = reqwest::Url::parse("https://user:secret@example.com/a.png").unwrap();
        let err = check_hop(&url, &HopPolicy::strict(TEST_LABELS))
            .await
            .expect_err("basic-auth credentials must never be forwarded");
        assert_eq!(err.code(), "URL_BLOCKED", "{err:?}");
    }

    #[tokio::test]
    async fn an_ip_literal_in_a_private_range_is_refused() {
        for raw in [
            "https://127.0.0.1/a",
            "https://169.254.169.254/latest/meta-data/",
            "https://10.0.0.1/a",
            "https://[::1]/a",
        ] {
            let url = reqwest::Url::parse(raw).unwrap();
            let err = check_hop(&url, &HopPolicy::strict(TEST_LABELS))
                .await
                .expect_err("must be refused");
            assert_eq!(err.code(), "URL_BLOCKED", "{raw} → {err:?}");
        }
    }

    #[tokio::test]
    async fn plaintext_http_is_refused_without_the_test_exemption() {
        let url = reqwest::Url::parse("http://example.com/a").unwrap();
        let err = check_hop(&url, &HopPolicy::strict(TEST_LABELS))
            .await
            .expect_err("http must be refused");
        assert_eq!(err.code(), "URL_INSECURE", "{err:?}");
    }

    #[tokio::test]
    async fn a_url_with_no_host_is_still_refused() {
        // Structurally unusable whatever the network is doing, so it stays a
        // refusal rather than becoming "check your connection".
        let url = reqwest::Url::parse("file:///tmp/model.tar.bz2").unwrap();
        let err = check_hop(&url, &HopPolicy::strict(TEST_LABELS))
            .await
            .expect_err("a url with no host must be refused");
        assert_eq!(err.code(), "URL_BLOCKED", "{err:?}");
    }

    /// The real gate, with a resolver that gives `answer` for any name — the
    /// stand-in for a lookup that a real network would not answer
    /// deterministically (see [`check_hop_resolving`]).
    async fn hop_resolving_to(
        raw: &str,
        answer: std::io::Result<Vec<SocketAddr>>,
    ) -> Result<Hop, AppError> {
        let url = reqwest::Url::parse(raw).unwrap();
        check_hop_resolving(&url, &HopPolicy::strict(TEST_LABELS), |host, port| async move {
            assert_eq!((host.as_str(), port), ("models.example.com", 443));
            answer
        })
        .await
    }

    #[tokio::test]
    async fn a_failed_dns_lookup_is_a_connection_problem_not_a_refusal() {
        // What macOS returns with Wi-Fi off.
        let offline = std::io::Error::other(
            "failed to lookup address information: nodename nor servname provided, or not known",
        );
        let err = hop_resolving_to("https://models.example.com/a.tar.bz2", Err(offline))
            .await
            .expect_err("a failed lookup must not resolve");

        assert_eq!(err.code(), "URL_UNREACHABLE", "{err:?}");
        assert_eq!(err.category(), ErrorCategory::Network);
        assert!(err.recoverable(), "being offline is worth another go");
        assert_eq!(err.user_message(), "check your connection.");
        // The platform's wording is for the log, never for the user.
        let logged = err.to_string();
        assert!(logged.contains("dns lookup failed"), "{logged}");
        assert!(logged.contains("nodename nor servname"), "{logged}");
        assert!(!err.to_payload().user_message.contains("nodename"));
    }

    #[tokio::test]
    async fn an_empty_dns_answer_is_a_connection_problem_not_a_refusal() {
        let err = hop_resolving_to("https://models.example.com/a.tar.bz2", Ok(Vec::new()))
            .await
            .expect_err("no address means nothing to connect to");
        assert_eq!(err.code(), "URL_UNREACHABLE", "{err:?}");
        assert!(err.to_string().contains("no addresses"), "{err}");
    }

    #[tokio::test]
    async fn a_name_that_resolves_to_any_non_public_address_is_still_refused() {
        // Resolving is only "something answered". One loopback address beside a
        // public one is a rebinding attempt, and it is refused, not reached.
        for answer in [
            vec!["93.184.216.34:443", "127.0.0.1:443"],
            vec!["10.0.0.1:443"],
        ] {
            let addrs: Vec<SocketAddr> = answer.iter().map(|a| a.parse().unwrap()).collect();
            let err = hop_resolving_to("https://models.example.com/a.tar.bz2", Ok(addrs))
                .await
                .expect_err("a non-public answer must be refused");
            assert_eq!(err.code(), "URL_BLOCKED", "{answer:?} → {err:?}");
        }
    }

    #[tokio::test]
    async fn a_name_that_resolves_publicly_is_pinned_to_what_was_checked() {
        let public: SocketAddr = "93.184.216.34:443".parse().unwrap();
        let hop = hop_resolving_to("https://models.example.com/a.tar.bz2", Ok(vec![public]))
            .await
            .expect("a public answer is allowed");
        assert_eq!(hop.addrs, vec![public]);
    }

    #[tokio::test]
    async fn an_ip_literal_is_never_looked_up() {
        let url = reqwest::Url::parse("https://1.1.1.1/a").unwrap();
        let asked = std::cell::Cell::new(false);
        let hop = check_hop_resolving(&url, &HopPolicy::strict(TEST_LABELS), |_, _| {
            asked.set(true);
            async { Ok(Vec::new()) }
        })
        .await
        .expect("a public literal is allowed");
        assert!(!asked.get(), "an ip literal was sent to the resolver");
        assert!(hop.addrs.is_empty(), "an ip-literal hop needs no pin");
    }
}
