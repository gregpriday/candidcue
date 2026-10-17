# Archived designs

These are the specifications CandidCue was first designed from. None of them
describes the app as it ships. Speech recognition now runs on-device, live
coaching and the semantic sidecar are gone, no OpenAI or other hosted speech or
language model is involved, and macOS is the only supported platform. Wherever
one of these documents and the code disagree, the code is the authority.
Phrases like "build-ready", "mandatory" and "normative" are part of the
history.

They are kept for one reason: code comments still cite their section numbers.
Each file opens with a historical notice, and below that notice the original
text and numbering are unchanged, so a `§` in a comment still lands where it
always did.

## The documents

| Document | Cited in code as |
|---|---|
| [Product and Technical Specification](CandidCue_Product_and_Technical_Specification.md) | bare `§N` (mostly), `spec §N` in `src-tauri/`, `primary §N` |
| [Smooth Following and Intelligent Alignment](CandidCue_Smooth_Following_and_Intelligent_Alignment_Specification.md) | `companion §N`, and bare numbers in the stage motion code |
| [Intelligent Alignment, Navigation, and Scroll Control](CandidCue_Intelligent_Alignment_Navigation_Spec.md) | `spec §N` in `crates/` |
| [Alignment Engine Technical Design](Alignment_Engine_Technical_Design.md) (formerly `docs/improvements/spec.md`) | `spec §N` in `crates/` and `bench/REPORT.md` |
| [Intelligent Transcript Alignment and Free Navigation](CandidCue_Intelligent_Transcript_Alignment_and_Free_Navigation_Specification.md) | no citation style of its own; kept because it overrides the Smooth Following navigation policy |

## Reading a `§` in a comment

Section numbers are per document, and the documents reuse them. Read the
comment around a citation before trusting the number alone.

- **Bare `§N`** is usually the Product specification. The Product specification
  stops at §61, so a bare number from §62 up (`§62`, `§70.5`) can only be Smooth
  Following. Below that, the stage motion code often means Smooth Following
  too (`§30.5`).
- **`companion §N`** is Smooth Following and Intelligent Alignment, which calls
  itself the "Mandatory Companion Specification".
- **`primary §N`** and **`spec §N` in `src-tauri/`** are the Product
  specification.
- **`spec §N` in `crates/cc-align`, `crates/cc-bench` and `bench/REPORT.md`** is
  one of the two alignment designs. Check both. Some cited numbers match
  neither.

Some citations have no document to land on:

- **`desktop refinement §N`** names a specification that was never committed.
- **Named anchors** such as `§parts` and `§practice` are topic tags, not
  sections.
- **Review-item numbers** such as `§152` match no document.
- A few comments still use the numbering of the **Coaching Rail
  specification**, which was deleted along with the coaching feature.

## What was deleted rather than archived

Three documents that nothing cited were removed instead of archived:

- the Coaching Rail and Live Delivery Intelligence specification
- the Realtime Speaking Score technical report
- `docs/improvements/deep-research-report-30.md`, research notes on novice
  users

They remain readable in git history. Run
`git log --diff-filter=D --name-only -- docs` to find the commit that removed
them.
