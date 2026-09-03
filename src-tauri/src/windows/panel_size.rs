//! The physical size of a panel, in millimetres, from the panel itself.
//!
//! ---------------------------------------------------------------------------
//! WHY THE WINDOW LAYER IS NOT ENOUGH
//! ---------------------------------------------------------------------------
//! Everything angular on the stage rests on one number: millimetres per CSS
//! pixel. `tauri::Monitor` reports device pixels and a scale factor and
//! nothing about glass, so until now that number came from a hardware table
//! (two Elgato models), a diagonal typed into the calibration wizard, or a
//! ruler held against the screen. An ordinary monitor with no rig calibrated
//! for it got a 64px guess.
//!
//! The panel usually knows. Every display carries an EDID block whose
//! "image size" field is its active area in centimetres, and on macOS
//! `CGDisplayScreenSize` hands it back in millimetres with no entitlement and
//! no I/O. That is what this module reads, so a take can be sized for the
//! monitor it actually lands on without anybody measuring anything.
//!
//! ---------------------------------------------------------------------------
//! WHY IT IS AN OPTION AND WHY IT IS CHECKED
//! ---------------------------------------------------------------------------
//! EDID lies, in well-known ways. Adapters and capture devices report `0 x 0`;
//! some panels report a default like 160 x 90 (an aspect ratio, not a size);
//! projectors report whatever the firmware author guessed. And CoreGraphics
//! itself lies on their behalf: when a display supplies no size,
//! `CGDisplayScreenSize` does not return zero — it ESTIMATES one from the
//! bounds at 72 DPI, which passes every sanity check a naive reader would
//! write, because it has exactly the pixel grid's aspect ratio and a
//! believable diagonal. A wrong number here is worse than none: it flows
//! straight into the angular model and every size on the glass comes out
//! confidently wrong, with nothing looking broken. So the value is only
//! reported when it is plausible as a panel, agrees with the pixel grid's
//! aspect ratio, and is not that 72 DPI estimate; `None` is the honest answer
//! otherwise, and the front end then falls back to what it did before.
//!
//! Names are no help. `tauri::Monitor::name` on macOS is tao's
//! `Monitor #<model number>`, never the EDID product string, so the front
//! end's "does the name say Prompter" check has never fired on a Mac — the
//! 9-inch is caught by its 1024x600 grid and everything else was a guess
//! until these millimetres existed. That is the whole reason this module is
//! worth having.
//!
//! Other platforms answer `None` for now. Windows keeps the same EDID bytes in
//! the registry and Linux exposes them through sysfs, but neither is wired
//! here, and a `None` costs nothing but the automatic sizing on that platform.

use serde::Serialize;
use tauri::Monitor;

/// Active area of a panel in millimetres. Twin of the TypeScript
/// `PhysicalSizeMm` on `DisplayDescriptor`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalSizeMm {
    pub width: f64,
    pub height: f64,
}

/// Smallest and largest diagonal this will believe, in millimetres. The same
/// bounds `shared/optics.ts` applies to a typed-in diagonal: a phone is bigger
/// than the floor and a cinema screen is smaller than the ceiling.
const MIN_DIAGONAL_MM: f64 = 50.0;
const MAX_DIAGONAL_MM: f64 = 5000.0;

/// How far the millimetre aspect may disagree with the pixel aspect before the
/// millimetres are treated as a fabrication.
///
/// A real panel's pixels are square, so the two ratios agree to well under a
/// percent before rounding. The EDID field is in whole centimetres, so a
/// 9-inch panel (19 x 11 cm) can be off by up to about five percent from
/// rounding alone; anything taller rounds tighter. The nearest common
/// fabrication is a 16:9 placeholder reported for 16:10 glass, which is an
/// eleven percent disagreement. Eight percent sits between the two. A panel
/// driven at a stretched mode (4:3 into 16:9, about 33%) is also rejected, and
/// rightly: its millimetres per pixel differ by axis and cannot size text.
const MAX_ASPECT_DISAGREEMENT: f64 = 0.08;

/// Millimetres per point at the 72 DPI CoreGraphics assumes when it has to
/// estimate a size, and how close to that estimate a report may be before it
/// is treated as one.
///
/// A panel can genuinely be near 72 DPI — an old 15-inch 1024x768 CRT was —
/// but no modern panel a prompter would use lands within half a percent of
/// it on BOTH axes at once, and CoreGraphics's estimate matches exactly. Half
/// a percent is far inside EDID's whole-centimetre rounding, so the only
/// reports this rejects are the ones CoreGraphics made up.
const MM_PER_POINT_AT_72_DPI: f64 = 25.4 / 72.0;
const MAX_72_DPI_ESTIMATE_DISAGREEMENT: f64 = 0.005;

