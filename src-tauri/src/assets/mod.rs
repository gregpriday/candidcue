//! Script asset management (spec §44.5): validated image import, MIME
//! sniffing, hash/deduplication, scoped asset URLs, garbage collection.
//! Stub — nothing implemented yet.

#![allow(dead_code)]

/// Hard limit for an imported image (spec Appendix A.10).
pub const MAX_IMPORTED_IMAGE_BYTES: u64 = 25 * 1024 * 1024;
