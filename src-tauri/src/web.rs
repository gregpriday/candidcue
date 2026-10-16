//! The pages CandidCue is allowed to open, by name.
//!
//! ---------------------------------------------------------------------------
//! WHY A NAME AND NOT A URL
//! ---------------------------------------------------------------------------
//! The Help menu reaches a handful of the project's pages: the repository, its
//! README, the issue tracker, the releases. The obvious way to build that is to
//! grant the webview `opener:default` and let the frontend pass a URL — and that
//! is exactly the permission the 1.0 readiness review had removed (see
//! `capabilities/control.json` and `open_model_licence`), because standing
//! permission to open ANY url is authority nobody is watching.
//!
//! So the frontend asks for `"guide"`, not for `https://…/README.md`. This file
//! owns the mapping. The set of reachable URLs is a compile-time constant, a
//! webview that has been persuaded to invoke this command with an arbitrary
//! string gets a refusal, and the whole surface is one table a reviewer can read
//! in ten seconds.
//!
//! ---------------------------------------------------------------------------
//! ONE REPOSITORY
//! ---------------------------------------------------------------------------
//! `REPOSITORY_URL` is the only place the application names where the project
//! lives, and every destination is a fixed page inside it. If the project
//! moves, it changes here — and in `docs/network-inventory.md`, which tells a
//! reader where the Help menu sends them.
//!
//! Nothing here reaches the network. `open_url` hands the string to macOS, which
//! launches the user's browser; CandidCue makes no request of its own
//! (`docs/network-inventory.md`).

/// Where the project lives: its public repository.
///
/// One constant, no interpolation from anywhere else, and no trailing slash —
/// every entry below is appended to it as text, so there is no way to name a
/// different host or a different repository.
pub const REPOSITORY_URL: &str = "https://github.com/gregpriday/candidcue";

/// Every page the application can open, and nothing else.
///
/// Each path is a literal suffix to `REPOSITORY_URL`: it starts with `/` and is
/// concatenated, never joined as a URL — a URL join would treat `/releases` as
/// rooted at the host and drop the repository from the path. A destination is
/// added here, in `src/shared/contracts/commands.ts`, in
/// `src/control/lib/commands.ts` and in `menu.rs` — four deliberate edits, which
/// is the right amount of friction for widening what an application can launch
/// a browser at.
///
/// `guide` is the README on its own, not the repository's front page scrolled
/// down to it: `website` is for finding your way around the project, `guide` is
/// for reading about the app, and two menu items that open the same page teach
/// people that the labels do not mean anything. `HEAD` rather than a branch
/// name, so renaming the default branch does not break the link.
///
/// `download` is the latest release: the newest one that is neither a draft nor
/// a prerelease. Until there is one, GitHub redirects it to the releases page,
/// so the item lands where Release Notes does rather than on an error.
///
/// There is no separate "send feedback" entry: it would be a second menu item
/// pointing at the same new-issue page.
const DESTINATIONS: &[(&str, &str)] = &[
    ("website", ""),
    ("guide", "/blob/HEAD/README.md"),
    ("support", "/issues/new"),
    ("release-notes", "/releases"),
    ("download", "/releases/latest"),
];

/// The URL for a destination name, or `None` if the name is not one of ours.
pub fn url_for(name: &str) -> Option<String> {
    DESTINATIONS
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, path)| format!("{REPOSITORY_URL}{path}"))
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
    fn every_destination_is_a_page_inside_the_one_repository() {
        for (name, _) in DESTINATIONS {
            let url = url_for(name).expect("declared destinations resolve");
            assert!(
                url.starts_with("https://"),
                "{name} is not https, and a Help menu that opens http is a downgrade \
                 attack waiting for a coffee shop"
            );
            // The repository itself or something under it — not merely a string
            // that starts the same way, which `…/candidcue-fork` also does.
            assert!(
                url == REPOSITORY_URL || url.starts_with(&format!("{REPOSITORY_URL}/")),
                "{name} resolves to {url}, which is not inside {REPOSITORY_URL}"
            );
        }
    }

    /// The structural tests above would pass for a table that sent every name to
    /// the wrong page of the right repository. This one says what each name is
    /// FOR, spelled out in full so it does not lean on the constant it checks.
    #[test]
    fn each_destination_opens_the_page_its_menu_item_promises() {
        let expected = [
            ("website", "https://github.com/gregpriday/candidcue"),
            ("guide", "https://github.com/gregpriday/candidcue/blob/HEAD/README.md"),
            ("support", "https://github.com/gregpriday/candidcue/issues/new"),
            ("release-notes", "https://github.com/gregpriday/candidcue/releases"),
            ("download", "https://github.com/gregpriday/candidcue/releases/latest"),
        ];
        for (name, url) in expected {
            assert_eq!(url_for(name).as_deref(), Some(url), "{name}");
        }
        assert_eq!(
            DESTINATIONS.len(),
            expected.len(),
            "a destination was added without saying here where it goes"
        );
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

    /// The one place a path could smuggle in a different host or repository.
    #[test]
    fn no_path_can_leave_the_repository() {
        for (name, path) in DESTINATIONS {
            assert!(
                path.is_empty() || path.starts_with('/'),
                "{name}'s path {path:?} does not start with `/`, so it would be \
                 appended to the repository's name as text and could name another \
                 repository"
            );
            assert!(
                !path.starts_with("//"),
                "{name}'s path {path:?} starts with `//`, which is a protocol-relative \
                 URL naming another host the moment this table is ever joined as a \
                 URL instead of concatenated"
            );
            assert!(
                !path.contains(".."),
                "{name}'s path {path:?} contains a traversal"
            );
        }
    }
}
