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
//! Windows keeps the same EDID bytes in the registry, under the PnP device
//! each monitor enumerates as, and they are read from there. Linux exposes
//! them through sysfs but is not wired here; a `None` costs nothing but the
//! automatic sizing on that platform.

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
    // NaN as well as zero and negative: a NaN point count is not an estimate
    // of anything. (Spelled out rather than `!(points > 0.0)`, which clippy
    // refuses on partially ordered types.)
    if points.is_nan() || points <= 0.0 {
        return false;
    }
    let estimate = points * MM_PER_POINT_AT_72_DPI;
    (mm / estimate - 1.0).abs() <= MAX_72_DPI_ESTIMATE_DISAGREEMENT
}

/// One display as the operating system describes it, in the terms needed to
/// pair it with a `tauri::Monitor`. Kept platform-neutral so the pairing rule
/// can be tested without a window server.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelCandidate {
    pub pixel_width: u32,
    pub pixel_height: u32,
    /// Top-left of the display in the global coordinate space, in device
    /// pixels — the same space `Monitor::position` reports in.
    pub position_x: i32,
    pub position_y: i32,
    pub size_mm: Option<PhysicalSizeMm>,
    /// The name the panel gives itself in its EDID, where the platform's own
    /// monitor name is not one. Windows only: tao names a Windows monitor by
    /// its GDI device path (`\\.\DISPLAY1`).
    pub name: Option<String>,
    /// The panel's manufacturer and product code from its EDID (`GSM5B7F`):
    /// its model, the same on every port and after every reboot. Windows only,
    /// for the same reason.
    pub product: Option<String>,
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
    paired(candidates, |c| c.size_mm, pixel_width, pixel_height, position_x, position_y)
}

