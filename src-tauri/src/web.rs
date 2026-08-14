//! The pages CandidCue is allowed to open, by name.
//!
//! ---------------------------------------------------------------------------
//! WHY A NAME AND NOT A URL
//! ---------------------------------------------------------------------------
//! A promoted product needs a Help menu that reaches its own website: the guide,
//! the support page, the release notes, the download. The obvious way to build
//! that is to grant the webview `opener:default` and let the frontend pass a
//! URL — and that is exactly the permission the 1.0 readiness review had removed
//! (see `capabilities/control.json` and `open_model_licence`), because standing
//! permission to open ANY url is authority nobody is watching.
//!
//! So the frontend asks for `"guide"`, not for `https://…/guide`. This file owns
//! the mapping. The set of reachable URLs is a compile-time constant, a webview
//! that has been persuaded to invoke this command with an arbitrary string gets
//! a refusal, and the whole surface is one table a reviewer can read in ten
//! seconds.
//!
//! ---------------------------------------------------------------------------
//! THE ORIGIN IS A BUSINESS FACT
//! ---------------------------------------------------------------------------
//! The legal documents leave the site as `@@LEGAL_WEBSITE_ORIGIN@@` because a
//! guessed domain in a licence agreement is worse than a visible blank. The
//! application does not have that luxury — a Help menu that opens nothing is not
//! a menu — so the origin is here, and `legal/PLACEHOLDERS.md` records that the
//! two move together. If the domain changes, it changes in both places.
//!
//! Nothing here reaches the network. `open_url` hands the string to macOS, which
//! launches the user's browser; CandidCue makes no request of its own
//! (`docs/network-inventory.md`).

/// Where CandidCue's own pages live.
///
/// One constant, no interpolation from anywhere else. Every entry below is a
/// path under it, so there is no way to name a different host.
pub const WEBSITE_ORIGIN: &str = "https://candidcue.com";

/// Every page the application can open, and nothing else.
///
/// Paths are literal and absolute-from-root. A destination is added here, in
/// `src/shared/contracts/commands.ts`, in `src/control/lib/commands.ts` and in
/// `menu.rs` — four deliberate edits, which is the right amount of friction for
/// widening what an application can launch a browser at.
///
/// There is no separate "send feedback" entry: it would be a second menu item
/// pointing at the same support page, and a menu that lists one action twice
/// teaches people that the labels do not mean anything.
const DESTINATIONS: &[(&str, &str)] = &[
    ("website", ""),
    ("guide", "/guide"),
    ("support", "/support"),
    ("release-notes", "/releases"),
    ("download", "/download"),
];

/// The URL for a destination name, or `None` if the name is not one of ours.
pub fn url_for(name: &str) -> Option<String> {
    DESTINATIONS
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, path)| format!("{WEBSITE_ORIGIN}{path}"))
}

/// The command that uses this table is `commands::shell_cmds`. Deliberately:
/// `#[tauri::command]` generates helper items that `generate_handler!` resolves
/// through the same path it names, so a command re-exported from another module
/// does not compile. Keeping the policy here and the command there also means
/// this file has no Tauri in it and can be reasoned about on its own.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_destination_is_a_page_under_the_one_origin() {
        for (name, _) in DESTINATIONS {
            let url = url_for(name).expect("declared destinations resolve");
            assert!(
                url.starts_with("https://"),
                "{name} is not https, and a Help menu that opens http is a downgrade \
                 attack waiting for a coffee shop"
            );
            assert!(
                url.starts_with(WEBSITE_ORIGIN),
                "{name} resolves to {url}, which is not under {WEBSITE_ORIGIN}"
            );
        }
    }

    #[test]
    fn names_are_unique() {
        // A duplicate key would make the second one unreachable, and `find`
        // would answer with the first — silently, and only for that one page.
        let mut seen = std::collections::HashSet::new();
        for (name, _) in DESTINATIONS {
            assert!(seen.insert(*name), "{name} is declared twice");
        }
    }

    #[test]
    fn a_name_we_do_not_publish_resolves_to_nothing() {
        for probe in [
            "",
            "guide/../../etc",
            "https://example.com",
            "WEBSITE",
            "support ",
        ] {
            assert!(url_for(probe).is_none(), "{probe:?} resolved to a URL");
        }
    }

    /// The TypeScript union and this table must name the same set.
    ///
    /// The same `include_str!` discipline the menu ids and the stage event
    /// names use: the two sides are separate languages with no shared build
    /// step, so what holds them together is a test that reads the other side's
    /// source. Without it, `openWebDestination('guide')` against a table that
    /// spells it `user-guide` is a menu item whose only symptom is an error
    /// toast nobody sees until a user clicks it.
    #[test]
    fn the_typescript_union_names_the_same_destinations() {
        let ts = include_str!("../../src/control/lib/commands.ts");
        let start = ts
            .find("export type WebDestination =")
            .expect("WebDestination is declared in src/control/lib/commands.ts");
        let end = ts[start..].find(';').expect("the union is terminated") + start;
        let union = &ts[start..end];

        for (name, _) in DESTINATIONS {
            assert!(
                union.contains(&format!("'{name}'")),
                "`{name}` is a destination Rust will open and the WebDestination \
                 union does not name it"
            );
        }

        let declared = union.matches('\'').count() / 2;
        assert_eq!(
            declared,
            DESTINATIONS.len(),
            "the WebDestination union has {declared} names and this table has {}; a \
             name on one side only is a call that fails at runtime",
            DESTINATIONS.len()
        );
    }

    /// The origin is a business fact this file duplicates, so say where.
    ///
    /// `legal/PLACEHOLDERS.md` is the register of facts the documents are still
    /// waiting on, and `LEGAL_WEBSITE_ORIGIN` is one of them. The application
    /// cannot wait — a Help menu that opens nothing is not a menu — so it holds
    /// the value, and the register has to record that the two move together.
    /// Otherwise the domain gets settled in the licence agreement and the app
    /// keeps opening the old one.
    #[test]
    fn the_placeholder_register_knows_the_app_hard_codes_the_origin() {
        let register = include_str!("../../legal/PLACEHOLDERS.md");
        assert!(
            register.contains(WEBSITE_ORIGIN),
            "legal/PLACEHOLDERS.md does not mention {WEBSITE_ORIGIN}, which this \
             file compiles into the binary"
        );
        assert!(
            register.contains("src-tauri/src/web.rs"),
            "legal/PLACEHOLDERS.md does not point at src-tauri/src/web.rs, so \
             nobody resolving LEGAL_WEBSITE_ORIGIN will know the app already \
             carries a copy of the answer"
        );
    }

    /// The one place a path could smuggle in a different host.
    #[test]
    fn no_path_can_leave_the_origin() {
        for (name, path) in DESTINATIONS {
            assert!(
                path.is_empty() || path.starts_with('/'),
                "{name}'s path {path:?} is not rooted, so it would be appended to the \
                 origin as text and could name another host"
            );
            assert!(
                !path.starts_with("//"),
                "{name}'s path {path:?} starts a protocol-relative URL, which names \
                 another host"
            );
            assert!(
                !path.contains(".."),
                "{name}'s path {path:?} contains a traversal"
            );
        }
    }
}