/// The placeholder some firmware writes when it does not know: 16 x 9 cm,
/// in either orientation.
///
/// A genuine 7-inch 16:9 panel would report exactly this too, so it cannot
/// be told apart by arithmetic — and the cost of believing it is severe (text
/// sized for a 7-inch panel on a 27-inch monitor is enormous, confidently).
/// It is refused by name. Linux's DRM layer treats the same value the same
/// way. A real 7-inch panel loses automatic sizing and keeps the wizard.
const EDID_PLACEHOLDER_MM: (f64, f64) = (160.0, 90.0);

/// What the platform reported for one display, before any judgement.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PanelReport {
    pub width_mm: f64,
    pub height_mm: f64,
    /// The pixel grid the display is running at.
    pub pixel_width: u32,
    pub pixel_height: u32,
    /// The display's bounds in POINTS — what CoreGraphics would have scaled
    /// to make up a size. Zero when the platform has no such notion.
    pub points_width: f64,
    pub points_height: f64,
}

/// Accept a reported panel size only if it can be a real panel behind these
/// pixels. Pure, and the whole policy — the platform readers below just feed it.
pub fn plausible_panel_mm(report: PanelReport) -> Option<PhysicalSizeMm> {
    let PanelReport {
        width_mm,
        height_mm,
        pixel_width,
        pixel_height,
        points_width,
        points_height,
    } = report;
    if !(width_mm.is_finite() && height_mm.is_finite()) {
        return None;
    }
    if width_mm <= 0.0 || height_mm <= 0.0 || pixel_width == 0 || pixel_height == 0 {
        return None;
    }
    let (placeholder_w, placeholder_h) = EDID_PLACEHOLDER_MM;
    if (width_mm, height_mm) == (placeholder_w, placeholder_h)
        || (width_mm, height_mm) == (placeholder_h, placeholder_w)
    {
        return None;
    }
    if is_72_dpi_estimate(width_mm, points_width) && is_72_dpi_estimate(height_mm, points_height) {
        return None;
    }
    let diagonal = width_mm.hypot(height_mm);
    if !(MIN_DIAGONAL_MM..=MAX_DIAGONAL_MM).contains(&diagonal) {
        return None;
    }
    // Either orientation: a panel rotated to portrait keeps reporting its
    // natural landscape millimetres while its pixel grid turns. The text is
    // sized from the diagonal, which does not care which way round it is.
    let px_aspect = pixel_width as f64 / pixel_height as f64;
    let upright = ((width_mm / height_mm) / px_aspect - 1.0).abs();
    let turned = ((height_mm / width_mm) / px_aspect - 1.0).abs();
    if upright.min(turned) > MAX_ASPECT_DISAGREEMENT {
        return None;
    }
    Some(PhysicalSizeMm {
        width: width_mm,
        height: height_mm,
    })
}

fn is_72_dpi_estimate(mm: f64, points: f64) -> bool {
    if !(points > 0.0) {
        return false;
    }
    let estimate = points * MM_PER_POINT_AT_72_DPI;
    (mm / estimate - 1.0).abs() <= MAX_72_DPI_ESTIMATE_DISAGREEMENT
}

/// One display as the operating system describes it, in the terms needed to
/// pair it with a `tauri::Monitor`. Kept platform-neutral so the pairing rule
/// can be tested without a window server.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PanelCandidate {
    pub pixel_width: u32,
    pub pixel_height: u32,
    /// Top-left of the display in the global coordinate space, in device
    /// pixels — the same space `Monitor::position` reports in.
    pub position_x: i32,
    pub position_y: i32,
    pub size_mm: Option<PhysicalSizeMm>,
}