/// The pairing rule above, for any one fact about the panel.
fn paired<T: Clone + PartialEq>(
    candidates: &[PanelCandidate],
    fact: impl Fn(&PanelCandidate) -> Option<T>,
    pixel_width: u32,
    pixel_height: u32,
    position_x: i32,
    position_y: i32,
) -> Option<T> {
    let same_grid: Vec<&PanelCandidate> = candidates
        .iter()
        .filter(|c| c.pixel_width == pixel_width && c.pixel_height == pixel_height)
        .collect();
    let unanimous = |group: &[&PanelCandidate]| -> Option<T> {
        let first = fact(group.first()?);
        group.iter().all(|c| fact(c) == first).then_some(first).flatten()
    };
    match same_grid.as_slice() {
        [] => None,
        [only] => fact(only),
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

    /// What naming a monitor needs: a real snapshot where the platform's own
    /// monitor name is not one (Windows — see [`PanelCandidate::name`]), and
    /// nothing anywhere else, so fingerprinting there costs no display query.
    pub fn for_naming() -> Self {
        if cfg!(target_os = "windows") {
            Self::snapshot()
        } else {
            Self {
                candidates: Vec::new(),
            }
        }
    }

    /// The physical size of the panel this monitor is, or `None` when the
    /// platform cannot say or the panel's own answer is not believable.
    pub fn for_monitor(&self, monitor: &Monitor) -> Option<PhysicalSizeMm> {
        self.fact(monitor, |c| c.size_mm)
    }

    /// The EDID name of the panel this monitor is (see [`PanelCandidate::name`]).
    pub fn name_for_monitor(&self, monitor: &Monitor) -> Option<String> {
        self.fact(monitor, |c| c.name.clone())
    }

    /// The EDID product code of the panel this monitor is.
    pub fn product_for_monitor(&self, monitor: &Monitor) -> Option<String> {
        self.fact(monitor, |c| c.product.clone())
    }

    fn fact<T: Clone + PartialEq>(
        &self,
        monitor: &Monitor,
        fact: impl Fn(&PanelCandidate) -> Option<T>,
    ) -> Option<T> {
        let size = monitor.size();
        let position = monitor.position();
        paired(&self.candidates, fact, size.width, size.height, position.x, position.y)
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
                    // tao's `Monitor #<model>` is already the model here.
                    name: None,
                    product: None,
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

/// The image size an EDID block declares, in millimetres.
///
/// The first detailed timing descriptor carries the size to the millimetre
/// (twelve bits per axis, at bytes 66–68); the basic display parameters carry
/// it in whole centimetres (bytes 21–22). The descriptor is preferred when it
/// is present and non-zero, because the centimetre field costs a 9-inch panel
/// about five percent to rounding. Pure — the plausibility judgement is
/// [`plausible_panel_mm`]'s, not this function's.
pub fn edid_image_size_mm(edid: &[u8]) -> Option<(f64, f64)> {
    const HEADER: [u8; 8] = [0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00];
    if edid.len() < 128 || edid[..8] != HEADER {
        return None;
    }
    // A zero pixel clock means the first descriptor is a display descriptor
    // (a name, a serial), not a timing, and its bytes 66–68 mean something else.
    let has_timing = edid[54] != 0 || edid[55] != 0;
    if has_timing {
        let width = u16::from(edid[66]) | (u16::from(edid[68] & 0xF0) << 4);
        let height = u16::from(edid[67]) | (u16::from(edid[68] & 0x0F) << 8);
        if width > 0 && height > 0 {
            return Some((f64::from(width), f64::from(height)));
        }
    }
    let (width_cm, height_cm) = (edid[21], edid[22]);
    (width_cm > 0 && height_cm > 0)
        .then(|| (f64::from(width_cm) * 10.0, f64::from(height_cm) * 10.0))
}

/// The monitor name an EDID block declares: the display descriptor tagged
/// `0xFC`, in any of the four descriptor slots — `DELL U2720Q`, `LG HDR 4K`.
///
/// Up to thirteen bytes of code page 437, ended by a line feed and padded with
/// spaces. Laptop panels commonly carry none (they use the `0xFE` free-text
/// slots for a part number instead), and that is reported as `None` rather
/// than read from the wrong descriptor.
pub fn edid_monitor_name(edid: &[u8]) -> Option<String> {
    if edid.len() < 128 {
        return None;
    }
    [54usize, 72, 90, 108].iter().find_map(|&at| {
        let descriptor = &edid[at..at + 18];
        if descriptor[..3] != [0, 0, 0] || descriptor[3] != 0xFC {
            return None;
        }
        let text: String = descriptor[5..]
            .iter()
            .take_while(|&&b| b != 0x0A && b != 0)
            .map(|&b| if b.is_ascii_graphic() || b == b' ' { b as char } else { '?' })
            .collect();
        let text = text.trim();
        (!text.is_empty()).then(|| text.to_owned())
    })
}

/// The manufacturer and product code an EDID block declares, as Windows
/// spells them in a monitor's hardware ID: three letters and four hex digits,
/// `GSM5B7F`.
///
/// The manufacturer is three five-bit letters packed big-endian into bytes
/// 8–9 (`1` is `A`); the product code is little-endian in bytes 10–11.
pub fn edid_product_id(edid: &[u8]) -> Option<String> {
    const HEADER: [u8; 8] = [0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00];
    if edid.len() < 128 || edid[..8] != HEADER {
        return None;
    }
    let packed = u16::from_be_bytes([edid[8], edid[9]]);
    let letter = |shift: u16| {
        let code = (packed >> shift) & 0x1F;
        (1..=26).contains(&code).then(|| (b'A' + code as u8 - 1) as char)
    };
    let product = u16::from_le_bytes([edid[10], edid[11]]);
    Some(format!("{}{}{}{product:04X}", letter(10)?, letter(5)?, letter(0)?))
}

/// The registry key holding a monitor's EDID, from the device interface path
/// `EnumDisplayDevicesW` hands back with `EDD_GET_DEVICE_INTERFACE_NAME`.
///
/// `\\?\DISPLAY#GSM5B7F#5&2b8e9fe0&0&UID4353#{e6f07b5f-…}` names the device
/// `DISPLAY\GSM5B7F\5&2b8e9fe0&0&UID4353` in the PnP tree, and Windows keeps
/// the EDID that panel last reported in its `Device Parameters`. Anything that
/// does not have exactly that shape is refused rather than guessed at.
pub fn edid_registry_key(device_interface: &str) -> Option<String> {
    let path = device_interface.strip_prefix(r"\\?\")?;
    let mut parts = path.split('#');
    let (class, model, instance) = (parts.next()?, parts.next()?, parts.next()?);
    let _interface_class = parts.next()?;
    if parts.next().is_some() || !class.eq_ignore_ascii_case("DISPLAY") {
        return None;
    }
    if model.is_empty() || instance.is_empty() || model.contains('\\') || instance.contains('\\') {
        return None;
    }
    Some(format!(
        r"SYSTEM\CurrentControlSet\Enum\DISPLAY\{model}\{instance}\Device Parameters"
    ))
}

/// Windows keeps every panel's EDID in the registry, under the PnP device the
/// monitor enumerates as. The path there runs monitor → adapter output →
/// monitor device → registry key:
///
/// - `EnumDisplayMonitors` / `GetMonitorInfoW` give each monitor's rectangle
///   in physical pixels — exactly the numbers tao turns into
///   `Monitor::position` and `Monitor::size` for a per-monitor-DPI-aware
///   process, which every Tauri app is — and the adapter output it is on
///   (`\\.\DISPLAY1`);
/// - `EnumDisplayDevicesW` on that output, with
///   `EDD_GET_DEVICE_INTERFACE_NAME`, names each panel attached to it. An
///   output normally has one; a duplicated pair has two, and each becomes its
///   own candidate at the same rectangle so the mirroring rule in
///   [`size_mm_for_monitor`] can refuse to pick between them;
/// - the EDID itself is a `REG_BINARY` read with `RegGetValueW`.
///
/// Raw FFI, matching `sleep.rs`, rather than a `windows` crate dependency for
/// four calls.
#[cfg(target_os = "windows")]
mod platform {
    use super::{
        edid_image_size_mm, edid_monitor_name, edid_product_id, edid_registry_key,
        plausible_panel_mm, PanelCandidate, PanelReport,
    };
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy, Default)]
    struct Rect {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }

    #[repr(C)]
    struct MonitorInfoExW {
        cb_size: u32,
        rc_monitor: Rect,
        rc_work: Rect,
        flags: u32,
        device: [u16; 32],
    }

    #[repr(C)]
    struct DisplayDeviceW {
        cb: u32,
        device_name: [u16; 32],
        device_string: [u16; 128],
        state_flags: u32,
        device_id: [u16; 128],
        device_key: [u16; 128],
    }

    type MonitorEnumProc = unsafe extern "system" fn(isize, isize, *mut Rect, isize) -> i32;

    #[link(name = "user32")]
    extern "system" {
        fn EnumDisplayMonitors(hdc: isize, clip: *const Rect, callback: MonitorEnumProc, data: isize) -> i32;
        fn GetMonitorInfoW(monitor: isize, info: *mut MonitorInfoExW) -> i32;
        fn EnumDisplayDevicesW(device: *const u16, index: u32, info: *mut DisplayDeviceW, flags: u32) -> i32;
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(
            key: isize,
            subkey: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut c_void,
            size: *mut u32,
        ) -> i32;
    }

    /// `HKEY_LOCAL_MACHINE` is `(HKEY)(ULONG_PTR)((LONG)0x80000002)`: the
    /// value is sign-extended to pointer width, so the cast goes through `i32`.
    const HKEY_LOCAL_MACHINE: isize = 0x8000_0002_u32 as i32 as isize;
    const RRF_RT_REG_BINARY: u32 = 0x0000_0008;
    const EDD_GET_DEVICE_INTERFACE_NAME: u32 = 0x0000_0001;
    const DISPLAY_DEVICE_ACTIVE: u32 = 0x0000_0001;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    fn from_wide(buffer: &[u16]) -> String {
        let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..end])
    }

    /// Every monitor's rectangle and adapter output, in enumeration order.
    fn monitors() -> Vec<(Rect, Vec<u16>)> {
        unsafe extern "system" fn collect(monitor: isize, _: isize, _: *mut Rect, data: isize) -> i32 {
            // SAFETY: `data` is the `&mut Vec` passed below, alive for the
            // whole synchronous enumeration.
            let found = unsafe { &mut *(data as *mut Vec<(Rect, Vec<u16>)>) };
            let mut info = MonitorInfoExW {
                cb_size: std::mem::size_of::<MonitorInfoExW>() as u32,
                rc_monitor: Rect::default(),
                rc_work: Rect::default(),
                flags: 0,
                device: [0; 32],
            };
            // SAFETY: `info` is a correctly sized MONITORINFOEXW.
            if unsafe { GetMonitorInfoW(monitor, &mut info) } != 0 {
                let end = info.device.iter().position(|&c| c == 0).unwrap_or(32);
                let mut device = info.device[..end].to_vec();
                device.push(0);
                found.push((info.rc_monitor, device));
            }
            1
        }
        let mut found: Vec<(Rect, Vec<u16>)> = Vec::new();
        // SAFETY: the callback only touches `found` through the pointer it is
        // given, and the enumeration is synchronous.
        unsafe {
            EnumDisplayMonitors(0, std::ptr::null(), collect, &mut found as *mut _ as isize);
        }
        found
    }

    /// The device interface path of every active panel on one adapter output.
    fn panels_on(output: &[u16]) -> Vec<String> {
        let mut panels = Vec::new();
        for index in 0.. {
            let mut device = DisplayDeviceW {
                cb: std::mem::size_of::<DisplayDeviceW>() as u32,
                device_name: [0; 32],
                device_string: [0; 128],
                state_flags: 0,
                device_id: [0; 128],
                device_key: [0; 128],
            };
            // SAFETY: `output` is NUL-terminated and `device` correctly sized.
            let ok = unsafe {
                EnumDisplayDevicesW(output.as_ptr(), index, &mut device, EDD_GET_DEVICE_INTERFACE_NAME)
            };
            if ok == 0 {
                break;
            }
            if device.state_flags & DISPLAY_DEVICE_ACTIVE != 0 {
                panels.push(from_wide(&device.device_id));
            }
        }
        panels
    }

    fn read_edid(key: &str) -> Option<Vec<u8>> {
        let (key, value) = (wide(key), wide("EDID"));
        // EDID is 128 bytes per block, and the block count is one byte: 256
        // blocks is the most any panel can declare.
        let mut buffer = vec![0u8; 128 * 256];
        let mut size = buffer.len() as u32;
        // SAFETY: both strings are NUL-terminated; `size` describes `buffer`.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_BINARY,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != 0 {
            return None;
        }
        buffer.truncate(size as usize);
        Some(buffer)
    }

    pub fn candidates() -> Vec<PanelCandidate> {
        let mut out = Vec::new();
        for (rect, output) in monitors() {
            let pixel_width = (rect.right - rect.left).max(0) as u32;
            let pixel_height = (rect.bottom - rect.top).max(0) as u32;
            let mut panels = panels_on(&output);
            // A monitor with no panel the API will name is still a monitor:
            // it is reported with no size rather than dropped, so it can still
            // make a same-grid neighbour ambiguous.
            if panels.is_empty() {
                panels.push(String::new());
            }
            for panel in panels {
                let edid = edid_registry_key(&panel).and_then(|key| read_edid(&key));
                let edid = edid.as_deref().unwrap_or_default();
                let size_mm = edid_image_size_mm(edid).and_then(|(width_mm, height_mm)| {
                    plausible_panel_mm(PanelReport {
                        width_mm,
                        height_mm,
                        pixel_width,
                        pixel_height,
                        // Windows has no point space to estimate from.
                        points_width: 0.0,
                        points_height: 0.0,
                    })
                });
                out.push(PanelCandidate {
                    pixel_width,
                    pixel_height,
                    position_x: rect.left,
                    position_y: rect.top,
                    size_mm,
                    name: edid_monitor_name(edid),
                    product: edid_product_id(edid),
                });
            }
        }
        out
    }

    /// For the probe: the device paths and the raw EDID sizes behind each
    /// candidate, before plausibility is applied.
    #[cfg(test)]
    pub fn probe_identity() {
        for (rect, output) in monitors() {
            for panel in panels_on(&output) {
                let raw = edid_registry_key(&panel).and_then(|key| read_edid(&key)).map(|edid| {
                    (
                        edid.len(),
                        edid_image_size_mm(&edid),
                        edid_monitor_name(&edid),
                        edid_product_id(&edid),
                    )
                });
                println!(
                    "monitor {} at ({}, {}) {}x{}: panel {panel} edid {raw:?}",
                    from_wide(&output),
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                );
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
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
            name: None,
            product: None,
        }
    }

    #[test]
    fn names_pair_by_the_same_rule_as_sizes() {
        let named = |position_x: i32, name: &str| PanelCandidate {
            name: Some(name.into()),
            ..candidate(1920, 1080, position_x, None)
        };
        let candidates = [named(0, "DELL U2720Q"), named(1920, "LG HDR 4K")];
        assert_eq!(
            paired(&candidates, |c| c.name.clone(), 1920, 1080, 1920, 0).as_deref(),
            Some("LG HDR 4K")
        );
        // Mirrored glass that names itself differently is not guessed at.
        let mirrored = [named(0, "DELL U2720Q"), named(0, "Prompter")];
        assert_eq!(paired(&mirrored, |c| c.name.clone(), 1920, 1080, 0, 0), None);
    }

    #[test]
    fn edid_monitor_name_reads_the_fc_descriptor_wherever_it_sits() {
        let mut block = edid((60, 34), Some((597, 336)));
        // Slot 2 holds a serial (0xFF); slot 3 holds the name.
        block[72..90].copy_from_slice(b"\0\0\0\xFF\0SERIAL12345\n ");
        block[90..108].copy_from_slice(b"\0\0\0\xFC\0DELL U2720Q\n ");
        assert_eq!(edid_monitor_name(&block).as_deref(), Some("DELL U2720Q"));
        // Thirteen characters fill the field with no line feed at all.
        block[90..108].copy_from_slice(b"\0\0\0\xFC\0ABCDEFGHIJKLM");
        assert_eq!(edid_monitor_name(&block).as_deref(), Some("ABCDEFGHIJKLM"));
        // A laptop panel with only free text (0xFE) has no name to report,
        // and the timing in slot 1 is never misread as a descriptor.
        let mut laptop = edid((34, 19), Some((344, 194)));
        laptop[72..90].copy_from_slice(b"\0\0\0\xFE\0LG Display\n  ");
        assert_eq!(edid_monitor_name(&laptop), None);
        // A name that is only padding is no name.
        laptop[90..108].copy_from_slice(b"\0\0\0\xFC\0\n            ");
        assert_eq!(edid_monitor_name(&laptop), None);
    }

    #[test]
    fn edid_product_id_spells_the_windows_hardware_id() {
        let mut block = edid((60, 34), None);
        // "GSM": G=7, S=19, M=13 → 0b0_00111_10011_01101 = 0x1E6D.
        block[8] = 0x1E;
        block[9] = 0x6D;
        // Product 0x5B7F, little-endian.
        block[10] = 0x7F;
        block[11] = 0x5B;
        assert_eq!(edid_product_id(&block).as_deref(), Some("GSM5B7F"));
        // A letter outside A–Z is not a manufacturer.
        block[8] = 0x00;
        block[9] = 0x00;
        assert_eq!(edid_product_id(&block), None);
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

    /// A base EDID block declaring `cm` in the basic parameters and, when
    /// `timing_mm` is given, a first detailed timing with that size.
    fn edid(cm: (u8, u8), timing_mm: Option<(u16, u16)>) -> Vec<u8> {
        let mut block = vec![0u8; 128];
        block[..8].copy_from_slice(&[0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0x00]);
        block[21] = cm.0;
        block[22] = cm.1;
        if let Some((width, height)) = timing_mm {
            // 148.5 MHz, little-endian in 10 kHz units: any non-zero clock.
            block[54] = 0x02;
            block[55] = 0x3A;
            block[66] = (width & 0xFF) as u8;
            block[67] = (height & 0xFF) as u8;
            block[68] = (((width >> 8) as u8) << 4) | ((height >> 8) as u8 & 0x0F);
        }
        block
    }

    #[test]
    fn edid_size_prefers_the_millimetre_timing_to_the_centimetre_field() {
        // The Elgato Prompter: 20 x 12 cm in the basic block, 200 x 117 mm in
        // the timing — the timing wins.
        assert_eq!(edid_image_size_mm(&edid((20, 12), Some((200, 117)))), Some((200.0, 117.0)));
        // Twelve bits per axis: a 27-inch panel needs the high nibbles.
        assert_eq!(edid_image_size_mm(&edid((60, 34), Some((597, 336)))), Some((597.0, 336.0)));
        // A timing that declares no size falls back to the centimetres…
        assert_eq!(edid_image_size_mm(&edid((34, 19), Some((0, 0)))), Some((340.0, 190.0)));
        // …and so does a first descriptor that is not a timing at all.
        let mut named = edid((34, 19), Some((344, 194)));
        named[54] = 0;
        named[55] = 0;
        assert_eq!(edid_image_size_mm(&named), Some((340.0, 190.0)));
    }

    #[test]
    fn edid_size_refuses_what_is_not_an_edid() {
        // No size anywhere (a projector, an adapter).
        assert_eq!(edid_image_size_mm(&edid((0, 0), None)), None);
        // Short, and a bad header.
        assert_eq!(edid_image_size_mm(&edid((34, 19), None)[..127]), None);
        let mut bad = edid((34, 19), None);
        bad[0] = 0x01;
        assert_eq!(edid_image_size_mm(&bad), None);
    }

    #[test]
    fn edid_registry_key_comes_from_the_device_interface_path() {
        assert_eq!(
            edid_registry_key(
                r"\\?\DISPLAY#GSM5B7F#5&2b8e9fe0&0&UID4353#{e6f07b5f-ee97-4a90-b076-33f57bf4eaa7}"
            )
            .as_deref(),
            Some(r"SYSTEM\CurrentControlSet\Enum\DISPLAY\GSM5B7F\5&2b8e9fe0&0&UID4353\Device Parameters")
        );
        // Not a monitor interface, the wrong shape, or an attempt to climb
        // out of the key: refused rather than read.
        for bad in [
            "",
            r"MONITOR\GSM5B7F\{4d36e96e-e325-11ce-bfc1-08002be10318}\0001",
            r"\\?\PCI#VEN_8086#4&1#{guid}",
            r"\\?\DISPLAY#GSM5B7F#{guid}",
            r"\\?\DISPLAY#GSM5B7F#5&2b8e9fe0&0&UID4353#{guid}#extra",
            r"\\?\DISPLAY#..\..\SAM#1#{guid}",
        ] {
            assert_eq!(edid_registry_key(bad), None, "{bad}");
        }
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
