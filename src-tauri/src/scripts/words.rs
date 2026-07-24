//! Spoken-word extraction from Markdown source (spec §21.8).
//!
//! The authoritative compiler lives in the frontend worker; this Rust
//! extraction only feeds library metadata (word counts, duration estimates,
//! previews, FTS text). It uses spoken tokens, not raw Markdown tokens:
//! code blocks, cue/silent containers, images, and (by default) headings are
//! excluded.

/// Options mirroring the per-script settings that affect spoken content.
#[derive(Debug, Clone, Copy)]
pub struct SpokenTextOptions {
    pub read_headings: bool,
    pub read_image_alt_text: bool,
}

impl Default for SpokenTextOptions {
    fn default() -> Self {
        Self {
            read_headings: false,
            read_image_alt_text: false,
        }
    }
}

/// Extract approximate spoken plain text from Markdown.
pub fn spoken_plain_text(source: &str, options: SpokenTextOptions) -> String {
    let mut out = String::with_capacity(source.len() / 2);
    let mut in_fence = false;
    let mut container_depth = 0usize;

    for line in source.lines() {
        let trimmed = line.trim();

        // Fenced code blocks are never spoken.
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }

        // Directive containers (:::cue, :::silent, :::stage-only …) are
        // non-spoken blocks in the CandidCue Markdown contract.
        if trimmed.starts_with(":::") {
            if container_depth > 0 && trimmed == ":::" {
                container_depth -= 1;
            } else if trimmed.len() > 3 {
                container_depth += 1;
            } else if container_depth == 0 {
                // Stray closing fence; ignore.
            }
            continue;
        }
        if container_depth > 0 {
            continue;
        }

        // Headings.
        if trimmed.starts_with('#') {
            if options.read_headings {
                let text = trimmed.trim_start_matches('#').trim();
                push_inline(&mut out, text, options);
            }
            continue;
        }

        // Tables and dividers are visual.
        if trimmed.starts_with('|') || is_divider(trimmed) {
            continue;
        }

        // Blockquote / list markers are spoken content.
        let stripped = trimmed
            .trim_start_matches('>')
            .trim_start_matches(['-', '*', '+'])
            .trim_start();

        push_inline(&mut out, stripped, options);
    }

    collapse_whitespace(&out)
}

fn is_divider(line: &str) -> bool {
    line.len() >= 3 && line.chars().all(|c| c == '-' || c == '_' || c == '*')
}

/// Strip inline Markdown: images, links (keep label), emphasis, inline code.
fn push_inline(out: &mut String, text: &str, options: SpokenTextOptions) {
    let mut chars = text.chars().peekable();
    let mut buffer = String::new();
    while let Some(c) = chars.next() {
        match c {
            '!' if chars.peek() == Some(&'[') => {
                chars.next(); // consume '['
                let alt = take_until(&mut chars, ']');
                if chars.peek() == Some(&'(') {
                    chars.next();
                    let _url = take_until(&mut chars, ')');
                }
                if options.read_image_alt_text {
                    buffer.push_str(&alt);
                    buffer.push(' ');
                }
            }
            '[' => {
                let label = take_until(&mut chars, ']');
                if chars.peek() == Some(&'(') {
                    chars.next();
                    let _url = take_until(&mut chars, ')');
                }
                buffer.push_str(&label);
            }
            '`' => {
                // Inline code is not spoken by default.
                let _code = take_until(&mut chars, '`');
            }
            '*' | '_' | '~' => {}
            _ => buffer.push(c),
        }
    }
    if !buffer.trim().is_empty() {
        out.push_str(buffer.trim());
        out.push('\n');
    }
}

fn take_until(chars: &mut std::iter::Peekable<std::str::Chars<'_>>, end: char) -> String {
    let mut collected = String::new();
    for c in chars.by_ref() {
        if c == end {
            break;
        }
        collected.push(c);
    }
    collected
}

fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_space = true;
    for c in text.chars() {
        if c.is_whitespace() {
            if !last_space {
                out.push(' ');
                last_space = true;
            }
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim_end().to_string()
}

pub fn word_count(plain: &str) -> u32 {
    plain.split_whitespace().count() as u32
}

/// Estimated duration in whole seconds at the configured words per minute.
pub fn estimated_duration_seconds(words: u32, wpm: u32) -> u32 {
    if wpm == 0 {
        return 0;
    }
    ((words as f64 / wpm as f64) * 60.0).round() as u32
}

/// Short library preview (first ~200 chars of spoken text).
pub fn preview_text(plain: &str) -> String {
    let mut preview: String = plain.chars().take(200).collect();
    if plain.chars().count() > 200 {
        preview.push('…');
    }
    preview
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn excludes_code_headings_and_containers() {
        let source = "# Title\n\nHello world from CandidCue.\n\n```rust\nlet x = 1;\n```\n\n:::cue\nsmile now\n:::\n\nSecond paragraph here.\n";
        let plain = spoken_plain_text(source, SpokenTextOptions::default());
        assert_eq!(plain, "Hello world from CandidCue. Second paragraph here.");
        assert_eq!(word_count(&plain), 7);
    }

    #[test]
    fn keeps_link_labels_drops_images() {
        let source = "See [our site](https://example.com) and ![diagram](assets/x.png) today.\n";
        let plain = spoken_plain_text(source, SpokenTextOptions::default());
        assert_eq!(plain, "See our site and today.");
    }

    #[test]
    fn headings_included_when_enabled() {
        let source = "# Welcome\n\nBody text.\n";
        let options = SpokenTextOptions {
            read_headings: true,
            ..Default::default()
        };
        assert_eq!(spoken_plain_text(source, options), "Welcome Body text.");
    }

    #[test]
    fn duration_uses_wpm() {
        assert_eq!(estimated_duration_seconds(130, 130), 60);
        assert_eq!(estimated_duration_seconds(0, 130), 0);
        assert_eq!(estimated_duration_seconds(65, 130), 30);
    }
}