/// Pair a monitor with the candidate that is the same display.
///
/// Pixel size first, because it is exact on both sides. Two connected panels
/// with the same pixel grid (a matched pair of monitors) are told apart by
/// position. Two displays MIRRORING each other sit at the same position with
/// the same grid and can be different glass entirely — a 15-inch prompter
/// mirroring a 27-inch monitor — so a position match is only trusted when
/// every candidate at that position agrees; the same rule covers the case
/// where nothing lines up at all. Only a genuinely ambiguous answer is
/// dropped, and it is dropped rather than guessed.
pub fn size_mm_for_monitor(
    candidates: &[PanelCandidate],
    pixel_width: u32,
    pixel_height: u32,
    position_x: i32,
    position_y: i32,
) -> Option<PhysicalSizeMm> {
    let same_grid: Vec<&PanelCandidate> = candidates
        .iter()
        .filter(|c| c.pixel_width == pixel_width && c.pixel_height == pixel_height)
        .collect();
    let unanimous = |group: &[&PanelCandidate]| -> Option<PhysicalSizeMm> {
        let first = group.first()?.size_mm;
        group.iter().all(|c| c.size_mm == first).then_some(first).flatten()
    };
    match same_grid.as_slice() {
        [] => None,
        [only] => only.size_mm,
        many => {
            let at_position: Vec<&PanelCandidate> = many
                .iter()
                .copied()
                .filter(|c| c.position_x == position_x && c.position_y == position_y)
                .collect();
            if !at_position.is_empty() {
                return unanimous(&at_position);
            }
            unanimous(many)
        }
    }
}

/// The platform's displays, read once.
///
/// One snapshot per enumeration, not one per monitor: a display unplugged
/// between two descriptors of the same list would otherwise turn a pair that
/// was correctly ambiguous into a lone candidate matched to the wrong glass.
pub struct PanelSizes {
    candidates: Vec<PanelCandidate>,
}

impl PanelSizes {
    pub fn snapshot() -> Self {
        Self {
            candidates: platform::candidates(),
        }
    }

