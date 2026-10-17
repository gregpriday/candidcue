//! The hardened outbound-HTTP discipline, for everything that fetches.
//!
//! Its one caller is the speech-model downloader (§152). It lives apart from
//! that downloader because it is the SSRF guard: a second caller should reuse
//! this rather than grow a guard that is only accidentally identical.
//!
//! On EVERY hop:
//!   * https only, no credentials in the url, no proxy, no cookies, no referer;
//!   * redirects disabled in the client and followed manually by the caller so
//!     each `Location` is revalidated from scratch through [`check_hop`];
//!   * the host is resolved first, every resolved address must be publicly
//!     routable, and the connection is then PINNED to those addresses so a DNS
//!     rebind between check and connect cannot move the target. A digest-pinned
//!     download also accepts the addresses a fake-IP proxy or a DNS64 resolver
//!     synthesises for a name ([`AddressRule::PublicOrSynthesised`]).
//!
//! Bounding the BODY is the caller's job and deliberately not done here: a
//! model archive is capped at the exact byte count its catalogue entry
//! promises, and only the caller knows what a sensible bound for its bytes is.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use crate::errors::{AppError, ErrorCategory};

/// Redirect budget. Five is what browsers settle on in practice.
pub const MAX_REDIRECTS: u8 = 5;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// How a caller names a refusal — and a host it could not reach.
///
/// Parameterised rather than fixed because an error code is a contract: it
/// reaches a support bundle and the Settings error list, and it names the
/// caller (`STT_MODEL_URL_BLOCKED`), not this guard. The checks are identical
/// for every caller but the [`AddressRule`]; only the label on the way out
/// differs.
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

/// Which resolved addresses a hop may connect to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressRule {
    /// Every resolved address must be publicly routable. The rule for any url
    /// a user or a document supplied.
    Public,
    /// [`AddressRule::Public`], plus the two answers a local network
    /// synthesises for a public name: a fake-IP proxy's 198.18.0.0/15 (Surge
    /// Enhanced Mode, Clash/mihomo `fake-ip`) and a DNS64 resolver's
    /// 64:ff9b::/96 (IPv6-only and IPv6-mostly networks). Refusing them makes a
    /// download impossible on those machines, with nothing the user can change.
    ///
    /// Only for bytes checked against a digest the binary compiles in: an
    /// address the proxy or the NAT64 gateway forwards could otherwise serve
    /// anything at all. It applies to RESOLVED names only. Neither mechanism
    /// ever puts one of these addresses in a url, so an IP-literal host — the
    /// first url or any `Location` — is still held to `Public`.
    PublicOrSynthesised,
}

/// Per-hop policy. Production carries no exemption at all; the only variation
/// is a test-only allowance for a local mock server, which is `#[cfg(test)]` so
/// no production code path can construct one.
#[derive(Debug, Clone)]
pub struct HopPolicy {
    pub labels: HopLabels,
    pub addresses: AddressRule,
    /// Test seam: the single `host:port` allowed to be plaintext http on a
    /// non-public address. Compiled out of release builds entirely.
    #[cfg(test)]
    pub exempt_authority: Option<String>,
}

impl HopPolicy {
    pub fn strict(labels: HopLabels) -> Self {
        Self {
            labels,
            addresses: AddressRule::Public,
            #[cfg(test)]
            exempt_authority: None,
        }
    }

    /// [`HopPolicy::strict`] in every respect but [`AddressRule`]. The caller
    /// takes on the obligation that rule names: nothing it fetches is trusted
    /// until it matches a digest compiled into the binary.
    pub fn digest_pinned(labels: HopLabels) -> Self {
        Self {
            addresses: AddressRule::PublicOrSynthesised,
            ..Self::strict(labels)
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

/// Is this address one `rule` allows a resolved name to connect to?
fn is_allowed_answer(ip: IpAddr, rule: AddressRule) -> bool {
    if is_publicly_routable(ip) {
        return true;
    }
    if rule == AddressRule::Public {
        return false;
    }
    match ip {
        // 198.18.0.0/15 — a fake-IP proxy's pool. Native IPv4 only: a mapped
        // or compatible spelling of it is not what any proxy hands out.
        IpAddr::V4(v4) => {
            let o = v4.octets();
            o[0] == 198 && (o[1] & 0xFE) == 18
        }
        // 64:ff9b::/96 exactly, the RFC 6052 well-known prefix. It may only
        // carry a global IPv4 (§3.1), so the last 32 bits must pass the strict
        // test: a DNS64 that answers `64:ff9b::7f00:1` is pointing at
        // loopback through the gateway. The rest of 64:ff9b::/32 — including
        // the local-use 64:ff9b:1::/48 of RFC 8215, whose embedded address
        // sits wherever its operator's prefix length puts it — stays refused.
        IpAddr::V6(v6) => {
            let s = v6.segments();
            let o = v6.octets();
            s[0] == 0x0064
                && s[1] == 0xFF9B
                && s[2..6].iter().all(|&x| x == 0)
                && ipv4_is_public(Ipv4Addr::new(o[12], o[13], o[14], o[15]))
        }
    }
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

    // Strip the brackets an IPv6 literal carries in a url authority.
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let literal = bare.parse::<IpAddr>().ok();
    let resolved: std::io::Result<Vec<SocketAddr>> = match literal {
        Some(ip) => Ok(vec![SocketAddr::new(ip, port)]),
        None => lookup(bare.to_string(), port).await,
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
        // Synthesised answers come from a resolver, never from a url.
        let rule = match literal {
            Some(_) => AddressRule::Public,
            None => policy.addresses,
        };
        // ALL resolved addresses must be allowed. A host that answers with one
        // public and one loopback address is a rebinding attempt, not a
        // multi-homed CDN.
        for addr in &addrs {
            if !is_allowed_answer(addr.ip(), rule) {
                return Err(blocked_url(
                    labels,
                    format!("{host} resolves to non-public address {}", addr.ip()),
                ));
            }
        }
    }

    // Pin only for DNS names: an IP-literal host needs no override, and reqwest
    // never consults one for it anyway.
    Ok(Hop {
        url: url.clone(),
        addrs: if literal.is_none() { addrs } else { Vec::new() },
    })
}

/// A credential-free client for exactly one hop, pinned to the addresses that
/// were just validated.
///
/// `idle_timeout` aborts the request only when that long passes with NO bytes
/// arriving. It is the honest test for a stalled transfer: it bounds how long a
/// dead connection can be held open without bounding how long a live one may
/// take. Requires reqwest ≥ 0.12.5 for `read_timeout`.
pub fn client_for(hop: &Hop, idle_timeout: Duration) -> Result<reqwest::Client, AppError> {
    let mut builder = reqwest::Client::builder()
        // Manual redirect handling: the client must never follow a Location we
        // have not re-validated.
        .redirect(reqwest::redirect::Policy::none())
        // A configured proxy would resolve and connect on our behalf, defeating
        // the address check entirely.
        .no_proxy()
        .referer(false)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(idle_timeout)
        .user_agent(concat!("CandidCue/", env!("CARGO_PKG_VERSION")));
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

    /// What Surge / Clash hand out for github.com, and what a DNS64 resolver
    /// synthesises for it (140.82.112.4 behind the well-known prefix).
    const SYNTHESISED: [&str; 5] = [
        "198.18.0.0",
        "198.18.0.5",
        "198.19.255.255",
        "64:ff9b::8c52:7004",
        "64:ff9b::808:808",
    ];

    #[test]
    fn the_public_rule_refuses_what_a_local_network_synthesises() {
        for raw in SYNTHESISED {
            let ip: IpAddr = raw.parse().unwrap();
            assert!(!is_publicly_routable(ip), "{raw} is not publicly routable");
            assert!(!is_allowed_answer(ip, AddressRule::Public), "{raw} must be refused");
        }
    }

    #[test]
    fn a_digest_pinned_download_accepts_what_a_local_network_synthesises() {
        for raw in SYNTHESISED {
            let ip: IpAddr = raw.parse().unwrap();
            assert!(
                is_allowed_answer(ip, AddressRule::PublicOrSynthesised),
                "{raw} must be allowed"
            );
        }
        // Either side of the fake-IP pool is ordinary public space, under both.
        for raw in ["198.17.255.255", "198.20.0.0", "1.1.1.1", "2606:4700:4700::1111"] {
            let ip: IpAddr = raw.parse().unwrap();
            assert!(is_allowed_answer(ip, AddressRule::Public), "{raw}");
            assert!(is_allowed_answer(ip, AddressRule::PublicOrSynthesised), "{raw}");
        }
    }

    #[test]
    fn a_digest_pinned_download_refuses_everything_else() {
        for raw in [
            "127.0.0.1",
            "10.0.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "fe80::1",
            "fc00::1",
            // A mapped spelling of a fake IP is not what any proxy hands out.
            "::ffff:198.18.0.1",
            // The well-known prefix around a non-global IPv4: loopback, cloud
            // metadata, private, CGNAT, unspecified, and a fake IP.
            "64:ff9b::7f00:1",
            "64:ff9b::a9fe:a9fe",
            "64:ff9b::a00:1",
            "64:ff9b::c0a8:101",
            "64:ff9b::6440:1",
            "64:ff9b::",
            "64:ff9b::c612:5",
            // Outside the exact /96: RFC 8215 local-use, and a near miss in
            // each of the other segments the prefix requires to be zero.
            "64:ff9b:1::808:808",
            "64:ff9b:1:abcd::808:808",
            "64:ff9b:0:1::808:808",
            "64:ff9b::1:0:808:808",
            "64:ff9b::1:808:808",
        ] {
            let ip: IpAddr = raw.parse().unwrap();
            assert!(
                !is_allowed_answer(ip, AddressRule::PublicOrSynthesised),
                "{raw} must be refused"
            );
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
        hop_under(&HopPolicy::strict(TEST_LABELS), raw, answer).await
    }

    async fn hop_under(
        policy: &HopPolicy,
        raw: &str,
        answer: std::io::Result<Vec<SocketAddr>>,
    ) -> Result<Hop, AppError> {
        let url = reqwest::Url::parse(raw).unwrap();
        check_hop_resolving(&url, policy, |host, port| async move {
            assert_eq!((host.as_str(), port), ("models.example.com", 443));
            answer
        })
        .await
    }

    fn socket_addrs(raw: &[&str]) -> Vec<SocketAddr> {
        raw.iter()
            .map(|ip| SocketAddr::new(ip.parse().unwrap(), 443))
            .collect()
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
    async fn a_synthesised_answer_is_pinned_as_it_was_answered() {
        // The connection goes to the address the proxy or the NAT64 gateway is
        // listening on — never to the IPv4 inside a 64:ff9b:: answer, which this
        // machine has no route to.
        for answer in [
            vec!["198.18.0.5"],
            vec!["64:ff9b::8c52:7004"],
            vec!["140.82.112.4", "198.18.0.5", "64:ff9b::8c52:7004"],
        ] {
            let addrs = socket_addrs(&answer);
            let hop = hop_under(
                &HopPolicy::digest_pinned(TEST_LABELS),
                "https://models.example.com/a.tar.bz2",
                Ok(addrs.clone()),
            )
            .await
            .unwrap_or_else(|e| panic!("{answer:?} must be allowed: {e:?}"));
            assert_eq!(hop.addrs, addrs);
        }
    }

    #[tokio::test]
    async fn a_synthesised_answer_is_refused_under_the_strict_policy() {
        for answer in [vec!["198.18.0.5"], vec!["64:ff9b::8c52:7004"]] {
            let err = hop_resolving_to(
                "https://models.example.com/a.tar.bz2",
                Ok(socket_addrs(&answer)),
            )
            .await
            .expect_err("only a digest-pinned download accepts a synthesised answer");
            assert_eq!(err.code(), "URL_BLOCKED", "{answer:?} → {err:?}");
        }
    }

    #[tokio::test]
    async fn one_bad_answer_still_refuses_a_digest_pinned_name() {
        for answer in [
            vec!["198.18.0.5", "127.0.0.1"],
            vec!["64:ff9b::8c52:7004", "64:ff9b::7f00:1"],
            vec!["64:ff9b:1::8c52:7004"],
        ] {
            let err = hop_under(
                &HopPolicy::digest_pinned(TEST_LABELS),
                "https://models.example.com/a.tar.bz2",
                Ok(socket_addrs(&answer)),
            )
            .await
            .expect_err("a disallowed answer must be refused");
            assert_eq!(err.code(), "URL_BLOCKED", "{answer:?} → {err:?}");
        }
    }

    #[tokio::test]
    async fn an_ip_literal_is_held_to_the_public_rule_even_when_digest_pinned() {
        // No resolver synthesised these: somebody wrote them into a url.
        for raw in ["https://198.18.0.5/a", "https://[64:ff9b::8c52:7004]/a"] {
            let url = reqwest::Url::parse(raw).unwrap();
            let asked = std::cell::Cell::new(false);
            let err = check_hop_resolving(&url, &HopPolicy::digest_pinned(TEST_LABELS), |_, _| {
                asked.set(true);
                async { Ok(Vec::new()) }
            })
            .await
            .expect_err("a synthesised range in a url must be refused");
            assert!(!asked.get(), "{raw} was sent to the resolver");
            assert_eq!(err.code(), "URL_BLOCKED", "{raw} → {err:?}");
        }
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