    /// The physical size of the panel this monitor is, or `None` when the
    /// platform cannot say or the panel's own answer is not believable.
    pub fn for_monitor(&self, monitor: &Monitor) -> Option<PhysicalSizeMm> {
        let size = monitor.size();
        let position = monitor.position();
        size_mm_for_monitor(
            &self.candidates,
            size.width,
            size.height,
            position.x,
            position.y,
        )
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use super::{plausible_panel_mm, PanelCandidate, PanelReport};
    use core_graphics::display::CGDisplay;

    /// Every active display, straight from CoreGraphics.
    ///
    /// `CGDisplayBounds` is in points with a top-left origin, which is the
    /// space `tao` derives `Monitor::position` from before scaling it to device
    /// pixels; multiplying by the display's own pixels-per-point puts the two
    /// in the same space. `CGDisplayScreenSize` is the EDID image size in
    /// millimetres, `0 x 0` when the display did not supply one.
    ///
    /// The pixel grid comes from the current display MODE, not from
    /// `CGDisplayPixelsWide`: on a Retina panel the latter answers in points
    /// (a 6016-wide panel at the "looks like 3008" setting says 3008), while
    /// `Monitor::size` is real device pixels. Pairing on the wrong one fails
    /// for every scaled display, which on a Mac is every built-in one.
    pub fn candidates() -> Vec<PanelCandidate> {
        let Ok(ids) = CGDisplay::active_displays() else {
            return Vec::new();
        };
        ids.into_iter()
            .map(|id| {
                let display = CGDisplay::new(id);
                let bounds = display.bounds();
                let (pixel_width, pixel_height) = match display.display_mode() {
                    Some(mode) => (mode.pixel_width() as u32, mode.pixel_height() as u32),
                    None => (display.pixels_wide() as u32, display.pixels_high() as u32),
                };
                let scale = if bounds.size.width > 0.0 {
                    pixel_width as f64 / bounds.size.width
                } else {
                    1.0
                };
                let mm = display.screen_size();
                PanelCandidate {
                    pixel_width,
                    pixel_height,
                    position_x: (bounds.origin.x * scale).round() as i32,
                    position_y: (bounds.origin.y * scale).round() as i32,
                    size_mm: plausible_panel_mm(PanelReport {
                        width_mm: mm.width,
                        height_mm: mm.height,
                        pixel_width,
                        pixel_height,
                        points_width: bounds.size.width,
                        points_height: bounds.size.height,
                    }),
                }
            })
            .collect()
    }

    /// For the probe: the raw numbers behind each candidate, including the
    /// vendor and model CoreGraphics reports, so a panel could one day be
    /// recognised by identity instead of by what it says about itself.
    #[cfg(test)]
    pub fn probe_identity() {
        let Ok(ids) = CGDisplay::active_displays() else {
            return;
        };
        for id in ids {
            let display = CGDisplay::new(id);
            let mm = display.screen_size();
            let bounds = display.bounds();
            println!(
                "display {id}: vendor {} model {} serial {} rotation {} mirror-set {} raw {:.1} x {:.1} mm, bounds {:.0} x {:.0} pt",
                display.vendor_number(),
                display.model_number(),
                display.serial_number(),
                display.rotation(),
                display.is_in_mirror_set(),
                mm.width,
                mm.height,
                bounds.size.width,
                bounds.size.height,
            );
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use super::PanelCandidate;

    pub fn candidates() -> Vec<PanelCandidate> {
        Vec::new()
    }

    #[cfg(test)]
    pub fn probe_identity() {}
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not a test: a probe. `cargo test --lib windows::panel_size -- --ignored
    /// --nocapture` prints what this machine's displays report, which is how
    /// to find out whether a given panel's EDID is believed before trusting a
    /// take to it.
    #[test]
    #[ignore]
    fn probe_this_machine() {
        for candidate in platform::candidates() {
            println!("{candidate:?}");
        }
        platform::probe_identity();
    }

    fn mm(width: f64, height: f64) -> Option<PhysicalSizeMm> {
        Some(PhysicalSizeMm { width, height })
    }

    /// A report at 1x, points equal to pixels.
    fn report(width_mm: f64, height_mm: f64, pixel_width: u32, pixel_height: u32) -> PanelReport {
        PanelReport {
            width_mm,
            height_mm,
            pixel_width,
            pixel_height,
            points_width: pixel_width as f64,
            points_height: pixel_height as f64,
        }
    }

    /// A report at 2x: half as many points as pixels.
    fn retina(width_mm: f64, height_mm: f64, pixel_width: u32, pixel_height: u32) -> PanelReport {
        PanelReport {
            points_width: pixel_width as f64 / 2.0,
            points_height: pixel_height as f64 / 2.0,
            ..report(width_mm, height_mm, pixel_width, pixel_height)
        }
    }

    #[test]
    fn believes_a_real_panel() {
        // Elgato Prompter: 9-inch 1024x600, as its EDID actually reports it.
        assert_eq!(plausible_panel_mm(report(200.07, 117.23, 1024, 600)), mm(200.07, 117.23));
        // A 27-inch 16:9 monitor at 4K, 2x.
        assert_eq!(plausible_panel_mm(retina(597.0, 336.0, 3840, 2160)), mm(597.0, 336.0));
        // EDID rounds to whole centimetres; that must still pass, even on the
        // small panel where rounding costs the most.
        assert_eq!(plausible_panel_mm(retina(600.0, 340.0, 3840, 2160)), mm(600.0, 340.0));
        assert_eq!(plausible_panel_mm(report(190.0, 110.0, 1024, 600)), mm(190.0, 110.0));
        assert_eq!(plausible_panel_mm(report(200.0, 110.0, 1024, 600)), mm(200.0, 110.0));
        // A monitor turned to portrait keeps its landscape millimetres.
        assert_eq!(plausible_panel_mm(retina(597.0, 336.0, 2160, 3840)), mm(597.0, 336.0));
    }

    #[test]
    fn rejects_the_well_known_lies() {
        // No EDID at all.
        assert_eq!(plausible_panel_mm(report(0.0, 0.0, 1920, 1080)), None);
        // The "aspect ratio, not a size" placeholder — on 16:10 glass, where
        // the aspect gives it away, on 16:9 glass, where only its value does,
        // and turned on its side.
        assert_eq!(plausible_panel_mm(report(160.0, 90.0, 1920, 1200)), None);
        assert_eq!(plausible_panel_mm(report(160.0, 90.0, 1920, 1080)), None);
        assert_eq!(plausible_panel_mm(report(90.0, 160.0, 1080, 1920)), None);
        // A 16:9 report for 16:10 glass that is not the placeholder.
        assert_eq!(plausible_panel_mm(report(530.0, 298.0, 1920, 1200)), None);
        // Stretched: 4:3 millimetres behind 16:9 pixels.
        assert_eq!(plausible_panel_mm(report(400.0, 300.0, 1920, 1080)), None);
        // Bigger than a cinema.
        assert_eq!(plausible_panel_mm(report(6000.0, 3375.0, 1920, 1080)), None);
        // Garbage in.
        assert_eq!(plausible_panel_mm(report(f64::NAN, 100.0, 1920, 1080)), None);
        assert_eq!(plausible_panel_mm(report(100.0, 60.0, 0, 1080)), None);
    }

    #[test]
    fn rejects_the_size_coregraphics_makes_up() {
        // No EDID: CoreGraphics returns bounds x 25.4 / 72. At 1x that is a
        // perfectly believable 677 x 381 mm for a 1080p display — and it is
        // the exact value, so it is refused.
        let made_up = |points: f64| points * 25.4 / 72.0;
        assert_eq!(
            plausible_panel_mm(report(made_up(1920.0), made_up(1080.0), 1920, 1080)),
            None
        );
        // The same lie on a 2x display: bounds are points, not pixels.
        assert_eq!(
            plausible_panel_mm(retina(made_up(1920.0), made_up(1080.0), 3840, 2160)),
            None
        );
        // A real panel that merely happens to be NEAR 72 DPI on one axis is
        // still believed: both axes have to match to within half a percent.
        assert_eq!(
            plausible_panel_mm(report(made_up(1920.0), 360.0, 1920, 1080)),
            mm(made_up(1920.0), 360.0)
        );
        // No points at all (a platform without the notion) cannot trigger it.
        let no_points = PanelReport {
            points_width: 0.0,
            points_height: 0.0,
            ..report(made_up(1920.0), made_up(1080.0), 1920, 1080)
        };
        assert_eq!(
            plausible_panel_mm(no_points),
            mm(made_up(1920.0), made_up(1080.0))
        );
    }

    #[test]
    fn serialises_as_the_typescript_twin_expects() {
        let json = serde_json::to_value(PhysicalSizeMm {
            width: 200.5,
            height: 117.0,
        })
        .unwrap();
        assert_eq!(json, serde_json::json!({ "width": 200.5, "height": 117.0 }));
    }

    fn candidate(
        pixel_width: u32,
        pixel_height: u32,
        position_x: i32,
        size_mm: Option<PhysicalSizeMm>,
    ) -> PanelCandidate {
        PanelCandidate {
            pixel_width,
            pixel_height,
            position_x,
            position_y: 0,
            size_mm,
        }
    }

    #[test]
    fn pairs_by_pixel_grid_when_that_is_enough() {
        let candidates = [
            candidate(3024, 1964, 0, mm(302.0, 196.0)),
            candidate(1024, 600, 3024, mm(194.0, 114.0)),
        ];
        // Position deliberately wrong: the grid alone identifies the panel.
        assert_eq!(
            size_mm_for_monitor(&candidates, 1024, 600, 999, 999),
            mm(194.0, 114.0)
        );
        assert_eq!(size_mm_for_monitor(&candidates, 1920, 1080, 0, 0), None);
    }

    #[test]
    fn tells_a_matched_pair_apart_by_position() {
        let candidates = [
            candidate(1920, 1080, 0, mm(527.0, 296.0)),
            candidate(1920, 1080, 1920, mm(344.0, 194.0)),
        ];
        assert_eq!(
            size_mm_for_monitor(&candidates, 1920, 1080, 1920, 0),
            mm(344.0, 194.0)
        );
        // Twins that agree are used even when the position does not line up…
        let twins = [
            candidate(1920, 1080, 0, mm(527.0, 296.0)),
            candidate(1920, 1080, 1920, mm(527.0, 296.0)),
        ];
        assert_eq!(
            size_mm_for_monitor(&twins, 1920, 1080, 5000, 0),
            mm(527.0, 296.0)
        );
        // …and same-grid panels that disagree are dropped rather than guessed.
        assert_eq!(size_mm_for_monitor(&candidates, 1920, 1080, 5000, 0), None);
    }

    #[test]
    fn mirrored_displays_at_one_position_must_agree() {
        // A 15-inch prompter mirroring a 24-inch monitor: same grid, same
        // origin, different glass. Nothing can say which one the window is
        // on, so neither size is reported.
        let mirrored = [
            candidate(1920, 1080, 0, mm(344.0, 194.0)),
            candidate(1920, 1080, 0, mm(527.0, 296.0)),
        ];
        assert_eq!(size_mm_for_monitor(&mirrored, 1920, 1080, 0, 0), None);
        // Two of the same panel mirrored are fine.
        let same = [
            candidate(1920, 1080, 0, mm(344.0, 194.0)),
            candidate(1920, 1080, 0, mm(344.0, 194.0)),
        ];
        assert_eq!(size_mm_for_monitor(&same, 1920, 1080, 0, 0), mm(344.0, 194.0));
        // A mirrored pair where one side is unbelievable yields nothing too.
        let half = [
            candidate(1920, 1080, 0, mm(344.0, 194.0)),
            candidate(1920, 1080, 0, None),
        ];
        assert_eq!(size_mm_for_monitor(&half, 1920, 1080, 0, 0), None);
    }
}
