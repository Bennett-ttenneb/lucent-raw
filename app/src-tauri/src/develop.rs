//! The edit recipe and the pixel pipeline. One recipe is rendered the same way for the
//! on-screen proxy and for export, so what you see is what you export.
//!
//! The pipeline works on 8-bit sRGB images: white balance and exposure in linear light,
//! then a tone curve and colour changes on the encoded values. For RAW files the base is
//! the camera's embedded preview or a plain develop (see `media::decode_raw`), not the
//! sensor data, so highlight recovery is limited. That is a known simplification.

use crate::geometry::{self, Geometry};
use crate::masks::{self, Mask};
use crate::portrait::{self, Portrait};
use crate::presence;
use crate::redeye::{self, RedEye};
use crate::spots::{self, Spot};
use image::{Rgb, RgbImage};
use serde::{Deserialize, Serialize};

pub const PROCESS_VERSION: i64 = 1;

/// The groups of settings a preset or a copy can include. The page uses the same names.
pub const SETTING_GROUPS: [&str; 13] = ["whiteBalance", "profile", "tone", "presence", "curve", "mixer", "grading", "calibration", "sharpening", "noise", "effects", "geometry", "crop"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Crop {
    /// "original", "free", "1:1", "4:3", "3:2", "16:9" or "5:4". Wide ratios apply to the long side. With a `rect` the
    /// ratio only says how the page locks the frame while it is dragged; the picture is cut by the `rect`.
    pub aspect: String,
    /// Straighten angle in degrees, clockwise, -45 to 45.
    pub angle: f32,
    /// The frame, when it has been placed by hand. Without it the biggest centred frame of the aspect is used.
    pub rect: Option<CropRect>,
}

/// A crop frame: its centre and size as fractions of the (lens-corrected) picture. It is turned by the straighten angle about its centre.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropRect {
    pub cx: f32,
    pub cy: f32,
    pub w: f32,
    pub h: f32,
}

impl CropRect {
    fn sanitized(self) -> Option<CropRect> {
        let ok = [self.cx, self.cy, self.w, self.h].iter().all(|v| v.is_finite());
        ok.then(|| CropRect { cx: self.cx.clamp(0.0, 1.0), cy: self.cy.clamp(0.0, 1.0), w: self.w.clamp(0.02, 1.0), h: self.h.clamp(0.02, 1.0) })
    }
}

/// Make a frame fit inside a picture of `w` x `h` pixels once turned by `angle` degrees: too big, and it is shrunk about
/// its own proportions; then it is moved until none of its corners is outside.
pub fn fit_crop_rect(rect: CropRect, angle: f32, w: f32, h: f32) -> CropRect {
    let th = angle.to_radians();
    let (c, s) = (th.cos().abs(), th.sin().abs());
    let (mut hw, mut hh) = (rect.w * w / 2.0, rect.h * h / 2.0);
    let extent = |hw: f32, hh: f32| (c * hw + s * hh, s * hw + c * hh);
    let (ex, ey) = extent(hw, hh);
    let k = ((w / 2.0) / ex).min((h / 2.0) / ey).min(1.0);
    hw *= k;
    hh *= k;
    let (ex, ey) = extent(hw, hh);
    CropRect { cx: (rect.cx * w).clamp(ex, (w - ex).max(ex)) / w, cy: (rect.cy * h).clamp(ey, (h - ey).max(ey)) / h, w: 2.0 * hw / w, h: 2.0 * hh / h }
}

impl Default for Crop {
    fn default() -> Self {
        Crop { aspect: "original".into(), angle: 0.0, rect: None }
    }
}

/// Reads the faces of a recipe: a list, or (older recipes) a single object, or nothing.
fn portraits_compat<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Portrait>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum OneOrMany {
        Many(Vec<Portrait>),
        One(Box<Portrait>),
        Nothing(()),
    }
    Ok(match OneOrMany::deserialize(d)? {
        OneOrMany::Many(v) => v,
        OneOrMany::One(p) => vec![*p],
        OneOrMany::Nothing(()) => Vec::new(),
    })
}

/// Sharpening and noise reduction. All zero (radius 1.0) leaves the picture alone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Detail {
    pub sharp_amount: f32,  // 0..150
    pub sharp_radius: f32,  // 0.5..3, in pixels of a 2048 px wide picture
    pub sharp_masking: f32, // 0..100, how much flat areas are left alone
    pub nr_luma: f32,       // 0..100
    pub nr_colour: f32,     // 0..100
    /// 0..100: 0 sharpens at the radius only; more adds the finest texture too
    pub sharp_detail: f32,
    /// 0..100, how much fine detail the luminance noise reduction keeps (50 is the plain setting)
    pub nr_luma_detail: f32,
    /// 0..100, how much contrast the luminance noise reduction keeps
    pub nr_luma_contrast: f32,
    /// 0..100, how wide an area the colour noise reduction smooths over (50 is the plain setting)
    pub nr_colour_smooth: f32,
}

impl Default for Detail {
    fn default() -> Self {
        Detail { sharp_amount: 0.0, sharp_radius: 1.0, sharp_masking: 0.0, nr_luma: 0.0, nr_colour: 0.0, sharp_detail: 0.0, nr_luma_detail: 50.0, nr_luma_contrast: 0.0, nr_colour_smooth: 50.0 }
    }
}

impl Detail {
    fn sanitized(&self) -> Detail {
        let c = |v: f32, lo: f32, hi: f32, d: f32| if v.is_finite() { v.clamp(lo, hi) } else { d };
        Detail {
            sharp_amount: c(self.sharp_amount, 0.0, 150.0, 0.0),
            sharp_radius: c(self.sharp_radius, 0.5, 3.0, 1.0),
            sharp_masking: c(self.sharp_masking, 0.0, 100.0, 0.0),
            nr_luma: c(self.nr_luma, 0.0, 100.0, 0.0),
            nr_colour: c(self.nr_colour, 0.0, 100.0, 0.0),
            sharp_detail: c(self.sharp_detail, 0.0, 100.0, 0.0),
            nr_luma_detail: c(self.nr_luma_detail, 0.0, 100.0, 50.0),
            nr_luma_contrast: c(self.nr_luma_contrast, 0.0, 100.0, 0.0),
            nr_colour_smooth: c(self.nr_colour_smooth, 0.0, 100.0, 50.0),
        }
    }
    pub fn is_off(&self) -> bool {
        self.sharp_amount < 0.5 && self.nr_luma < 0.5 && self.nr_colour < 0.5
    }
}

/// Vignette and grain, applied last, relative to the whole (cropped) picture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Effects {
    pub vignette_amount: f32,    // -100 (darker corners) .. 100 (lighter corners)
    pub vignette_midpoint: f32,  // 0..100, how far from the centre the effect starts
    pub vignette_feather: f32,   // 0..100, how soft the edge of the effect is
    pub vignette_roundness: f32, // 0 follows the picture's shape, 100 is a circle
    pub grain_amount: f32,       // 0..100
    pub grain_size: f32,         // 0..100
    pub grain_roughness: f32,    // 0..100
}

impl Default for Effects {
    fn default() -> Self {
        Effects { vignette_amount: 0.0, vignette_midpoint: 50.0, vignette_feather: 50.0, vignette_roundness: 50.0, grain_amount: 0.0, grain_size: 25.0, grain_roughness: 50.0 }
    }
}

impl Effects {
    fn sanitized(&self) -> Effects {
        let c = |v: f32, lo: f32, hi: f32, d: f32| if v.is_finite() { v.clamp(lo, hi) } else { d };
        Effects {
            vignette_amount: c(self.vignette_amount, -100.0, 100.0, 0.0),
            vignette_midpoint: c(self.vignette_midpoint, 0.0, 100.0, 50.0),
            vignette_feather: c(self.vignette_feather, 0.0, 100.0, 50.0),
            vignette_roundness: c(self.vignette_roundness, 0.0, 100.0, 50.0),
            grain_amount: c(self.grain_amount, 0.0, 100.0, 0.0),
            grain_size: c(self.grain_size, 0.0, 100.0, 25.0),
            grain_roughness: c(self.grain_roughness, 0.0, 100.0, 50.0),
        }
    }
    pub fn is_off(&self) -> bool {
        self.vignette_amount.abs() < 0.5 && self.grain_amount < 0.5
    }
}

/// Colour mixer: eight colour bands (red, orange, yellow, green, aqua, blue, purple, magenta),
/// each with a hue, saturation and luminance change from -100 to 100.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Hsl {
    pub hue: [f32; 8],
    pub sat: [f32; 8],
    pub lum: [f32; 8],
}

impl Hsl {
    pub fn is_zero(&self) -> bool {
        self.hue.iter().chain(&self.sat).chain(&self.lum).all(|v| v.abs() < 1e-4)
    }
    fn sanitized(&self) -> Hsl {
        let c = |a: &[f32; 8]| a.map(|v| if v.is_finite() { v.clamp(-100.0, 100.0) } else { 0.0 });
        Hsl { hue: c(&self.hue), sat: c(&self.sat), lum: c(&self.lum) }
    }
}

/// Calibration: how the camera's three primary colours are rendered. Each primary can be turned in hue and made more or less saturated (the way
/// Lightroom's Calibration panel does), and a tint can be put in the shadows. All values are -100 to 100.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Calibration {
    pub shadows_tint: f32,
    pub red_hue: f32,
    pub red_sat: f32,
    pub green_hue: f32,
    pub green_sat: f32,
    pub blue_hue: f32,
    pub blue_sat: f32,
}

impl Calibration {
    pub fn is_zero(&self) -> bool {
        [self.shadows_tint, self.red_hue, self.red_sat, self.green_hue, self.green_sat, self.blue_hue, self.blue_sat].iter().all(|v| v.abs() < 1e-4)
    }
    fn sanitized(&self) -> Calibration {
        let c = |v: f32| if v.is_finite() { v.clamp(-100.0, 100.0) } else { 0.0 };
        Calibration { shadows_tint: c(self.shadows_tint), red_hue: c(self.red_hue), red_sat: c(self.red_sat), green_hue: c(self.green_hue), green_sat: c(self.green_sat), blue_hue: c(self.blue_hue), blue_sat: c(self.blue_sat) }
    }

    /// The 3x3 matrix (row major, applied to linear light) that renders each primary as asked: the primary's colour, away from grey, is turned by up to
    /// 30 degrees about the grey axis and its colour amount is scaled by up to 2, then the three become the matrix's columns.
    pub fn matrix(&self) -> [[f32; 3]; 3] {
        let axis = [1.0f32 / 3f32.sqrt(); 3];
        let column = |p: usize, hue: f32, sat: f32| -> [f32; 3] {
            let mut v = [0.0f32; 3];
            v[p] = 1.0;
            let grey = 1.0 / 3.0;
            let ch = [v[0] - grey, v[1] - grey, v[2] - grey];
            // Rodrigues: turn `ch` about the grey axis by the angle
            let th = (hue / 100.0 * 30.0f32).to_radians();
            let (s, c) = th.sin_cos();
            let dot = ch[0] * axis[0] + ch[1] * axis[1] + ch[2] * axis[2];
            let cross = [axis[1] * ch[2] - axis[2] * ch[1], axis[2] * ch[0] - axis[0] * ch[2], axis[0] * ch[1] - axis[1] * ch[0]];
            let k = 1.0 + sat / 100.0; // 0 at -100, 2 at 100
            let mut out = [0.0f32; 3];
            for i in 0..3 {
                let rot = ch[i] * c + cross[i] * s + axis[i] * dot * (1.0 - c);
                out[i] = grey + rot * k;
            }
            out
        };
        let (r, g, b) = (column(0, self.red_hue, self.red_sat), column(1, self.green_hue, self.green_sat), column(2, self.blue_hue, self.blue_sat));
        let mut m = [[r[0], g[0], b[0]], [r[1], g[1], b[1]], [r[2], g[2], b[2]]];
        // grey stays grey: each row is scaled so that white (1, 1, 1) is still white
        for row in m.iter_mut() {
            let sum: f32 = row.iter().sum();
            if sum.abs() > 1e-3 {
                row.iter_mut().for_each(|v| *v /= sum);
            }
        }
        m
    }
}

/// One colour wheel of the colour grading: a hue (degrees, 0 to 360), how much colour (0 to 100) and a lift or drop of brightness (-100 to 100).
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Wheel {
    pub hue: f32,
    pub sat: f32,
    pub lum: f32,
}

impl Wheel {
    fn is_zero(&self) -> bool {
        self.sat.abs() < 1e-4 && self.lum.abs() < 1e-4
    }
    fn sanitized(&self) -> Wheel {
        let c = |v: f32, lo: f32, hi: f32, d: f32| if v.is_finite() { v.clamp(lo, hi) } else { d };
        Wheel { hue: c(self.hue, 0.0, 360.0, 0.0), sat: c(self.sat, 0.0, 100.0, 0.0), lum: c(self.lum, -100.0, 100.0, 0.0) }
    }
}

/// Colour grading: a wheel for the shadows, the midtones and the highlights, one for the whole picture, and two controls for how the tones are
/// shared between them.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Grading {
    pub shadows: Wheel,
    pub midtones: Wheel,
    pub highlights: Wheel,
    pub global: Wheel,
    /// How far the three regions overlap, 0 to 100 (50 is the middle).
    pub blending: f32,
    /// Where the midtones sit: -100 moves the boundary towards the shadows, 100 towards the highlights.
    pub balance: f32,
}

impl Default for Grading {
    fn default() -> Self {
        Grading { shadows: Wheel::default(), midtones: Wheel::default(), highlights: Wheel::default(), global: Wheel::default(), blending: 50.0, balance: 0.0 }
    }
}

impl Grading {
    pub fn is_zero(&self) -> bool {
        self.shadows.is_zero() && self.midtones.is_zero() && self.highlights.is_zero() && self.global.is_zero()
    }
    fn sanitized(&self) -> Grading {
        let c = |v: f32, lo: f32, hi: f32, d: f32| if v.is_finite() { v.clamp(lo, hi) } else { d };
        Grading { shadows: self.shadows.sanitized(), midtones: self.midtones.sanitized(), highlights: self.highlights.sanitized(), global: self.global.sanitized(), blending: c(self.blending, 0.0, 100.0, 50.0), balance: c(self.balance, -100.0, 100.0, 0.0) }
    }
}

/// The colour a wheel adds: the hue's colour, minus grey, scaled by how much colour is asked for.
fn wheel_tint(w: &Wheel) -> [f32; 3] {
    let h = (w.hue % 360.0) / 60.0;
    let x = 1.0 - (h % 2.0 - 1.0).abs();
    let (r, g, b) = match h as u32 {
        0 => (1.0, x, 0.0),
        1 => (x, 1.0, 0.0),
        2 => (0.0, 1.0, x),
        3 => (0.0, x, 1.0),
        4 => (x, 0.0, 1.0),
        _ => (1.0, 0.0, x),
    };
    let s = w.sat / 100.0;
    [(r - 0.5) * s, (g - 0.5) * s, (b - 0.5) * s]
}

fn smooth(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// A pixel (encoded values, 0 to 1) with the colour grading applied. Each wheel adds its colour, and lifts or drops the brightness, in proportion to
/// how much of the pixel's tone belongs to its region; the brightness of the pixel is kept except for what the Luminance sliders ask for.
pub fn grade_pixel(c: [f32; 3], g: &Grading) -> [f32; 3] {
    let y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    let pivot = 0.5 + g.balance / 200.0;
    let half = 0.1 + 0.4 * (g.blending / 100.0);
    let s = smooth(pivot - half, pivot + half, y);
    let (w_sh, w_hi, w_mid) = (1.0 - s, s, 4.0 * s * (1.0 - s));
    let mut out = c;
    let mut lum = 0.0;
    for (wheel, weight) in [(&g.shadows, w_sh), (&g.midtones, w_mid), (&g.highlights, w_hi), (&g.global, 1.0)] {
        if wheel.is_zero() || weight <= 0.0 {
            continue;
        }
        let t = wheel_tint(wheel);
        for k in 0..3 {
            out[k] += t[k] * weight * 0.5;
        }
        lum += wheel.lum / 100.0 * weight * 0.25;
    }
    // the colour moves the pixel's brightness, so it is put back: what the brightness sliders ask for is added after
    let y_now = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
    let fix = y - y_now + lum;
    [(out[0] + fix).clamp(0.0, 1.0), (out[1] + fix).clamp(0.0, 1.0), (out[2] + fix).clamp(0.0, 1.0)]
}

/// The parametric tone curve: four sliders, each moving one region of the tones (-100 to 100). They work on the encoded values,
/// before the point curve, and never move black or white.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Parametric {
    pub shadows: f32,
    pub darks: f32,
    pub lights: f32,
    pub highlights: f32,
}

impl Parametric {
    pub fn is_zero(&self) -> bool {
        [self.shadows, self.darks, self.lights, self.highlights].iter().all(|v| v.abs() < 1e-4)
    }
    fn sanitized(&self) -> Parametric {
        let c = |v: f32| if v.is_finite() { v.clamp(-100.0, 100.0) } else { 0.0 };
        Parametric { shadows: c(self.shadows), darks: c(self.darks), lights: c(self.lights), highlights: c(self.highlights) }
    }
}

/// The parametric curve as a table over encoded values (index i is input i/1024). Each slider lifts or lowers a smooth bump of tones
/// (centred at an eighth, three eighths, five eighths and seven eighths of the range) by up to 15 percent of the range; the ends stay
/// where they are, and the result never goes backwards, so a tone is never inverted.
pub fn parametric_lut(p: &Parametric) -> Vec<f32> {
    let amounts = [(0.125f32, p.shadows), (0.375, p.darks), (0.625, p.lights), (0.875, p.highlights)];
    let mut out: Vec<f32> = Vec::with_capacity(1025);
    let mut top = 0.0f32;
    for i in 0..=1024usize {
        let x = i as f32 / 1024.0;
        let mut delta = 0.0f32;
        for (centre, a) in amounts {
            let u = (x - centre) / 0.25;
            if u.abs() < 1.0 {
                delta += (a / 100.0) * 0.15 * 0.5 * (1.0 + (std::f32::consts::PI * u).cos());
            }
        }
        let ends = (4.0 * x * (1.0 - x)).max(0.0).sqrt(); // 0 at black and at white
        let y = (x + delta * ends).clamp(0.0, 1.0).max(top);
        top = y;
        out.push(y);
    }
    out
}

/// A value looked up in a table over 0..1 (1025 entries), between the two nearest entries.
fn table_at(t: &[f32], v: f32) -> f32 {
    let p = v.clamp(0.0, 1.0) * 1024.0;
    let i = (p as usize).min(1023);
    let f = p - i as f32;
    t[i] * (1.0 - f) + t[i + 1] * f
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Recipe {
    /// The look the photo starts from before the sliders (see profile_look): "" is the plain one. profile_amount is 0 to 200, 100 as designed.
    pub profile: String,
    pub profile_amount: f32,
    pub temperature: f32, // -100..100, positive is warmer
    pub tint: f32,        // -100..100, positive is more magenta
    pub exposure: f32,    // -5..5 stops
    pub contrast: f32,    // -100..100 from here down
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub vibrance: f32,
    pub saturation: f32,
    /// The Presence sliders, -100..100: fine detail, medium detail, and haze (see `presence.rs`).
    pub texture: f32,
    pub clarity: f32,
    pub dehaze: f32,
    /// Tone curve control points as [input, output], both 0 to 255, sorted by input. The ends
    /// (0,0) and (255,255) are implied. Empty means a straight line.
    pub curve: Vec<[f32; 2]>,
    /// The same kind of curve for one colour channel alone, applied after the combined curve and the parametric one.
    pub curve_red: Vec<[f32; 2]>,
    pub curve_green: Vec<[f32; 2]>,
    pub curve_blue: Vec<[f32; 2]>,
    pub parametric: Parametric,
    /// Colour grading: three wheels and a global one, applied after the colour mixer.
    pub grading: Grading,
    /// Calibration: how the three primary colours are rendered, applied first, to the light before any tone work.
    pub calibration: Calibration,
    pub hsl: Hsl,
    pub detail: Detail,
    pub effects: Effects,
    /// Local adjustments, each limited to a shape. Positions are fractions of the cropped picture.
    pub masks: Vec<Mask>,
    /// Spot removal, applied first, on the cropped picture. Positions are fractions of it.
    pub spots: Vec<Spot>,
    /// Red-eye circles, applied right after the spots. Positions are fractions of the cropped picture.
    pub red_eyes: Vec<RedEye>,
    /// Portrait retouching (skin, teeth, eyes), one entry per face the person marked or the detector found. A recipe
    /// saved with a single `portrait` still loads, as a list of one.
    #[serde(alias = "portrait", deserialize_with = "portraits_compat")]
    pub portraits: Vec<Portrait>,
    /// Lens corrections and transform, applied before the crop.
    pub geometry: Geometry,
    pub crop: Crop,
}

impl Default for Recipe {
    fn default() -> Self {
        Recipe {
            profile: String::new(),
            profile_amount: 100.0,
            temperature: 0.0,
            tint: 0.0,
            exposure: 0.0,
            contrast: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
            vibrance: 0.0,
            saturation: 0.0,
            texture: 0.0,
            clarity: 0.0,
            dehaze: 0.0,
            curve: Vec::new(),
            curve_red: Vec::new(),
            curve_green: Vec::new(),
            curve_blue: Vec::new(),
            parametric: Parametric::default(),
            grading: Grading::default(),
            calibration: Calibration::default(),
            hsl: Hsl::default(),
            detail: Detail::default(),
            effects: Effects::default(),
            masks: Vec::new(),
            spots: Vec::new(),
            red_eyes: Vec::new(),
            portraits: Vec::new(),
            geometry: Geometry::default(),
            crop: Crop::default(),
        }
    }
}

impl Recipe {
    /// Clamp every value to its slider range, so a bad file or a bad call cannot produce NaN or huge values.
    pub fn sanitized(&self) -> Recipe {
        let c = |v: f32, lo: f32, hi: f32| if v.is_finite() { v.clamp(lo, hi) } else { 0.0 };
        let aspect = match self.crop.aspect.as_str() {
            "1:1" | "4:3" | "3:2" | "16:9" | "5:4" | "free" => self.crop.aspect.clone(),
            // a ratio of your own, like 7:5 or 2.35:1, kept in a plain form
            other => match custom_ratio(other) {
                Some((a, b)) => format!("{}:{}", fmt_part(a), fmt_part(b)),
                None => "original".to_string(),
            },
        };
        Recipe {
            profile: if profile_look(&self.profile).is_some() { self.profile.clone() } else { String::new() },
            profile_amount: if self.profile_amount.is_finite() { self.profile_amount.clamp(0.0, 200.0) } else { 100.0 },
            temperature: c(self.temperature, -100.0, 100.0),
            tint: c(self.tint, -100.0, 100.0),
            exposure: c(self.exposure, -5.0, 5.0),
            contrast: c(self.contrast, -100.0, 100.0),
            highlights: c(self.highlights, -100.0, 100.0),
            shadows: c(self.shadows, -100.0, 100.0),
            whites: c(self.whites, -100.0, 100.0),
            blacks: c(self.blacks, -100.0, 100.0),
            vibrance: c(self.vibrance, -100.0, 100.0),
            saturation: c(self.saturation, -100.0, 100.0),
            texture: c(self.texture, -100.0, 100.0),
            clarity: c(self.clarity, -100.0, 100.0),
            dehaze: c(self.dehaze, -100.0, 100.0),
            curve: clean_points(&self.curve),
            curve_red: clean_points(&self.curve_red),
            curve_green: clean_points(&self.curve_green),
            curve_blue: clean_points(&self.curve_blue),
            parametric: self.parametric.sanitized(),
            grading: self.grading.sanitized(),
            calibration: self.calibration.sanitized(),
            hsl: self.hsl.sanitized(),
            detail: self.detail.sanitized(),
            effects: self.effects.sanitized(),
            masks: masks::sanitize_masks(&self.masks),
            spots: spots::sanitize_spots(&self.spots),
            red_eyes: redeye::sanitize_red_eyes(&self.red_eyes),
            portraits: self.portraits.iter().take(portrait::MAX_PORTRAITS).map(Portrait::sanitized).collect(),
            geometry: self.geometry.sanitized(),
            crop: Crop { aspect, angle: c(self.crop.angle, -45.0, 45.0), rect: self.crop.rect.and_then(CropRect::sanitized) },
        }
    }

    pub fn has_tone_edits(&self) -> bool {
        let z = |v: f32| v.abs() < 1e-4;
        !(z(self.temperature)
            && z(self.tint)
            && z(self.exposure)
            && z(self.contrast)
            && z(self.highlights)
            && z(self.shadows)
            && z(self.whites)
            && z(self.blacks)
            && z(self.vibrance)
            && z(self.saturation)
            && curve_lut(&self.curve).is_none()
            && curve_lut(&self.curve_red).is_none()
            && curve_lut(&self.curve_green).is_none()
            && curve_lut(&self.curve_blue).is_none()
            && self.parametric.is_zero()
            && self.grading.is_zero()
            && self.calibration.is_zero()
            && self.hsl.is_zero()
            && !self.has_profile())
    }

    /// A profile other than the plain one is in use (at an amount that does something).
    pub fn has_profile(&self) -> bool {
        profile_look(&self.profile).is_some() && self.profile_amount.abs() > 1e-4
    }

    pub fn has_masks(&self) -> bool {
        !self.masks.is_empty()
    }

    pub fn has_crop(&self) -> bool {
        self.crop.rect.is_some() || self.crop.angle.abs() > 1e-4 || !matches!(self.crop.aspect.as_str(), "original" | "free")
    }
}

// ---- tone ---------------------------------------------------------------------------

fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn linear_to_srgb(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.003_130_8 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

/// The tone curve on encoded values (0..1). Pure, so it can be tested on its own.
pub fn tone_curve(x: f32, r: &Recipe) -> f32 {
    let x = x.clamp(0.0, 1.0);
    let mut y = x;
    // blacks and whites move the two ends; shadows peak near a sixth and highlights near five sixths of the range. The bumps are narrow
    // (14.9 scales each to 1) so pulling highlights down does not darken the midtones, which would read as lower exposure.
    y += (r.blacks / 100.0) * 0.18 * (1.0 - x).powi(4);
    y += (r.whites / 100.0) * 0.18 * x.powi(4);
    y += (r.shadows / 100.0) * 0.30 * 14.9 * x * (1.0 - x).powi(5);
    y += (r.highlights / 100.0) * 0.30 * 14.9 * x.powi(5) * (1.0 - x);
    let y = y.clamp(0.0, 1.0);
    let c = r.contrast / 100.0;
    let s = y * y * (3.0 - 2.0 * y);
    (y + (s - y) * c).clamp(0.0, 1.0)
}

// ---- tone curve (control points) ---------------------------------------------------------

pub const MAX_CURVE_POINTS: usize = 16;

/// Keep the points a curve can use: finite, in range, sorted, one per input value (a gap of at
/// least 1), at most MAX_CURVE_POINTS. A point sitting exactly on the straight line is kept; the
/// curve is only "off" when every point is.
pub fn clean_points(points: &[[f32; 2]]) -> Vec<[f32; 2]> {
    let mut pts: Vec<[f32; 2]> = points
        .iter()
        .filter(|p| p[0].is_finite() && p[1].is_finite())
        .map(|p| [p[0].clamp(0.0, 255.0), p[1].clamp(0.0, 255.0)])
        .collect();
    pts.sort_by(|a, b| a[0].total_cmp(&b[0]));
    let mut out: Vec<[f32; 2]> = Vec::new();
    for p in pts {
        if out.last().map_or(true, |l| p[0] - l[0] >= 1.0) {
            out.push(p);
        }
    }
    out.truncate(MAX_CURVE_POINTS);
    out
}

/// The curve as a table over encoded values: index i is input i/1024, value is the output, both
/// 0..1. None when the curve does nothing. A monotone cubic (Fritsch-Carlson) passes through the
/// points without overshooting between them, so a curve never inverts a tone.
pub fn curve_lut(points: &[[f32; 2]]) -> Option<Vec<f32>> {
    let pts = clean_points(points);
    if pts.iter().all(|p| (p[0] - p[1]).abs() < 0.5) {
        return None;
    }
    let mut xs: Vec<f32> = vec![];
    let mut ys: Vec<f32> = vec![];
    if pts.first().map_or(true, |p| p[0] > 0.0) {
        xs.push(0.0);
        ys.push(0.0);
    }
    for p in &pts {
        xs.push(p[0] / 255.0);
        ys.push(p[1] / 255.0);
    }
    if pts.last().map_or(true, |p| p[0] < 255.0) {
        xs.push(1.0);
        ys.push(1.0);
    }
    let n = xs.len();
    let d: Vec<f32> = (0..n - 1).map(|k| (ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k])).collect();
    let mut m = vec![0.0f32; n];
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for k in 1..n - 1 {
        m[k] = if d[k - 1] * d[k] <= 0.0 { 0.0 } else { (d[k - 1] + d[k]) / 2.0 };
    }
    for k in 0..n - 1 {
        if d[k].abs() < 1e-9 {
            m[k] = 0.0;
            m[k + 1] = 0.0;
        } else {
            let (a, b) = (m[k] / d[k], m[k + 1] / d[k]);
            let h = (a * a + b * b).sqrt();
            if h > 3.0 {
                m[k] = 3.0 * a / h * d[k];
                m[k + 1] = 3.0 * b / h * d[k];
            }
        }
    }
    const N: usize = 1024;
    let mut seg = 0;
    Some(
        (0..=N)
            .map(|i| {
                let x = i as f32 / N as f32;
                while seg < n - 2 && x > xs[seg + 1] {
                    seg += 1;
                }
                let h = xs[seg + 1] - xs[seg];
                let t = ((x - xs[seg]) / h).clamp(0.0, 1.0);
                let (t2, t3) = (t * t, t * t * t);
                let y = (2.0 * t3 - 3.0 * t2 + 1.0) * ys[seg]
                    + (t3 - 2.0 * t2 + t) * h * m[seg]
                    + (-2.0 * t3 + 3.0 * t2) * ys[seg + 1]
                    + (t3 - t2) * h * m[seg + 1];
                y.clamp(0.0, 1.0)
            })
            .collect(),
    )
}

// ---- colour mixer -----------------------------------------------------------------------

/// Hue (degrees) at the middle of each band.
const BAND_CENTRES: [f32; 8] = [0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 275.0, 320.0];

pub(crate) fn rgb_to_hsl(c: [f32; 3]) -> (f32, f32, f32) {
    let (mx, mn) = (c[0].max(c[1]).max(c[2]), c[0].min(c[1]).min(c[2]));
    let l = (mx + mn) / 2.0;
    let d = mx - mn;
    if d < 1e-6 {
        return (0.0, 0.0, l);
    }
    let s = d / (1.0 - (2.0 * l - 1.0).abs()).max(1e-6);
    let h = if mx == c[0] {
        ((c[1] - c[2]) / d).rem_euclid(6.0)
    } else if mx == c[1] {
        (c[2] - c[0]) / d + 2.0
    } else {
        (c[0] - c[1]) / d + 4.0
    };
    (h * 60.0, s.min(1.0), l)
}

fn hsl_to_rgb(h: f32, s: f32, l: f32) -> [f32; 3] {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = h.rem_euclid(360.0) / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    [r + m, g + m, b + m]
}

/// The two bands that share a hue and how much the second owns (0..1). The first owns the rest.
fn band_pair(h: f32) -> (usize, usize, f32) {
    let h = h.rem_euclid(360.0);
    for i in 0..8 {
        let a = BAND_CENTRES[i];
        let (b, next) = if i == 7 { (360.0, 0) } else { (BAND_CENTRES[i + 1], i + 1) };
        if h >= a && h < b {
            return (i, next, (h - a) / (b - a));
        }
    }
    (0, 1, 0.0)
}

/// How much each band owns a hue, for all eight bands.
#[cfg(test)]
fn band_weights(h: f32) -> [f32; 8] {
    let (i, next, t) = band_pair(h);
    let mut w = [0.0f32; 8];
    w[i] = 1.0 - t;
    w[next] += t;
    w
}

/// Apply the colour mixer to one pixel (encoded values 0..1). Neutral greys are not touched, and
/// neither is any colour whose two bands have no adjustment, which is most pixels of most edits.
fn hsl_adjust(c: [f32; 3], m: &Hsl) -> [f32; 3] {
    let (h, s, l) = rgb_to_hsl(c);
    if s < 1e-4 {
        return c;
    }
    let (i, j, t) = band_pair(h);
    let (u, v) = (1.0 - t, t);
    let dh = u * m.hue[i] + v * m.hue[j];
    let ds = u * m.sat[i] + v * m.sat[j];
    let dl = u * m.lum[i] + v * m.lum[j];
    if dh == 0.0 && ds == 0.0 && dl == 0.0 {
        return c;
    }
    let s2 = (s * (1.0 + ds / 100.0)).clamp(0.0, 1.0);
    // luminance moves colours more the more saturated they are, so a nearly grey pixel stays put
    let l2 = (l + dl / 100.0 * 0.25 * s.min(1.0)).clamp(0.0, 1.0);
    let out = hsl_to_rgb(h + dh / 100.0 * 30.0, s2, l2);
    [out[0].clamp(0.0, 1.0), out[1].clamp(0.0, 1.0), out[2].clamp(0.0, 1.0)]
}

/// Run `f(first_row, band)` over horizontal bands of `dst`, one thread per core.
pub(crate) fn par_bands<T: Send>(dst: &mut [T], row_bytes: usize, f: impl Fn(usize, &mut [T]) + Sync) {
    let rows = dst.len() / row_bytes.max(1);
    let threads = crate::perf::threads(false);
    if rows < 64 || threads == 1 {
        return f(0, dst);
    }
    let band = rows.div_ceil(threads);
    std::thread::scope(|s| {
        for (i, chunk) in dst.chunks_mut(band * row_bytes).enumerate() {
            let f = &f;
            s.spawn(move || f(i * band, chunk));
        }
    });
}

// ---- profiles --------------------------------------------------------------------------------

/// A profile is a look the picture starts from: how strongly colours are shown, how contrasty the tones are, a lean towards warm or cool, and
/// whether it is black and white. It is applied after the tone curves and before the saturation sliders, so the sliders still work on top.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProfileLook {
    pub saturation: f32,
    /// -1 to 1: a flatter or a more contrasty S-shaped curve
    pub contrast: f32,
    /// multipliers of red, green and blue
    pub lean: [f32; 3],
    /// 1: black and white
    pub mono: f32,
}

/// The ids the page offers (`""` is the plain profile and has no look of its own).
pub const PROFILES: [&str; 6] = ["vivid", "landscape", "portrait", "neutral", "flat", "monochrome"];

pub fn profile_look(id: &str) -> Option<ProfileLook> {
    Some(match id {
        "vivid" => ProfileLook { saturation: 1.28, contrast: 0.22, lean: [1.0, 1.0, 1.0], mono: 0.0 },
        "landscape" => ProfileLook { saturation: 1.15, contrast: 0.18, lean: [0.99, 1.01, 1.03], mono: 0.0 },
        "portrait" => ProfileLook { saturation: 0.9, contrast: -0.08, lean: [1.025, 1.0, 0.975], mono: 0.0 },
        "neutral" => ProfileLook { saturation: 0.88, contrast: -0.18, lean: [1.0, 1.0, 1.0], mono: 0.0 },
        "flat" => ProfileLook { saturation: 0.8, contrast: -0.35, lean: [1.0, 1.0, 1.0], mono: 0.0 },
        "monochrome" => ProfileLook { saturation: 1.0, contrast: 0.15, lean: [1.0, 1.0, 1.0], mono: 1.0 },
        _ => return None,
    })
}

/// The look put on one pixel (values 0 to 1, as encoded), `amount` being 0 (nothing) to 2 (twice as much).
pub fn apply_profile(c: [f32; 3], p: &ProfileLook, amount: f32) -> [f32; 3] {
    let a = amount;
    let mut v = [(c[0] * (1.0 + (p.lean[0] - 1.0) * a)).clamp(0.0, 1.0), (c[1] * (1.0 + (p.lean[1] - 1.0) * a)).clamp(0.0, 1.0), (c[2] * (1.0 + (p.lean[2] - 1.0) * a)).clamp(0.0, 1.0)];
    let k = p.contrast * a;
    for x in v.iter_mut() {
        let s = *x * *x * (3.0 - 2.0 * *x);
        *x = (*x + k * (s - *x)).clamp(0.0, 1.0);
    }
    let y = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    let sat = 1.0 + (p.saturation - 1.0) * a;
    let mono = (p.mono * a).clamp(0.0, 1.0);
    // colour first (towards the grey of the same lightness), then all the way to grey for a black and white profile
    for x in v.iter_mut() {
        let coloured = y + (*x - y) * sat;
        *x = (coloured * (1.0 - mono) + y * mono).clamp(0.0, 1.0);
    }
    v
}
/// Apply white balance, exposure, tone, vibrance and saturation.
pub fn apply_tone(img: &RgbImage, recipe: &Recipe) -> RgbImage {
    let r = recipe.sanitized();
    if !r.has_tone_edits() {
        return img.clone();
    }
    // 8-bit decode table, linear light
    let lin: Vec<f32> = (0..256).map(|v| srgb_to_linear(v as f32 / 255.0)).collect();
    // encode table: linear 0..1 to sRGB. A table beats a powf per channel per pixel by a wide margin.
    const ENC_N: usize = 4096;
    let enc_lut: Vec<f32> = (0..=ENC_N).map(|i| linear_to_srgb(i as f32 / ENC_N as f32)).collect();
    let enc = |v: f32| {
        let p = v.clamp(0.0, 1.0) * ENC_N as f32;
        let i = (p as usize).min(ENC_N - 1);
        let f = p - i as f32;
        enc_lut[i] * (1.0 - f) + enc_lut[i + 1] * f
    };
    // tone curve as a table over encoded values
    const N: usize = 1024;
    let curve: Vec<f32> = (0..=N).map(|i| tone_curve(i as f32 / N as f32, &r)).collect();
    let lut = |v: f32| {
        let p = v.clamp(0.0, 1.0) * N as f32;
        let i = (p as usize).min(N - 1);
        let f = p - i as f32;
        curve[i] * (1.0 - f) + curve[i + 1] * f
    };

    let mixer = !r.hsl.is_zero();
    let grading = !r.grading.is_zero();
    let calib = (!r.calibration.is_zero()).then(|| r.calibration.matrix());
    let shadow_tint = r.calibration.shadows_tint / 100.0;
    // the curves after the tone sliders: the parametric one, then the combined point curve, then the one of each colour channel.
    // Each channel gets one table that does all of it (None when nothing applies to it).
    let user_curve = curve_lut(&r.curve);
    let param = (!r.parametric.is_zero()).then(|| parametric_lut(&r.parametric));
    let by_channel = [curve_lut(&r.curve_red), curve_lut(&r.curve_green), curve_lut(&r.curve_blue)];
    let any_curve = user_curve.is_some() || param.is_some() || by_channel.iter().any(|c| c.is_some());
    let channel_tables: [Option<Vec<f32>>; 3] = std::array::from_fn(|ch| {
        if !any_curve {
            return None;
        }
        Some(
            (0..=1024usize)
                .map(|i| {
                    let mut v = i as f32 / 1024.0;
                    if let Some(p) = &param {
                        v = table_at(p, v);
                    }
                    if let Some(c) = &user_curve {
                        v = table_at(c, v);
                    }
                    if let Some(c) = &by_channel[ch] {
                        v = table_at(c, v);
                    }
                    v
                })
                .collect(),
        )
    });
    let apply_curve = |ch: usize, v: f32| match &channel_tables[ch] {
        Some(t) => table_at(t, v),
        None => v,
    };
    let t = r.temperature / 100.0;
    let n = r.tint / 100.0;
    let (gr, gg, gb) = ((t * 0.35).exp(), (-n * 0.25).exp(), (-t * 0.35).exp());
    let ev = 2f32.powf(r.exposure);
    let sat = 1.0 + r.saturation / 100.0;
    let vib = r.vibrance / 100.0;
    let profile = if r.has_profile() { profile_look(&r.profile).map(|p| (p, r.profile_amount / 100.0)) } else { None };

    let (w, h) = (img.width() as usize, img.height() as usize);
    let src = img.as_raw();
    let mut out = vec![0u8; src.len()];
    par_bands(&mut out, w * 3, |y0, band| {
        let from = y0 * w * 3;
        for (sp, dp) in src[from..from + band.len()].chunks_exact(3).zip(band.chunks_exact_mut(3)) {
            let mut l = [lin[sp[0] as usize] * gr * ev, lin[sp[1] as usize] * gg * ev, lin[sp[2] as usize] * gb * ev];
            if let Some(m) = &calib {
                // how the camera's primaries are rendered: a matrix on the linear light, and the tint in the shadows
                let n = [m[0][0] * l[0] + m[0][1] * l[1] + m[0][2] * l[2], m[1][0] * l[0] + m[1][1] * l[1] + m[1][2] * l[2], m[2][0] * l[0] + m[2][1] * l[1] + m[2][2] * l[2]];
                let shade = (1.0 - (0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2]).clamp(0.0, 1.0)).powi(3) * shadow_tint * 0.06;
                l = [n[0] + shade * 0.5, n[1] - shade, n[2] + shade * 0.5];
            }
            let mut c = [
                apply_curve(0, lut(enc(l[0]))),
                apply_curve(1, lut(enc(l[1]))),
                apply_curve(2, lut(enc(l[2]))),
            ];
            if let Some((p, amount)) = &profile {
                c = apply_profile(c, p, *amount);
            }
            if sat != 1.0 || vib != 0.0 {
                let y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
                let mx = c[0].max(c[1]).max(c[2]);
                let mn = c[0].min(c[1]).min(c[2]);
                let chroma = if mx > 1e-5 { (mx - mn) / mx } else { 0.0 };
                // vibrance lifts muted colours more than saturated ones
                let k = sat * (1.0 + vib * (1.0 - chroma));
                for v in c.iter_mut() {
                    *v = (y + (*v - y) * k).clamp(0.0, 1.0);
                }
            }
            if mixer {
                c = hsl_adjust(c, &r.hsl);
            }
            if grading {
                c = grade_pixel(c, &r.grading);
            }
            dp[0] = (c[0] * 255.0 + 0.5) as u8;
            dp[1] = (c[1] * 255.0 + 0.5) as u8;
            dp[2] = (c[2] * 255.0 + 0.5) as u8;
        }
    });
    RgbImage::from_raw(w as u32, h as u32, out).expect("same size as the input")
}

// ---- detail: sharpening and noise reduction -----------------------------------------------

/// One horizontal box-blur pass over every row, edges repeated. `r` is the radius in pixels.
fn box_h(src: &[f32], dst: &mut [f32], w: usize, r: usize) {
    if w == 0 {
        return;
    }
    let r = r.min(w - 1);
    let inv = 1.0 / (2 * r + 1) as f32;
    par_bands(dst, w, |y0, band| {
        for (ry, out) in band.chunks_exact_mut(w).enumerate() {
            let row = &src[(y0 + ry) * w..(y0 + ry + 1) * w];
            // window for x = 0 is -r..=r with the edge pixel repeated: r copies now, row[r] is added in the loop
            let mut acc = row[0] * r as f32;
            for x in 0..r {
                acc += row[x.min(w - 1)];
            }
            for x in 0..w {
                acc += row[(x + r).min(w - 1)];
                out[x] = acc * inv;
                acc -= row[x.saturating_sub(r)];
            }
        }
    });
}

fn transpose(src: &[f32], dst: &mut [f32], w: usize, h: usize) {
    // dst is h wide and w tall: dst[x * h + y] = src[y * w + x]. Done in small tiles so both
    // the reads and the writes stay in cache.
    const T: usize = 16;
    par_bands(dst, h, |x0, band| {
        let rows = band.len() / h;
        for yb in (0..h).step_by(T) {
            for xb in (0..rows).step_by(T) {
                for y in yb..(yb + T).min(h) {
                    for rx in xb..(xb + T).min(rows) {
                        band[rx * h + y] = src[y * w + x0 + rx];
                    }
                }
            }
        }
    });
}

/// Box sizes whose three passes approximate a Gaussian of this sigma.
fn gauss_radii(sigma: f32) -> [usize; 3] {
    let n = 3.0f32;
    let ideal = (12.0 * sigma * sigma / n + 1.0).sqrt();
    let mut wl = ideal.floor() as i32;
    if wl % 2 == 0 {
        wl -= 1;
    }
    let wl = wl.max(1);
    let wu = wl + 2;
    let m = ((12.0 * sigma * sigma - n * (wl * wl) as f32 - 4.0 * n * wl as f32 - 3.0 * n) / (-4.0 * wl as f32 - 4.0)).round() as i32;
    let size = |i: i32| if i < m { wl } else { wu };
    [((size(0) - 1) / 2) as usize, ((size(1) - 1) / 2) as usize, ((size(2) - 1) / 2) as usize]
}

/// Gaussian blur of one plane (row-major, w by h) on all cores.
pub(crate) fn blur_plane(plane: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    if sigma < 0.3 || w == 0 || h == 0 {
        return plane.to_vec();
    }
    let radii = gauss_radii(sigma);
    let mut a = plane.to_vec();
    let mut b = vec![0.0; plane.len()];
    for &r in &radii {
        box_h(&a, &mut b, w, r);
        std::mem::swap(&mut a, &mut b);
    }
    transpose(&a, &mut b, w, h); // now h wide, w tall
    for &r in &radii {
        box_h(&b, &mut a, h, r);
        std::mem::swap(&mut a, &mut b);
    }
    transpose(&b, &mut a, h, w);
    a
}

const MIN_SIGMA: f32 = 0.6;

/// Sharpen (unsharp mask on brightness) and reduce noise. The radii are for a 2048 px wide
/// picture and scale with the real size, so the preview and a full-size export look alike.
pub fn apply_detail(img: &RgbImage, detail: &Detail) -> RgbImage {
    apply_detail_scaled(img, detail, img.width().max(img.height()) as f32 / 2048.0)
}

/// Same, with the size the radii are scaled by given explicitly. A piece cut out of a big picture
/// has to use the size of the whole picture, or its sharpening would differ from the export.
pub fn apply_detail_scaled(img: &RgbImage, detail: &Detail, scale: f32) -> RgbImage {
    let d = detail.sanitized();
    if d.is_off() {
        return img.clone();
    }
    let (w, h) = (img.width() as usize, img.height() as usize);
    // below about 0.6 the box passes round down to no blur at all, and the effect would silently vanish
    let sigma = |s: f32| (s * scale).max(MIN_SIGMA);
    let src = img.as_raw();
    // split into brightness (y) and two colour-difference planes
    let n = w * h;
    let (mut y, mut cb, mut cr) = (vec![0.0f32; n], vec![0.0f32; n], vec![0.0f32; n]);
    let luma = |p: &[u8]| 0.2126 * p[0] as f32 / 255.0 + 0.7152 * p[1] as f32 / 255.0 + 0.0722 * p[2] as f32 / 255.0;
    par_bands(&mut y, w, |row0, band| {
        for (j, v) in band.iter_mut().enumerate() {
            *v = luma(&src[(row0 * w + j) * 3..]);
        }
    });
    par_bands(&mut cb, w, |row0, band| {
        for (j, v) in band.iter_mut().enumerate() {
            let i = (row0 * w + j) * 3;
            *v = src[i + 2] as f32 / 255.0 - luma(&src[i..]);
        }
    });
    par_bands(&mut cr, w, |row0, band| {
        for (j, v) in band.iter_mut().enumerate() {
            let i = (row0 * w + j) * 3;
            *v = src[i] as f32 / 255.0 - luma(&src[i..]);
        }
    });

    if d.nr_colour >= 0.5 {
        // 50 is the plain setting; less smooths over a smaller area, more over a larger one
        let sg = sigma((0.5 + d.nr_colour / 100.0 * 5.0) * (0.5 + d.nr_colour_smooth / 100.0));
        cb = blur_plane(&cb, w, h, sg);
        cr = blur_plane(&cr, w, h, sg);
    }
    if d.nr_luma >= 0.5 {
        let k = d.nr_luma / 100.0;
        let soft = blur_plane(&y, w, h, sigma(0.8 + k * 1.2));
        // small differences are noise and are smoothed; big ones are edges and are kept
        // detail 50 and contrast 0 are the plain setting; more detail or contrast keeps more of the edges and the texture
        let keep_more = (1.5 - d.nr_luma_detail / 100.0) * (1.0 - 0.5 * d.nr_luma_contrast / 100.0);
        let tolerance = (0.01 + 0.07 * k) * keep_more;
        par_bands(&mut y, w, |row0, band| {
            for (j, v) in band.iter_mut().enumerate() {
                let sv = soft[row0 * w + j];
                let diff = (*v - sv).abs() / tolerance;
                let keep = 1.0 / (1.0 + diff * diff);
                *v += (sv - *v) * k * keep;
            }
        });
    }
    if d.sharp_amount >= 0.5 {
        let amount = d.sharp_amount / 100.0;
        let soft = blur_plane(&y, w, h, sigma(d.sharp_radius));
        // detail: the same sharpening, but at the finest scale too, so texture is lifted and not only edges
        let fine = if d.sharp_detail >= 0.5 { Some(blur_plane(&y, w, h, sigma(0.6))) } else { None };
        let mix = d.sharp_detail / 100.0;
        let thr = d.sharp_masking / 100.0 * 0.05;
        par_bands(&mut y, w, |row0, band| {
            for (j, v) in band.iter_mut().enumerate() {
                let i = row0 * w + j;
                let mut diff = *v - soft[i];
                if let Some(f) = &fine {
                    diff = diff * (1.0 - mix) + (*v - f[i]) * mix;
                }
                // masking: leave flat areas (small differences) alone so grain is not boosted
                let mask = if thr > 0.0 { ((diff.abs() - thr * 0.5) / thr).clamp(0.0, 1.0) } else { 1.0 };
                *v = (*v + diff * amount * mask).clamp(0.0, 1.0);
            }
        });
    }

    let mut out = vec![0u8; src.len()];
    par_bands(&mut out, w * 3, |row0, band| {
        for (ry, row) in band.chunks_exact_mut(w * 3).enumerate() {
            let base = (row0 + ry) * w;
            for x in 0..w {
                let i = base + x;
                // the change in brightness is added to every channel, so colour is untouched by sharpening
                let l = y[i];
                let (r, b) = (cr[i] + l, cb[i] + l);
                let g = (l - 0.2126 * r - 0.0722 * b) / 0.7152;
                row[x * 3] = (r.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                row[x * 3 + 1] = (g.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                row[x * 3 + 2] = (b.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
        }
    });
    RgbImage::from_raw(w as u32, h as u32, out).expect("same size as the input")
}

// ---- effects: vignette and grain -------------------------------------------------------

pub(crate) fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0).max(1e-6)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// A repeatable pseudo-random number in -1..1 for a grid point.
fn hash2(x: i32, y: i32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x85eb_ca6b) ^ (y as u32).wrapping_mul(0xc2b2_ae35) ^ 0x27d4_eb2f;
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b_3c6d);
    h ^= h >> 12;
    h = h.wrapping_mul(0x297a_2d39);
    h ^= h >> 15;
    (h & 0xffff) as f32 / 32767.5 - 1.0
}

/// Grain at a pixel of the full picture: smooth noise on a grid whose cells are `cell` pixels, mixed with
/// per-pixel noise by `rough` (0..1). It depends only on the position, so a window of the picture gets the
/// same grain as the whole.
fn grain_at(x: u32, y: u32, cell: f32, rough: f32) -> f32 {
    let (u, v) = (x as f32 / cell, y as f32 / cell);
    let (i, j) = (u.floor() as i32, v.floor() as i32);
    let (fu, fv) = (u - u.floor(), v - v.floor());
    let (su, sv) = (fu * fu * (3.0 - 2.0 * fu), fv * fv * (3.0 - 2.0 * fv));
    let top = hash2(i, j) * (1.0 - su) + hash2(i + 1, j) * su;
    let bottom = hash2(i, j + 1) * (1.0 - su) + hash2(i + 1, j + 1) * su;
    let smooth = top * (1.0 - sv) + bottom * sv;
    let fine = hash2(x as i32 ^ 0x5bd1, y as i32 ^ 0x1e35);
    let mix = rough * 0.6;
    smooth * (1.0 - mix) + fine * mix
}

/// Vignette and grain for the part of the picture that starts at (ox, oy) of a picture fw by fh.
pub fn apply_effects(img: &RgbImage, effects: &Effects, ox: u32, oy: u32, fw: u32, fh: u32) -> RgbImage {
    let e = effects.sanitized();
    if e.is_off() {
        return img.clone();
    }
    let (w, h) = (img.width() as usize, img.height() as usize);
    let scale = fw.max(fh) as f32 / 2048.0;
    let (cx, cy) = (fw as f32 / 2.0, fh as f32 / 2.0);
    let diag = (cx * cx + cy * cy).sqrt().max(1.0);
    let round = e.vignette_roundness / 100.0;
    let inner = 0.05 + e.vignette_midpoint / 100.0 * 0.85;
    let outer = inner + 0.1 + e.vignette_feather / 100.0 * 0.9;
    let va = e.vignette_amount / 100.0;
    let cell = ((0.6 + e.grain_size / 100.0 * 3.0) * scale).max(1.0);
    let rough = e.grain_roughness / 100.0;
    let ga = e.grain_amount / 100.0 * 0.18;
    let src = img.as_raw();
    let mut out = vec![0u8; src.len()];
    par_bands(&mut out, w * 3, |row0, band| {
        for (ry, row) in band.chunks_exact_mut(w * 3).enumerate() {
            let gy = oy + (row0 + ry) as u32;
            let dy = gy as f32 + 0.5 - cy;
            for x in 0..w {
                let gx = ox + x as u32;
                let dx = gx as f32 + 0.5 - cx;
                let i = ((row0 + ry) * w + x) * 3;
                let mut c = [src[i] as f32 / 255.0, src[i + 1] as f32 / 255.0, src[i + 2] as f32 / 255.0];
                if va != 0.0 {
                    // 0 follows the picture's own shape, 1 is a circle; both reach 1 at the corners
                    let ellipse = ((dx / cx).powi(2) + (dy / cy).powi(2)).sqrt() / std::f32::consts::SQRT_2;
                    let circle = (dx * dx + dy * dy).sqrt() / diag;
                    let t = smoothstep(inner, outer, ellipse * (1.0 - round) + circle * round);
                    for v in c.iter_mut() {
                        *v = if va < 0.0 { *v * (1.0 - t * -va) } else { *v + (1.0 - *v) * t * va };
                    }
                }
                if ga > 0.0 {
                    let l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
                    let mid = 0.35 + 0.65 * 4.0 * l * (1.0 - l); // film grain shows most in the midtones
                    let n = grain_at(gx, gy, cell, rough) * ga * mid;
                    for v in c.iter_mut() {
                        *v += n;
                    }
                }
                for k in 0..3 {
                    row[x * 3 + k] = (c[k].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                }
            }
        }
    });
    RgbImage::from_raw(w as u32, h as u32, out).expect("same size as the input")
}

// ---- auto tone and auto white balance ---------------------------------------------------

/// What "Auto" suggests for a picture. The white balance and the tone sliders are separate so the page
/// can apply either.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSettings {
    pub temperature: f32,
    pub tint: f32,
    pub exposure: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub vibrance: f32,
    pub saturation: f32,
}

pub fn auto_settings(img: &RgbImage) -> AutoSettings {
    let n = (img.width() as usize) * (img.height() as usize);
    if n == 0 {
        return AutoSettings::default();
    }
    // look at about 100 000 pixels, spread evenly
    let step = (n / 100_000).max(1);
    let mut hist = [0u32; 256];
    let mut sum_luma = 0f64;
    let (mut sum, mut count) = ([0.0f64; 3], 0u32);
    let (mut all, mut all_count) = ([0.0f64; 3], 0u32);
    let mut lin = [0.0f32; 256];
    for (v, l) in lin.iter_mut().enumerate() {
        *l = srgb_to_linear(v as f32 / 255.0);
    }
    for p in img.as_raw().chunks_exact(3).step_by(step) {
        let luma = (0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32).round().clamp(0.0, 255.0) as usize;
        hist[luma] += 1;
        sum_luma += luma as f64;
        let (mx, mn) = (p[0].max(p[1]).max(p[2]) as f32, p[0].min(p[1]).min(p[2]) as f32);
        let rgb = [lin[p[0] as usize] as f64, lin[p[1] as usize] as f64, lin[p[2] as usize] as f64];
        for k in 0..3 {
            all[k] += rgb[k];
        }
        all_count += 1;
        // the white balance is read from the nearly neutral, mid-brightness pixels
        let (sat, l) = (if mx > 0.0 { (mx - mn) / mx } else { 0.0 }, luma as f32 / 255.0);
        if sat < 0.35 && (0.15..0.85).contains(&l) {
            for k in 0..3 {
                sum[k] += rgb[k];
            }
            count += 1;
        }
    }
    let total: u32 = hist.iter().sum();
    let percentile = |q: f32| {
        let target = (total as f32 * q) as u32;
        let mut acc = 0;
        for (v, h) in hist.iter().enumerate() {
            acc += h;
            if acc > target {
                return v as f32 / 255.0;
            }
        }
        1.0
    };
    let (p005, p05, p50, p95, p995) = (percentile(0.005), percentile(0.05), percentile(0.5), percentile(0.95), percentile(0.995));
    let blown = hist[253..].iter().sum::<u32>() as f32 / total.max(1) as f32;
    let crushed = hist[..=2].iter().sum::<u32>() as f32 / total.max(1) as f32;

    // Auto tone follows what Lightroom Classic's Auto does. That was measured on 30 Canon photographs that Lightroom had run Auto on
    // (research/lightroom-auto.md): it is nearly the same recipe on every photograph (contrast +6, highlights -63, shadows +44, whites +8,
    // blacks -20, vibrance +15, the spread between photographs being small) and only the exposure follows the picture, mainly how
    // light it is overall. Nothing else about a picture predicted the other numbers better than their average did, so the average is used.
    let _ = (p05, p50, p95, blown, crushed);
    let mean = (sum_luma / total.max(1) as f64).max(8.0) as f32;
    let mut exposure = (4.84 - 1.05 * mean.ln()).clamp(-1.5, 1.5);
    // clipped whites (a window, the sky): darkening only turns them a flat grey, so leave them to the Highlights slider
    if p995 > 0.97 {
        exposure = exposure.max(-0.15);
    }
    let top = linear_to_srgb(srgb_to_linear(p995) * 2f32.powf(exposure));
    let mut a = AutoSettings {
        exposure: (exposure * 20.0).round() / 20.0,
        // Lifting shadows and pulling highlights alone leaves a flat, hazy picture, so contrast and vibrance are added, and the
        // blacks and whites follow where the picture actually starts and ends so it uses its whole range
        contrast: 12.0,
        highlights: (-25.0 - blown * 100.0).clamp(-35.0, -25.0).round(),
        shadows: 10.0,
        whites: ((0.97 - top) * 300.0).clamp(0.0, 40.0).round(),
        blacks: (-5.0 - (p005 - 0.015) * 400.0).clamp(-50.0, -5.0).round(),
        vibrance: 20.0,
        saturation: 4.0,
        ..Default::default()
    };
    let (m, c) = if count as f64 > all_count as f64 * 0.01 { (sum, count) } else { (all, all_count) };
    if c > 0 {
        let (r, g, b) = (m[0] / c as f64, m[1] / c as f64, m[2] / c as f64);
        if r > 1e-6 && g > 1e-6 && b > 1e-6 {
            // the sliders scale red and blue by exp(+-0.35 t) and green by exp(-0.25 n): solve for a neutral average
            let t = (b / r).ln() / 0.7;
            let tint = 4.0 * (g / (r * b).sqrt()).ln();
            // Lightroom leaves the camera's white balance alone on almost every photograph (29 of the 30 measured), because averaging a
            // scene to grey also removes the colour of the light and of the subject. So this only takes part of the way to neutral, a small
            // step either way, and nothing at all for a cast too small to see.
            let clean = |v: f64, limit: f64| if v.abs() < 4.0 { 0.0 } else { (v * 0.4).clamp(-limit, limit).round() };
            a.temperature = clean(t * 100.0, 30.0) as f32;
            a.tint = clean(tint * 100.0, 15.0) as f32;
        }
    }
    a
}

// ---- crop and straighten --------------------------------------------------------------

/// A ratio typed as two numbers with a colon, "7:5" or "2.35:1": both from 0.1 to 100. Anything else is not a ratio.
pub fn custom_ratio(s: &str) -> Option<(f32, f32)> {
    let (a, b) = s.split_once(':')?;
    let ok = |t: &str| t.len() <= 7 && !t.is_empty() && t.chars().all(|c| c.is_ascii_digit() || c == '.') && t.matches('.').count() <= 1;
    if !ok(a) || !ok(b) {
        return None;
    }
    let (a, b) = (a.parse::<f32>().ok()?, b.parse::<f32>().ok()?);
    ((0.1..=100.0).contains(&a) && (0.1..=100.0).contains(&b)).then_some((a, b))
}

/// A number without a pointless ".0" or a long tail: 7, 2.35.
fn fmt_part(v: f32) -> String {
    let r = (v * 100.0).round() / 100.0;
    if (r - r.round()).abs() < 1e-6 {
        format!("{}", r.round() as i64)
    } else {
        format!("{r}")
    }
}

fn aspect_value(aspect: &str, w: u32, h: u32) -> f32 {
    let (a, b) = match aspect {
        "1:1" => (1.0, 1.0),
        "4:3" => (4.0, 3.0),
        "3:2" => (3.0, 2.0),
        "16:9" => (16.0, 9.0),
        "5:4" => (5.0, 4.0),
        other => match custom_ratio(other) {
            Some(ab) => ab,
            None => return w as f32 / h as f32,
        },
    };
    // keep the orientation of the photo: a portrait photo gets a portrait frame
    let r = a / b;
    if h > w && aspect != "1:1" {
        1.0 / r
    } else {
        r
    }
}

/// Crop to the aspect ratio (centred) and straighten by the angle, keeping the biggest
/// frame that has no empty corners. Returns the input unchanged when there is nothing to do.
/// The size in pixels that apply_crop would give a picture of w x h, worked out without cutting anything.
pub fn crop_size(w: u32, h: u32, crop: &Crop) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (w, h);
    }
    let angle = if crop.angle.is_finite() { crop.angle.clamp(-45.0, 45.0) } else { 0.0 };
    let (fw, fh) = (w as f32, h as f32);
    if let Some(rect) = crop.rect.and_then(CropRect::sanitized) {
        let f = fit_crop_rect(rect, angle, fw, fh);
        return (((f.w * fw).round() as u32).max(1), ((f.h * fh).round() as u32).max(1));
    }
    if matches!(crop.aspect.as_str(), "original" | "free") && angle.abs() < 1e-4 {
        return (w, h);
    }
    let r = aspect_value(&crop.aspect, w, h);
    let th = angle.to_radians();
    let (c, s) = (th.cos().abs(), th.sin().abs());
    let b = ((fw / 2.0) / (r * c + s)).min((fh / 2.0) / (r * s + c));
    let a = r * b;
    (((2.0 * a).floor() as u32).max(1), ((2.0 * b).floor() as u32).max(1))
}

pub fn apply_crop(img: &RgbImage, crop: &Crop) -> RgbImage {
    let angle = if crop.angle.is_finite() { crop.angle.clamp(-45.0, 45.0) } else { 0.0 };
    let (w, h) = (img.width() as f32, img.height() as f32);
    let r = aspect_value(&crop.aspect, img.width(), img.height());
    let th = angle.to_radians();
    let (ow, oh, cx, cy);
    if let Some(rect) = crop.rect.and_then(CropRect::sanitized) {
        // a frame placed by hand
        let f = fit_crop_rect(rect, angle, w, h);
        ow = ((f.w * w).round() as u32).max(1);
        oh = ((f.h * h).round() as u32).max(1);
        (cx, cy) = (f.cx * w, f.cy * h);
    } else {
        if matches!(crop.aspect.as_str(), "original" | "free") && angle.abs() < 1e-4 {
            return img.clone();
        }
        let (c, s) = (th.cos().abs(), th.sin().abs());
        // frame half-height b, half-width a = r * b, inside the rotated image
        let b = ((w / 2.0) / (r * c + s)).min((h / 2.0) / (r * s + c));
        let a = r * b;
        (ow, oh) = (((2.0 * a).floor() as u32).max(1), ((2.0 * b).floor() as u32).max(1));
        (cx, cy) = (w / 2.0, h / 2.0);
    }
    let (sin, cos) = (th.sin(), th.cos());
    let row_bytes = ow as usize * 3;
    let mut out = vec![0u8; row_bytes * oh as usize];
    par_bands(&mut out, row_bytes, |y0, band| {
        for (ry, row) in band.chunks_exact_mut(row_bytes).enumerate() {
            let dy = (y0 + ry) as f32 + 0.5 - oh as f32 / 2.0;
            for x in 0..ow as usize {
                let dx = x as f32 + 0.5 - ow as f32 / 2.0;
                let sx = cx + dx * cos - dy * sin - 0.5;
                let sy = cy + dx * sin + dy * cos - 0.5;
                row[x * 3..x * 3 + 3].copy_from_slice(&bilinear(img, sx, sy).0);
            }
        }
    });
    RgbImage::from_raw(ow, oh, out).expect("same size as the frame")
}

fn bilinear(img: &RgbImage, x: f32, y: f32) -> Rgb<u8> {
    let (w, h) = (img.width() as i32, img.height() as i32);
    let (x0, y0) = (x.floor() as i32, y.floor() as i32);
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let px = |xx: i32, yy: i32| img.get_pixel(xx.clamp(0, w - 1) as u32, yy.clamp(0, h - 1) as u32).0;
    let (p00, p10, p01, p11) = (px(x0, y0), px(x0 + 1, y0), px(x0, y0 + 1), px(x0 + 1, y0 + 1));
    let mut o = [0u8; 3];
    for i in 0..3 {
        let top = p00[i] as f32 * (1.0 - fx) + p10[i] as f32 * fx;
        let bot = p01[i] as f32 * (1.0 - fx) + p11[i] as f32 * fx;
        o[i] = (top * (1.0 - fy) + bot * fy + 0.5) as u8;
    }
    Rgb(o)
}

/// The whole recipe on one image: crop first (geometry), then tone, then detail.
pub fn render(img: &RgbImage, recipe: &Recipe) -> RgbImage {
    let r = recipe.sanitized();
    let bent;
    let img: &RgbImage = if r.geometry.is_identity() {
        img
    } else {
        bent = geometry::apply_geometry(img, &r.geometry);
        &bent
    };
    let cropped;
    let base: &RgbImage = if r.has_crop() {
        cropped = apply_crop(img, &r.crop);
        &cropped
    } else {
        img
    };
    // the colour of the haze, from the whole picture, and the size the Presence sliders are scaled by
    let scale = base.width().max(base.height()) as f32 / 2048.0;
    // the colour of the haze, from the whole picture (only when Dehaze is used)
    let air = if r.dehaze.abs() > 1e-4 { presence::estimate_airlight(base) } else { [0.85; 3] };
    let spotted;
    let base: &RgbImage = if spots::any_visible(&r.spots) {
        spotted = spots::apply_spots(base, &r.spots);
        &spotted
    } else {
        base
    };
    let fixed;
    let base: &RgbImage = if redeye::any(&r.red_eyes) {
        fixed = redeye::apply_red_eyes(base, &r.red_eyes);
        &fixed
    } else {
        base
    };
    let retouched;
    let base: &RgbImage = if portrait::any(&r.portraits) {
        retouched = portrait::apply_portraits(base, &r.portraits);
        &retouched
    } else {
        base
    };
    let dehazed;
    let base: &RgbImage = if r.dehaze.abs() > 1e-4 {
        dehazed = presence::apply_dehaze(base, r.dehaze, air, scale);
        &dehazed
    } else {
        base
    };
    let toned = apply_tone(base, &r);
    let (w, h) = (toned.width(), toned.height());
    let masked = masks::apply_masks(&toned, &r.masks, 0, 0, w, h);
    let present;
    let masked: &RgbImage = if r.clarity.abs() > 1e-4 || r.texture.abs() > 1e-4 {
        present = presence::apply_clarity_texture(&masked, r.clarity, r.texture, scale);
        &present
    } else {
        &masked
    };
    let detailed = apply_detail(masked, &r.detail);
    apply_effects(&detailed, &r.effects, 0, 0, w, h)
}

/// Render only the window (x, y, w, h) of an already cropped, full-size picture. The window is clamped
/// to the picture. Detail effects look beyond the window by a margin, so the edges match what a
/// full render of the whole picture would give.
pub fn render_region(img: &RgbImage, recipe: &Recipe, x: u32, y: u32, w: u32, h: u32) -> RgbImage {
    let r = recipe.sanitized();
    let (full_w, full_h) = (img.width(), img.height());
    let w = w.clamp(1, full_w);
    let h = h.clamp(1, full_h);
    let x = x.min(full_w - w);
    let y = y.min(full_h - h);
    let scale = full_w.max(full_h) as f32 / 2048.0;
    // the sharpen and noise passes look beyond the window, so it is cut out with a margin
    let reach = if portrait::any(&r.portraits) { portrait::REACH + 2.0 } else if r.detail.is_off() && !masks::any_needs_detail(&r.masks) { 0.0 } else { 20.0 };
    // texture, clarity and dehaze look further round each pixel
    let reach = if presence::any(r.texture, r.clarity, r.dehaze) { reach.max(presence::reach(r.clarity, r.dehaze)) } else { reach };
    let air = if r.dehaze.abs() > 1e-4 { presence::estimate_airlight(img) } else { [0.85; 3] };
    let margin = (reach * scale).ceil() as u32;
    let (x0, y0) = (x.saturating_sub(margin), y.saturating_sub(margin));
    // the blocks the haze map and Clarity are worked out on start at the picture's corner, so the piece starts on a block edge too
    let (x0, y0) = if presence::any(r.texture, r.clarity, r.dehaze) {
        let g = presence::grid(scale) as u32;
        (x0 - x0 % g, y0 - y0 % g)
    } else {
        (x0, y0)
    };
    let (x1, y1) = ((x + w + margin).min(full_w), (y + h + margin).min(full_h));
    let mut padded = image::imageops::crop_imm(img, x0, y0, x1 - x0, y1 - y0).to_image();
    // spots read their source from the whole picture, so a patch copied from outside the window still works
    spots::apply_spots_window(&mut padded, x0, y0, img, &r.spots);
    redeye::apply_red_eyes_window(&mut padded, x0, y0, full_w, full_h, &r.red_eyes);
    portrait::apply_portraits_window(&mut padded, x0, y0, img, &r.portraits);
    let dehazed;
    let padded: &RgbImage = if r.dehaze.abs() > 1e-4 {
        dehazed = presence::apply_dehaze(&padded, r.dehaze, air, scale);
        &dehazed
    } else {
        &padded
    };
    let toned = apply_tone(padded, &r);
    let masked = masks::apply_masks(&toned, &r.masks, x0, y0, full_w, full_h);
    let present;
    let masked: &RgbImage = if r.clarity.abs() > 1e-4 || r.texture.abs() > 1e-4 {
        present = presence::apply_clarity_texture(&masked, r.clarity, r.texture, scale);
        &present
    } else {
        &masked
    };
    let out = apply_detail_scaled(masked, &r.detail, scale);
    let window = if margin == 0 { out } else { image::imageops::crop_imm(&out, x - x0, y - y0, w, h).to_image() };
    apply_effects(&window, &r.effects, x, y, full_w, full_h)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageBuffer;

    #[test]
    fn a_ratio_of_your_own_is_kept_in_plain_form_and_anything_else_falls_back_to_the_original() {
        let kept = |a: &str| Recipe { crop: Crop { aspect: a.into(), ..Crop::default() }, ..Recipe::default() }.sanitized().crop.aspect;
        assert_eq!(kept("7:5"), "7:5");
        assert_eq!(kept("2.35:1"), "2.35:1");
        assert_eq!(kept("7.0:5.00"), "7:5");
        for bad in ["", "7", "a:b", "0:5", "5:0", "1000:2", "7:5:3", "-3:2", "3.2.1:4", "9999999:1"] {
            assert_eq!(kept(bad), "original", "{bad}");
        }
        // the frame has the shape asked for, in the photo's own orientation
        let wide = apply_crop(&RgbImage::from_pixel(1000, 800, Rgb([100, 100, 100])), &Crop { aspect: "2:1".into(), ..Crop::default() });
        assert_eq!((wide.width(), wide.height()), (1000, 500));
        let tall = apply_crop(&RgbImage::from_pixel(800, 1000, Rgb([100, 100, 100])), &Crop { aspect: "2:1".into(), ..Crop::default() });
        assert_eq!((tall.width(), tall.height()), (500, 1000));
    }

    #[test]
    fn crop_size_is_the_size_apply_crop_gives() {
        let img = ImageBuffer::from_pixel(240, 160, image::Rgb([90u8, 100, 110]));
        let rect = |cx: f32, cy: f32, w: f32, h: f32| Some(CropRect { cx, cy, w, h });
        let crops = [
            Crop::default(),
            Crop { aspect: "1:1".into(), ..Crop::default() },
            Crop { aspect: "16:9".into(), angle: 7.5, ..Crop::default() },
            Crop { aspect: "free".into(), angle: -20.0, ..Crop::default() },
            Crop { aspect: "free".into(), rect: rect(0.5, 0.5, 0.5, 0.4), angle: 0.0 },
            Crop { aspect: "free".into(), rect: rect(0.3, 0.6, 0.31, 0.22), angle: 12.0 },
            Crop { aspect: "4:3".into(), rect: rect(0.9, 0.9, 0.5, 0.5), angle: -5.0 },
        ];
        for c in &crops {
            let out = apply_crop(&img, c);
            assert_eq!(crop_size(240, 160, c), (out.width(), out.height()), "{c:?}");
        }
        assert_eq!(crop_size(0, 0, &Crop::default()), (0, 0));
    }

    fn flat(w: u32, h: u32, v: [u8; 3]) -> RgbImage {
        ImageBuffer::from_pixel(w, h, Rgb(v))
    }

    fn ramp() -> RgbImage {
        ImageBuffer::from_fn(256, 4, |x, _| Rgb([x as u8; 3]))
    }

    #[test]
    fn a_default_recipe_changes_nothing() {
        let img = ramp();
        let out = render(&img, &Recipe::default());
        assert_eq!(out, img);
    }

    #[test]
    fn exposure_brightens_and_darkens_by_stops() {
        let mid = flat(2, 2, [100, 100, 100]);
        let up = apply_tone(&mid, &Recipe { exposure: 1.0, ..Default::default() }).get_pixel(0, 0)[0];
        let down = apply_tone(&mid, &Recipe { exposure: -1.0, ..Default::default() }).get_pixel(0, 0)[0];
        assert!(up > 100 && down < 100, "{down} < 100 < {up}");
        // +1 stop doubles linear light: sRGB 100 -> about 137
        assert!((up as i32 - 137).abs() <= 2, "got {up}");
    }

    #[test]
    fn highlights_move_bright_pixels_more_than_dark_ones() {
        let r = Recipe { highlights: -100.0, ..Default::default() };
        let dark = apply_tone(&flat(1, 1, [30, 30, 30]), &r).get_pixel(0, 0)[0] as i32;
        let bright = apply_tone(&flat(1, 1, [200, 200, 200]), &r).get_pixel(0, 0)[0] as i32;
        assert!((30 - dark).abs() <= 3, "dark barely moves: {dark}");
        assert!(200 - bright >= 10, "bright is pulled down: {bright}");
    }

    #[test]
    fn shadows_lift_dark_pixels() {
        let r = Recipe { shadows: 100.0, ..Default::default() };
        let lifted = apply_tone(&flat(1, 1, [50, 50, 50]), &r).get_pixel(0, 0)[0];
        assert!(lifted > 60, "{lifted}");
    }

    #[test]
    fn contrast_spreads_midtones_apart() {
        let r = Recipe { contrast: 100.0, ..Default::default() };
        let lo = apply_tone(&flat(1, 1, [80, 80, 80]), &r).get_pixel(0, 0)[0];
        let hi = apply_tone(&flat(1, 1, [180, 180, 180]), &r).get_pixel(0, 0)[0];
        assert!(lo < 80 && hi > 180, "{lo} {hi}");
    }

    #[test]
    fn full_desaturation_gives_grey_and_vibrance_spares_saturated_colour() {
        let grey = apply_tone(&flat(1, 1, [200, 80, 40]), &Recipe { saturation: -100.0, ..Default::default() });
        let p = grey.get_pixel(0, 0).0;
        assert!(p[0].abs_diff(p[1]) <= 1 && p[1].abs_diff(p[2]) <= 1, "{p:?}");
        let muted = [120u8, 110, 100];
        let vivid = [250u8, 20, 20];
        let spread = |c: [u8; 3]| {
            let o = apply_tone(&flat(1, 1, c), &Recipe { vibrance: 100.0, ..Default::default() }).get_pixel(0, 0).0;
            let range = |p: [u8; 3]| p.iter().max().unwrap() - p.iter().min().unwrap();
            range(o) as i32 - range(c) as i32
        };
        assert!(spread(muted) > spread(vivid), "muted colours gain more");
    }

    #[test]
    fn warmer_temperature_pushes_red_up_and_blue_down() {
        let o = apply_tone(&flat(1, 1, [128, 128, 128]), &Recipe { temperature: 60.0, ..Default::default() }).get_pixel(0, 0).0;
        assert!(o[0] > 128 && o[2] < 128, "{o:?}");
    }

    #[test]
    fn nan_and_out_of_range_values_are_clamped() {
        let r = Recipe { exposure: f32::NAN, contrast: 1e9, crop: Crop { aspect: "bogus".into(), angle: 1e9, rect: None }, ..Default::default() }.sanitized();
        assert_eq!(r.exposure, 0.0);
        assert_eq!(r.contrast, 100.0);
        assert_eq!(r.crop.aspect, "original");
        assert_eq!(r.crop.angle, 45.0);
    }

    #[test]
    fn crop_follows_the_aspect_ratio() {
        let img = flat(800, 400, [1, 2, 3]);
        let sq = apply_crop(&img, &Crop { aspect: "1:1".into(), angle: 0.0, rect: None });
        assert_eq!((sq.width(), sq.height()), (400, 400));
        let wide = apply_crop(&img, &Crop { aspect: "16:9".into(), angle: 0.0, rect: None });
        // 2:1 is wider than 16:9, so the frame keeps the full height and loses width
        assert_eq!(wide.height(), 400);
        assert!(wide.width() < 800 && (wide.width() as f32 / wide.height() as f32 - 16.0 / 9.0).abs() < 0.02);
        let portrait = apply_crop(&flat(300, 600, [0, 0, 0]), &Crop { aspect: "3:2".into(), angle: 0.0, rect: None });
        assert!(portrait.height() > portrait.width(), "a portrait photo keeps a portrait frame");
    }

    #[test]
    fn straightening_leaves_no_empty_corners() {
        let img = flat(600, 400, [200, 100, 50]);
        let out = apply_crop(&img, &Crop { aspect: "original".into(), angle: 12.0, rect: None });
        assert!(out.width() < 600 && out.height() < 400);
        assert!((out.width() as f32 / out.height() as f32 - 1.5).abs() < 0.02, "keeps the ratio");
        for (x, y) in [(0, 0), (out.width() - 1, 0), (0, out.height() - 1), (out.width() - 1, out.height() - 1)] {
            assert_eq!(out.get_pixel(x, y).0, [200, 100, 50], "corner {x},{y}");
        }
    }

    // ---- turning and mirroring in the pipeline ----

    #[test]
    fn a_quarter_turn_changes_the_size_of_the_render_and_the_crop_works_on_the_turned_picture() {
        let img: RgbImage = ImageBuffer::from_fn(300, 200, |x, y| Rgb([(x % 251) as u8, (y % 251) as u8, 40]));
        let turned = Recipe { geometry: Geometry { quarter_turns: 1, ..Default::default() }, ..Default::default() };
        let out = render(&img, &turned);
        assert_eq!((out.width(), out.height()), (200, 300));
        let square = render(&img, &Recipe { crop: Crop { aspect: "1:1".into(), angle: 0.0, rect: None }, ..turned.clone() });
        assert_eq!((square.width(), square.height()), (200, 200), "a square is as wide as the turned picture is");
        let original_ratio = render(&img, &Recipe { crop: Crop { aspect: "original".into(), angle: 3.0, rect: None }, ..turned });
        assert!(original_ratio.height() > original_ratio.width(), "still a tall picture, as the turned one is");
    }

    // ---- portrait retouching in the pipeline ----

    #[test]
    fn portrait_is_part_of_the_render_the_1_to_1_window_and_the_json() {
        use crate::portrait::{Ellipse, Portrait, Skin};
        let img: RgbImage = ImageBuffer::from_fn(500, 400, |x, y| {
            let n = (((x * 7 + y * 13) % 17) as f32 - 8.0) * 2.0;
            if (((x as f32 - 250.0) / 140.0).powi(2) + ((y as f32 - 200.0) / 170.0).powi(2)) < 1.0 { Rgb([(205.0 + n) as u8, (150.0 + n) as u8, (125.0 + n) as u8]) } else { Rgb([110, 115, 120]) }
        });
        let portrait = Portrait { face: Ellipse { cx: 0.5, cy: 0.5, rx: 0.28, ry: 0.34 }, skin: Skin { even_amount: 100.0, even_texture: 0.0, ..Default::default() }, ..Default::default() };
        let r = Recipe { exposure: 0.2, portraits: vec![portrait.clone()], ..Default::default() };
        let with = render(&img, &r);
        let without = render(&img, &Recipe { portraits: vec![], ..r.clone() });
        assert_ne!(with, without, "the skin was smoothed");
        assert_eq!(with.get_pixel(5, 5), without.get_pixel(5, 5), "the background was not");
        // marked but with every slider at 0 is the same as not marked
        let idle = Recipe { portraits: vec![Portrait::default()], ..r.clone() };
        assert_eq!(render(&img, &idle), without);
        let region = render_region(&img, &r, 150, 120, 200, 160);
        let want = image::imageops::crop_imm(&with, 150, 120, 200, 160).to_image();
        let worst = region.pixels().zip(want.pixels()).flat_map(|(a, b)| (0..3).map(move |i| (a[i] as i32 - b[i] as i32).abs())).max().unwrap();
        assert!(worst <= 2, "the 1:1 window differs from the whole by {worst}");
        let back: Recipe = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(back.portraits, r.portraits);
        let old: Recipe = serde_json::from_str(r#"{"exposure":1}"#).unwrap();
        assert!(old.portraits.is_empty());
        // a recipe saved before there could be several faces had one `portrait`; null meant none
        let single = serde_json::to_string(&portrait).unwrap();
        let one: Recipe = serde_json::from_str(&format!(r#"{{"portrait":{single}}}"#)).unwrap();
        assert_eq!(one.portraits, vec![portrait.clone()]);
        assert!(serde_json::from_str::<Recipe>(r#"{"portrait":null}"#).unwrap().portraits.is_empty());
        let two: Recipe = serde_json::from_str(&format!(r#"{{"portraits":[{single},{single}]}}"#)).unwrap();
        assert_eq!(two.portraits.len(), 2);
        // and more faces than a photo can hold are cut
        let many = Recipe { portraits: vec![portrait.clone(); 40], ..Default::default() }.sanitized();
        assert_eq!(many.portraits.len(), portrait::MAX_PORTRAITS);
    }

    #[test]
    #[ignore]
    fn portrait_speed() {
        use crate::portrait::{Ellipse, Portrait, Skin, Teeth, EyeAdjust, Eyes};
        for (w, h) in [(1100u32, 733u32), (2048, 1365)] {
            let img: RgbImage = ImageBuffer::from_fn(w, h, |x, y| {
                let n = (((x * 7 + y * 13) % 17) as f32 - 8.0) * 2.0;
                if (((x as f32 - w as f32 / 2.0) / (w as f32 * 0.17)).powi(2) + ((y as f32 - h as f32 / 2.0) / (w as f32 * 0.22)).powi(2)) < 1.0 { Rgb([(205.0 + n) as u8, (150.0 + n) as u8, (125.0 + n) as u8]) } else { Rgb([110, 115, 120]) }
            });
            let mk = |skin: Skin, teeth: Teeth, eyes: Eyes| Recipe { portraits: vec![Portrait { face: Ellipse { cx: 0.5, cy: 0.5, rx: 0.17, ry: 0.22 }, skin, teeth, eyes, ..Default::default() }], ..Default::default() };
            let all = mk(Skin { even_amount: 60.0, blemishes: 60.0, dark_circles: 50.0, contouring: 30.0, ..Default::default() }, Teeth { brightness: 40.0, desaturation: 30.0 }, Eyes { both: EyeAdjust { iris: 30.0, sclera: 30.0 }, ..Default::default() });
            let smooth = mk(Skin { even_amount: 60.0, ..Default::default() }, Teeth::default(), Eyes::default());
            let eyes = mk(Skin::default(), Teeth::default(), Eyes { both: EyeAdjust { iris: 30.0, sclera: 30.0 }, ..Default::default() });
            for (name, r) in [("everything", all), ("even skin only", smooth), ("eyes only", eyes)] {
                let mut t = Vec::new();
                for _ in 0..4 {
                    let s = std::time::Instant::now();
                    let _ = render(&img, &r);
                    t.push(s.elapsed().as_millis());
                }
                eprintln!("portrait {w}x{h} {name}: {t:?} ms");
            }
            let base = Recipe::default();
            let s = std::time::Instant::now();
            let _ = render(&img, &base);
            eprintln!("portrait {w}x{h} no portrait: {} ms", s.elapsed().as_millis());
        }
    }

    // ---- red-eye in the pipeline ----

    #[test]
    fn red_eye_is_part_of_the_render_the_1_to_1_window_and_the_json() {
        use crate::redeye::RedEye;
        let img: RgbImage = ImageBuffer::from_fn(300, 200, |x, y| if ((x as f32 - 150.0).powi(2) + (y as f32 - 90.0).powi(2)).sqrt() < 12.0 { Rgb([210, 50, 45]) } else { Rgb([205, 150, 130]) });
        let r = Recipe { exposure: 0.2, red_eyes: vec![RedEye { id: "e".into(), x: 0.5, y: 0.45, size: 0.1, darken: 0.6 }], ..Default::default() };
        let with = render(&img, &r);
        let without = render(&img, &Recipe { red_eyes: vec![], ..r.clone() });
        assert_ne!(with.get_pixel(150, 90), without.get_pixel(150, 90), "the pupil changed");
        assert_eq!(with.get_pixel(5, 5), without.get_pixel(5, 5), "the rest did not");
        // corrected before the tone work, so the pupil does not come back red when brightened
        let p = with.get_pixel(150, 90).0;
        assert!(p[0] as i32 - p[1].max(p[2]) as i32 <= 12, "still red after tone: {p:?}");
        let region = render_region(&img, &r, 110, 60, 80, 60);
        assert_eq!(region, image::imageops::crop_imm(&with, 110, 60, 80, 60).to_image());
        let back: Recipe = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(back.red_eyes, r.red_eyes);
        let old: Recipe = serde_json::from_str(r#"{"exposure":1}"#).unwrap();
        assert!(old.red_eyes.is_empty());
    }

    // ---- a crop frame placed by hand ----

    fn framed(rect: CropRect, angle: f32) -> Crop {
        Crop { aspect: "free".into(), angle, rect: Some(rect) }
    }

    #[test]
    fn a_placed_frame_cuts_exactly_that_part_of_the_picture() {
        // left half dark, right half bright: a frame over the right half is all bright, one over the left all dark
        let img: RgbImage = ImageBuffer::from_fn(400, 200, |x, _| if x < 200 { Rgb([10; 3]) } else { Rgb([240; 3]) });
        let right = apply_crop(&img, &framed(CropRect { cx: 0.75, cy: 0.5, w: 0.4, h: 0.5 }, 0.0));
        assert_eq!((right.width(), right.height()), (160, 100));
        assert!(right.pixels().all(|p| p[0] == 240));
        let left = apply_crop(&img, &framed(CropRect { cx: 0.25, cy: 0.25, w: 0.4, h: 0.5 }, 0.0));
        assert!(left.pixels().all(|p| p[0] == 10));
        // a frame the size of the picture is the picture
        assert_eq!(apply_crop(&img, &framed(CropRect { cx: 0.5, cy: 0.5, w: 1.0, h: 1.0 }, 0.0)), img);
    }

    #[test]
    fn a_frame_that_sticks_out_is_pulled_back_in_and_a_turned_one_is_shrunk() {
        let r = fit_crop_rect(CropRect { cx: 0.95, cy: 0.02, w: 0.4, h: 0.4 }, 0.0, 400.0, 200.0);
        assert!((r.w - 0.4).abs() < 1e-5 && (r.h - 0.4).abs() < 1e-5, "size kept when it fits");
        assert!((r.cx - 0.8).abs() < 1e-5 && (r.cy - 0.2).abs() < 1e-5, "moved in: {r:?}");
        // the whole picture, turned: no frame that big can fit, so it shrinks, keeping its proportions
        let big = fit_crop_rect(CropRect { cx: 0.5, cy: 0.5, w: 1.0, h: 1.0 }, 10.0, 400.0, 200.0);
        assert!(big.w < 1.0 && big.h < 1.0);
        assert!(((big.w * 400.0) / (big.h * 200.0) - 2.0).abs() < 1e-3, "same proportions");
        // every corner of the fitted frame is inside the picture
        let th = 10f32.to_radians();
        for (sx, sy) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)] {
            let (dx, dy) = (sx * big.w * 400.0 / 2.0, sy * big.h * 200.0 / 2.0);
            let (x, y) = (big.cx * 400.0 + dx * th.cos() - dy * th.sin(), big.cy * 200.0 + dx * th.sin() + dy * th.cos());
            assert!((-0.01..=400.01).contains(&x) && (-0.01..=200.01).contains(&y), "corner {x},{y}");
        }
    }

    #[test]
    fn a_placed_and_turned_frame_has_no_empty_corners_and_the_angle_still_straightens() {
        let img = flat(600, 400, [200, 100, 50]);
        let out = apply_crop(&img, &framed(CropRect { cx: 0.5, cy: 0.5, w: 0.9, h: 0.9 }, 8.0));
        for (x, y) in [(0, 0), (out.width() - 1, 0), (0, out.height() - 1), (out.width() - 1, out.height() - 1)] {
            assert_eq!(out.get_pixel(x, y).0, [200, 100, 50], "corner {x},{y}");
        }
        // a bar leaning by 8 degrees is level in a frame turned by the same angle
        let bar: RgbImage = ImageBuffer::from_fn(600, 400, |x, y| {
            let t = 8f32.to_radians().tan();
            let line = 200.0 + (x as f32 - 300.0) * t;
            if (y as f32 - line).abs() < 4.0 { Rgb([250; 3]) } else { Rgb([5; 3]) }
        });
        let level = apply_crop(&bar, &framed(CropRect { cx: 0.5, cy: 0.5, w: 0.7, h: 0.5 }, 8.0));
        let row = |x: u32| (0..level.height()).find(|y| level.get_pixel(x, *y)[0] > 128).unwrap() as i32;
        assert!((row(5) - row(level.width() - 6)).abs() <= 2, "level: {} vs {}", row(5), row(level.width() - 6));
    }

    #[test]
    fn the_frame_travels_with_the_recipe_and_old_recipes_have_none() {
        let r = Recipe { crop: framed(CropRect { cx: 0.4, cy: 0.6, w: 0.5, h: 0.3 }, 2.0), ..Default::default() };
        assert!(r.has_crop());
        let back: Recipe = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(back.crop, r.crop);
        let old: Recipe = serde_json::from_str(r#"{"crop":{"aspect":"1:1","angle":0}}"#).unwrap();
        assert_eq!(old.crop.rect, None);
        // free with no frame and no angle is no crop at all
        assert!(!Recipe { crop: Crop { aspect: "free".into(), angle: 0.0, rect: None }, ..Default::default() }.has_crop());
        // a bad frame is dropped and a huge one clamped
        let bad = Recipe { crop: framed(CropRect { cx: f32::NAN, cy: 0.5, w: 0.5, h: 0.5 }, 0.0), ..Default::default() }.sanitized();
        assert_eq!(bad.crop.rect, None);
        let big = Recipe { crop: framed(CropRect { cx: 9.0, cy: -3.0, w: 7.0, h: 0.0 }, 0.0), ..Default::default() }.sanitized();
        assert_eq!(big.crop.rect, Some(CropRect { cx: 1.0, cy: 0.0, w: 1.0, h: 0.02 }));
    }

    #[test]
    fn a_straight_curve_does_nothing_and_a_lifted_midpoint_brightens() {
        assert!(curve_lut(&[]).is_none());
        assert!(curve_lut(&[[64.0, 64.0], [192.0, 192.0]]).is_none(), "points on the line change nothing");
        assert!(!Recipe { curve: vec![[128.0, 180.0]], ..Default::default() }.sanitized().crop.angle.is_nan());
        let lifted = Recipe { curve: vec![[128.0, 180.0]], ..Default::default() };
        let out = apply_tone(&flat(1, 1, [128, 128, 128]), &lifted).get_pixel(0, 0)[0];
        assert!((out as i32 - 180).abs() <= 2, "the point is hit: {out}");
        let dark = apply_tone(&flat(1, 1, [0, 0, 0]), &lifted).get_pixel(0, 0)[0];
        let white = apply_tone(&flat(1, 1, [255, 255, 255]), &lifted).get_pixel(0, 0)[0];
        assert_eq!((dark, white), (0, 255), "the ends stay put");
    }

    #[test]
    fn a_profile_sets_the_look_the_sliders_work_on_top_of() {
        let colour = RgbImage::from_pixel(4, 4, Rgb([200, 120, 60]));
        let spread = |img: &RgbImage| {
            let p = img.get_pixel(0, 0);
            p[0].max(p[1]).max(p[2]) as i32 - p[0].min(p[1]).min(p[2]) as i32
        };
        let plain = Recipe::default();
        assert_eq!(apply_tone(&colour, &plain), colour, "no profile changes nothing");
        let vivid = apply_tone(&colour, &Recipe { profile: "vivid".into(), ..Default::default() });
        assert!(spread(&vivid) > spread(&colour), "vivid shows more colour");
        let flat = apply_tone(&colour, &Recipe { profile: "neutral".into(), ..Default::default() });
        assert!(spread(&flat) < spread(&colour), "neutral shows less");
        let mono = apply_tone(&colour, &Recipe { profile: "monochrome".into(), ..Default::default() });
        let p = mono.get_pixel(1, 1);
        assert!(p[0] == p[1] && p[1] == p[2], "black and white has no colour: {p:?}");
        // the amount scales it: none is the plain picture, double is more than one
        assert_eq!(apply_tone(&colour, &Recipe { profile: "vivid".into(), profile_amount: 0.0, ..Default::default() }), colour);
        let double = apply_tone(&colour, &Recipe { profile: "vivid".into(), profile_amount: 200.0, ..Default::default() });
        assert!(spread(&double) > spread(&vivid));
        // the sliders still work on top of a profile
        let on_top = apply_tone(&colour, &Recipe { profile: "vivid".into(), exposure: 1.0, ..Default::default() });
        assert!(on_top.get_pixel(0, 0)[0] >= vivid.get_pixel(0, 0)[0]);
        // an unknown profile is no profile, and an old recipe without the fields loads with none
        assert_eq!(Recipe { profile: "bogus".into(), ..Default::default() }.sanitized().profile, "");
        let old: Recipe = serde_json::from_str(r#"{"exposure":0.5}"#).unwrap();
        assert_eq!((old.profile.as_str(), old.profile_amount), ("", 100.0));
        assert!(!old.has_profile());
        assert!(PROFILES.iter().all(|p| profile_look(p).is_some()));
    }

    #[test]
    fn calibration_turns_a_primary_without_touching_grey_and_keeps_the_others() {
        assert!(Calibration::default().is_zero() && !Recipe::default().has_tone_edits());
        let id = Calibration::default().matrix();
        for i in 0..3 {
            for j in 0..3 {
                assert!((id[i][j] - if i == j { 1.0 } else { 0.0 }).abs() < 1e-5);
            }
        }
        // grey stays grey and keeps its brightness whatever the primaries are asked to do
        let wild = Calibration { red_hue: 80.0, red_sat: 70.0, green_hue: -60.0, green_sat: -40.0, blue_hue: 100.0, blue_sat: 90.0, shadows_tint: 0.0 };
        let m = wild.matrix();
        for grey in [0.2f32, 0.5, 0.9] {
            let out: Vec<f32> = (0..3).map(|i| m[i][0] * grey + m[i][1] * grey + m[i][2] * grey).collect();
            assert!(out.iter().all(|v| (v - grey).abs() < 1e-4), "grey {grey} became {out:?}");
        }
        // the red primary turned towards orange gains green; made less saturated, it loses its red
        let red_hue = Calibration { red_hue: 100.0, ..Default::default() }.matrix();
        let pure_red = [red_hue[0][0], red_hue[1][0], red_hue[2][0]];
        assert!(pure_red[1] > 0.1 || pure_red[2] > 0.1, "{pure_red:?}");
        let red_less = Calibration { red_sat: -100.0, ..Default::default() }.matrix();
        assert!(red_less[0][0] - red_less[1][0] < 0.8, "a primary with no saturation is less red than before: {:?}", red_less);
        // and in the picture: a red pixel shifts, a grey one does not
        let r = Recipe { calibration: Calibration { red_hue: 100.0, ..Default::default() }, ..Default::default() };
        assert!(r.has_tone_edits());
        let red = apply_tone(&flat(1, 1, [200, 40, 40]), &r).get_pixel(0, 0).0;
        assert!(red[1] > 55, "the red moved towards orange: {red:?}");
        let grey = apply_tone(&flat(1, 1, [120, 120, 120]), &r).get_pixel(0, 0).0;
        assert!(grey.iter().all(|v| (*v as i32 - 120).abs() <= 1), "{grey:?}");
        // the shadow tint colours the dark tones only
        let tint = Recipe { calibration: Calibration { shadows_tint: 100.0, ..Default::default() }, ..Default::default() };
        let dark = apply_tone(&flat(1, 1, [30, 30, 30]), &tint).get_pixel(0, 0).0;
        let light = apply_tone(&flat(1, 1, [220, 220, 220]), &tint).get_pixel(0, 0).0;
        assert!(dark[0] != dark[1], "{dark:?}");
        assert!(light.iter().all(|v| (*v as i32 - 220).abs() <= 1), "{light:?}");
        // the recipe carries it, an older one has none, and wild values are brought into range
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"calibration\"") && json.contains("\"redHue\""), "{json}");
        let old: Recipe = serde_json::from_str("{\"exposure\":0.5}").unwrap();
        assert!(old.calibration.is_zero());
        assert_eq!(Recipe { calibration: Calibration { red_hue: 1e9, blue_sat: f32::NAN, ..Default::default() }, ..Default::default() }.sanitized().calibration.red_hue, 100.0);
    }
    #[test]
    fn colour_grading_tints_its_own_region_keeps_brightness_and_leaves_the_others_alone() {
        assert!(Grading::default().is_zero() && !Recipe::default().has_tone_edits());
        let blue_shadows = Grading { shadows: Wheel { hue: 240.0, sat: 80.0, lum: 0.0 }, ..Default::default() };
        let dark = grade_pixel([0.15, 0.15, 0.15], &blue_shadows);
        let light = grade_pixel([0.85, 0.85, 0.85], &blue_shadows);
        assert!(dark[2] - dark[0] > 0.08, "the shadows go blue: {dark:?}");
        assert!((light[2] - light[0]).abs() < 0.02, "the highlights are left alone: {light:?}");
        let y = |c: [f32; 3]| 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        assert!((y(dark) - 0.15).abs() < 0.01, "the brightness is kept: {}", y(dark));
        // warm highlights, orange: red up, blue down, in the light tones only
        let warm = Grading { highlights: Wheel { hue: 40.0, sat: 80.0, lum: 0.0 }, ..Default::default() };
        let hi = grade_pixel([0.8, 0.8, 0.8], &warm);
        assert!(hi[0] > hi[2] + 0.08, "{hi:?}");
        assert!((grade_pixel([0.1, 0.1, 0.1], &warm)[0] - 0.1).abs() < 0.03);
        // the luminance sliders lift or drop their region
        let lift = Grading { midtones: Wheel { hue: 0.0, sat: 0.0, lum: 100.0 }, ..Default::default() };
        assert!(grade_pixel([0.5, 0.5, 0.5], &lift)[0] > 0.55);
        assert!((grade_pixel([0.02, 0.02, 0.02], &lift)[0] - 0.02).abs() < 0.03);
        // black stays black and white stays white under a global tint with no brightness change... within what the clamp allows
        let global = Grading { global: Wheel { hue: 120.0, sat: 50.0, lum: 0.0 }, ..Default::default() };
        let g = grade_pixel([0.5, 0.5, 0.5], &global);
        assert!(g[1] > g[0] && g[1] > g[2], "{g:?}");
        // the balance moves the boundary and the blending widens the overlap
        let by = |balance: f32| grade_pixel([0.4, 0.4, 0.4], &Grading { balance, ..blue_shadows })[2] - 0.4;
        assert!(by(80.0) > by(-80.0), "pushing the boundary up puts more of the picture in the shadows");
        // it reaches the picture, and the recipe carries it (an older recipe has none)
        let r = Recipe { grading: blue_shadows, ..Default::default() };
        assert!(r.has_tone_edits());
        let p = apply_tone(&flat(1, 1, [40, 40, 40]), &r).get_pixel(0, 0).0;
        assert!(p[2] as i32 - p[0] as i32 > 12, "{p:?}");
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"grading\"") && json.contains("\"shadows\""), "{json}");
        let old: Recipe = serde_json::from_str("{\"exposure\":0.5}").unwrap();
        assert!(old.grading.is_zero() && old.grading.blending == 50.0);
        let wild = Recipe { grading: Grading { shadows: Wheel { hue: f32::NAN, sat: 900.0, lum: -900.0 }, blending: -5.0, balance: 1e9, ..Default::default() }, ..Default::default() }.sanitized();
        assert_eq!((wild.grading.shadows.sat, wild.grading.shadows.lum, wild.grading.blending, wild.grading.balance), (100.0, -100.0, 0.0, 100.0));
    }

    #[test]
    fn the_parametric_curve_moves_its_own_region_keeps_the_ends_and_never_inverts() {
        assert!(Parametric::default().is_zero());
        assert!(!Recipe::default().has_tone_edits());
        for (name, p, x) in [
            ("shadows", Parametric { shadows: 100.0, ..Default::default() }, 0.125f32),
            ("darks", Parametric { darks: 100.0, ..Default::default() }, 0.375),
            ("lights", Parametric { lights: 100.0, ..Default::default() }, 0.625),
            ("highlights", Parametric { highlights: 100.0, ..Default::default() }, 0.875),
        ] {
            let lut = parametric_lut(&p);
            let at = |x: f32| lut[(x * 1024.0).round() as usize];
            assert!(at(x) > x + 0.03, "{name} lifts its own tones: {} for {x}", at(x));
            if x < 0.5 {
                assert!((at(x + 0.5) - (x + 0.5)).abs() < 0.12, "{name}: the far tones stay about where they were");
            }
            assert_eq!((lut[0], lut[1024]), (0.0, 1.0), "{name}: black and white stay");
            assert!(lut.windows(2).all(|w| w[1] >= w[0]), "{name}: never goes down");
        }
        // opposite neighbours at full strength still do not turn a tone round
        let hard = parametric_lut(&Parametric { shadows: 100.0, darks: -100.0, lights: 100.0, highlights: -100.0 });
        assert!(hard.windows(2).all(|w| w[1] >= w[0]));
        // it reaches the picture: lowering the lights darkens a light grey and leaves black and white alone
        let down = Recipe { parametric: Parametric { lights: -100.0, ..Default::default() }, ..Default::default() };
        let px = |v: u8| apply_tone(&flat(1, 1, [v, v, v]), &down).get_pixel(0, 0)[0];
        assert!(px(160) < 150, "{}", px(160));
        assert_eq!((px(0), px(255)), (0, 255));
    }

    #[test]
    fn a_curve_for_one_channel_changes_only_that_channel_and_the_recipe_carries_it() {
        let red_up = Recipe { curve_red: vec![[128.0, 190.0]], ..Default::default() };
        assert!(red_up.has_tone_edits());
        let p = apply_tone(&flat(1, 1, [128, 128, 128]), &red_up).get_pixel(0, 0).0;
        assert!((p[0] as i32 - 190).abs() <= 2 && p[1] == 128 && p[2] == 128, "{p:?}");
        // the combined curve and a channel curve work together, and the order is combined first
        let both = Recipe { curve: vec![[128.0, 100.0]], curve_blue: vec![[100.0, 160.0]], ..Default::default() };
        let q = apply_tone(&flat(1, 1, [128, 128, 128]), &both).get_pixel(0, 0).0;
        assert!((q[0] as i32 - 100).abs() <= 2 && (q[2] as i32 - 160).abs() <= 3, "{q:?}");
        let json = serde_json::to_string(&Recipe { curve_green: vec![[10.0, 30.0]], parametric: Parametric { darks: 25.0, ..Default::default() }, ..Default::default() }).unwrap();
        assert!(json.contains("\"curveGreen\"") && json.contains("\"parametric\""), "{json}");
        let back: Recipe = serde_json::from_str(&json).unwrap();
        assert_eq!((back.curve_green.len(), back.parametric.darks), (1, 25.0));
        let old: Recipe = serde_json::from_str("{\"exposure\":0.5}").unwrap();
        assert!(old.curve_red.is_empty() && old.parametric.is_zero(), "older recipes still load");
    }

    #[test]
    fn a_curve_never_overshoots_or_inverts() {
        // a steep S that would overshoot with a plain cubic
        let lut = curve_lut(&[[40.0, 10.0], [100.0, 120.0], [110.0, 200.0], [200.0, 250.0]]).unwrap();
        assert!(lut.windows(2).all(|w| w[1] >= w[0] - 1e-6), "never goes down");
        assert!(lut.iter().all(|v| (0.0..=1.0).contains(v)));
        assert_eq!((lut[0], lut[1024]), (0.0, 1.0));
    }

    #[test]
    fn curve_points_are_cleaned() {
        let c = clean_points(&[[200.0, 210.0], [50.0, 40.0], [50.4, 99.0], [f32::NAN, 1.0], [-20.0, 300.0]]);
        assert_eq!(c, vec![[0.0, 255.0], [50.0, 40.0], [200.0, 210.0]], "sorted, clamped, one per input, no NaN");
        let many: Vec<[f32; 2]> = (0..40).map(|i| [i as f32 * 6.0, i as f32 * 6.0]).collect();
        assert_eq!(clean_points(&many).len(), MAX_CURVE_POINTS);
    }

    fn mixed(c: [u8; 3], edit: impl FnOnce(&mut Hsl)) -> [u8; 3] {
        let mut hsl = Hsl::default();
        edit(&mut hsl);
        apply_tone(&flat(1, 1, c), &Recipe { hsl, ..Default::default() }).get_pixel(0, 0).0
    }

    #[test]
    fn colour_mixer_changes_only_its_own_band() {
        let (red, green, grey) = ([220u8, 40, 40], [40u8, 200, 60], [128u8, 128, 128]);
        // red saturation down: the red loses colour, green is untouched, grey is untouched
        let r = mixed(red, |h| h.sat[0] = -100.0);
        assert!(r[0] as i32 - r[1] as i32 <= 12, "red is nearly grey: {r:?}");
        assert_eq!(mixed(green, |h| h.sat[0] = -100.0), green);
        assert_eq!(
            mixed(grey, |h| {
                h.sat[0] = 100.0;
                h.hue[3] = 100.0;
                h.lum[5] = 100.0;
            }),
            grey
        );
        // green luminance up brightens green but not red
        let g = mixed(green, |h| h.lum[3] = 100.0);
        assert!(g[1] > green[1] && g[0] >= green[0], "{g:?}");
        assert_eq!(mixed(red, |h| h.lum[3] = 100.0), red);
    }

    #[test]
    fn colour_mixer_hue_moves_red_towards_orange_and_yellow() {
        let red = [220u8, 40, 40];
        let shifted = mixed(red, |h| h.hue[0] = 100.0);
        assert!(shifted[1] > red[1] + 20, "more green, so more orange: {shifted:?}");
        let back = mixed(red, |h| h.hue[0] = -100.0);
        assert!(back[2] > red[2] + 20, "more blue, so towards magenta: {back:?}");
    }

    #[test]
    fn neighbouring_bands_blend_without_a_step() {
        // walk the hue wheel with orange saturation changed: the result never jumps
        let mut last: Option<[u8; 3]> = None;
        for deg in 0..=60 {
            let c = hsl_to_rgb(deg as f32, 0.8, 0.5);
            let px = [(c[0] * 255.0) as u8, (c[1] * 255.0) as u8, (c[2] * 255.0) as u8];
            let out = mixed(px, |h| h.sat[1] = -60.0);
            if let Some(l) = last {
                for i in 0..3 {
                    assert!((out[i] as i32 - l[i] as i32).abs() <= 8, "step at {deg} degrees: {l:?} to {out:?}");
                }
            }
            last = Some(out);
        }
        let w = band_weights(300.0);
        assert!((w.iter().sum::<f32>() - 1.0).abs() < 1e-5, "weights always add to one");
        let w = band_weights(350.0);
        assert!(w[7] > 0.0 && w[0] > 0.0, "magenta blends into red across the wrap");
    }

    #[test]
    fn hsl_round_trips_and_a_default_mixer_is_a_no_op() {
        for c in [[0.9f32, 0.2, 0.1], [0.1, 0.8, 0.3], [0.2, 0.3, 0.95], [0.5, 0.5, 0.5], [1.0, 1.0, 0.0]] {
            let (h, s, l) = rgb_to_hsl(c);
            let b = hsl_to_rgb(h, s, l);
            for i in 0..3 {
                assert!((b[i] - c[i]).abs() < 1e-4, "{c:?} -> {b:?}");
            }
        }
        assert!(Hsl::default().is_zero());
        let s = Recipe { hsl: Hsl { hue: [500.0; 8], sat: [f32::NAN; 8], lum: [0.0; 8] }, ..Default::default() }.sanitized();
        assert_eq!((s.hsl.hue[0], s.hsl.sat[0]), (100.0, 0.0));
    }

    // ---- detail ----

    fn grey_step(w: u32, h: u32) -> RgbImage {
        ImageBuffer::from_fn(w, h, |x, _| if x < w / 2 { Rgb([100; 3]) } else { Rgb([156; 3]) })
    }

    /// Deterministic noise in [-1, 1].
    fn noise(i: u32) -> f32 {
        let mut x = i.wrapping_mul(2654435761).wrapping_add(12345);
        x ^= x >> 13;
        x = x.wrapping_mul(1274126177);
        x ^= x >> 16;
        (x % 2000) as f32 / 1000.0 - 1.0
    }

    fn variance(img: &RgbImage, ch: usize) -> f32 {
        let v: Vec<f32> = img.pixels().map(|p| p[ch] as f32).collect();
        let m = v.iter().sum::<f32>() / v.len() as f32;
        v.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / v.len() as f32
    }

    #[test]
    fn blur_keeps_a_flat_plane_flat_and_conserves_light() {
        let flat = vec![0.4f32; 64 * 48];
        let b = blur_plane(&flat, 64, 48, 3.0);
        assert!(b.iter().all(|v| (v - 0.4).abs() < 1e-4));
        let mut dot = vec![0.0f32; 65 * 65];
        dot[32 * 65 + 32] = 1.0;
        let b = blur_plane(&dot, 65, 65, 2.0);
        assert!((b.iter().sum::<f32>() - 1.0).abs() < 1e-3, "total light is kept");
        assert!((b[32 * 65 + 30] - b[32 * 65 + 34]).abs() < 1e-5, "symmetric");
        assert!(b[32 * 65 + 32] > b[32 * 65 + 36], "peak in the middle");
        assert!(b[32 * 65 + 32] < 0.5 && b[32 * 65 + 34] > 0.01, "the dot is really spread out, not left alone");
        let tiny = blur_plane(&dot, 65, 65, MIN_SIGMA);
        assert!(tiny[32 * 65 + 32] < 0.9, "even the smallest blur changes something");
    }

    #[test]
    fn default_detail_changes_nothing() {
        let img = grey_step(40, 20);
        assert_eq!(apply_detail(&img, &Detail::default()), img);
    }

    #[test]
    fn sharpening_overshoots_at_an_edge_and_leaves_flat_areas_alone() {
        let img = grey_step(200, 40);
        let out = apply_detail(&img, &Detail { sharp_amount: 100.0, ..Default::default() });
        let (dark_side, bright_side) = (out.get_pixel(99, 20)[0], out.get_pixel(100, 20)[0]); // the pixels beside the edge
        assert!(dark_side < 100 && bright_side > 156, "{dark_side} {bright_side}");
        assert_eq!(out.get_pixel(10, 20)[0], 100, "far from the edge nothing moves");
        assert_eq!(out.get_pixel(190, 20)[0], 156);
        let more = apply_detail(&img, &Detail { sharp_amount: 150.0, ..Default::default() });
        assert!(more.get_pixel(100, 20)[0] >= bright_side, "more amount is not less sharp");
    }

    #[test]
    fn the_new_detail_settings_change_nothing_at_their_plain_values_and_do_what_they_say_away_from_them() {
        let (w, h) = (96u32, 96u32);
        let img = RgbImage::from_fn(w, h, |x, y| {
            let edge = if x > 48 { 60.0 } else { 0.0 };
            let v = (110.0 + edge + noise(x + y * w) * 7.0).clamp(0.0, 255.0) as u8;
            image::Rgb([v, v, v])
        });
        let base = Detail { sharp_amount: 80.0, sharp_radius: 2.5, nr_luma: 60.0, nr_colour: 40.0, ..Default::default() };
        // the plain values are the old behaviour
        let plain = Detail { sharp_detail: 0.0, nr_luma_detail: 50.0, nr_luma_contrast: 0.0, nr_colour_smooth: 50.0, ..base.clone() };
        assert_eq!(apply_detail_scaled(&img, &base, 1.0), apply_detail_scaled(&img, &plain, 1.0));
        // more sharpening detail changes the result and adds fine texture
        let fine = apply_detail_scaled(&img, &Detail { sharp_detail: 100.0, ..base.clone() }, 1.0);
        assert_ne!(fine, apply_detail_scaled(&img, &base, 1.0));
        // more luminance detail keeps more of the grain than less
        let var = |i: &RgbImage| {
            let vals: Vec<f32> = (0..40).flat_map(|y| (4..40).map(move |x| (x, y))).map(|(x, y)| i.get_pixel(x, y).0[0] as f32).collect();
            let m = vals.iter().sum::<f32>() / vals.len() as f32;
            vals.iter().map(|v| (v - m) * (v - m)).sum::<f32>() / vals.len() as f32
        };
        let nr = |d: f32, c: f32| apply_detail_scaled(&img, &Detail { nr_luma: 80.0, nr_luma_detail: d, nr_luma_contrast: c, ..Default::default() }, 1.0);
        assert!(var(&nr(100.0, 0.0)) > var(&nr(0.0, 0.0)), "more detail kept");
        assert!(var(&nr(50.0, 100.0)) > var(&nr(50.0, 0.0)), "more contrast kept");
        // a wider colour smoothing blurs colour speckle more
        let speckle = RgbImage::from_fn(w, h, |x, y| {
            let n = noise(x * 3 + y * w) * 40.0;
            image::Rgb([(128.0 + n).clamp(0.0, 255.0) as u8, 128, (128.0 - n).clamp(0.0, 255.0) as u8])
        });
        let chroma = |i: &RgbImage| (0..w * h).map(|k| (i.get_pixel(k % w, k / w).0[0] as f32 - i.get_pixel(k % w, k / w).0[2] as f32).abs()).sum::<f32>();
        let col = |s: f32| apply_detail_scaled(&speckle, &Detail { nr_colour: 15.0, nr_colour_smooth: s, ..Default::default() }, 1.0);
        assert!(chroma(&col(100.0)) < chroma(&col(0.0)), "smoother means less colour speckle left");
    }

    #[test]
    fn sharpening_leaves_colour_alone() {
        let img: RgbImage = ImageBuffer::from_fn(120, 30, |x, _| if x < 60 { Rgb([200, 60, 60]) } else { Rgb([60, 60, 200]) });
        let out = apply_detail(&img, &Detail { sharp_amount: 100.0, ..Default::default() });
        // the red minus blue difference at the far ends is unchanged
        assert_eq!(out.get_pixel(5, 5).0, [200, 60, 60]);
        assert_eq!(out.get_pixel(115, 5).0, [60, 60, 200]);
    }

    #[test]
    fn masking_stops_sharpening_from_boosting_fine_grain() {
        let grain: RgbImage = ImageBuffer::from_fn(128, 128, |x, y| {
            let v = (128.0 + noise(x + y * 128) * 3.0) as u8;
            Rgb([v; 3])
        });
        let plain = apply_detail(&grain, &Detail { sharp_amount: 150.0, ..Default::default() });
        let masked = apply_detail(&grain, &Detail { sharp_amount: 150.0, sharp_masking: 100.0, ..Default::default() });
        assert!(variance(&plain, 0) > variance(&grain, 0) * 1.5, "unmasked sharpening boosts grain");
        assert!(variance(&masked, 0) < variance(&plain, 0) * 0.5, "masking holds it back");
    }

    #[test]
    fn luminance_noise_reduction_smooths_noise_but_keeps_an_edge() {
        let noisy: RgbImage = ImageBuffer::from_fn(200, 60, |x, y| {
            let base = if x < 100 { 70.0 } else { 190.0 };
            let v = (base + noise(x + y * 200) * 8.0).clamp(0.0, 255.0) as u8;
            Rgb([v; 3])
        });
        let out = apply_detail(&noisy, &Detail { nr_luma: 80.0, ..Default::default() });
        let flat = |img: &RgbImage| image::imageops::crop_imm(img, 10, 10, 60, 40).to_image();
        assert!(variance(&flat(&out), 0) < variance(&flat(&noisy), 0) * 0.4, "noise drops");
        let step = out.get_pixel(110, 30)[0] as i32 - out.get_pixel(90, 30)[0] as i32;
        assert!(step > 100, "the edge is still there: {step}");
    }

    #[test]
    fn colour_noise_reduction_removes_colour_speckle_but_not_brightness() {
        let speckle: RgbImage = ImageBuffer::from_fn(100, 100, |x, y| {
            let n = noise(x + y * 100) * 30.0;
            Rgb([(128.0 + n).clamp(0.0, 255.0) as u8, 128, (128.0 - n).clamp(0.0, 255.0) as u8])
        });
        let out = apply_detail(&speckle, &Detail { nr_colour: 100.0, ..Default::default() });
        let spread = |img: &RgbImage| variance(img, 0) + variance(img, 2);
        assert!(spread(&out) < spread(&speckle) * 0.2, "colour speckle is mostly gone");
        let mean = |img: &RgbImage| img.pixels().map(|p| p[1] as f32).sum::<f32>() / 10000.0;
        assert!((mean(&out) - mean(&speckle)).abs() < 3.0, "overall brightness is kept");
    }

    #[test]
    fn detail_values_are_clamped_and_old_recipes_still_load() {
        let s = Recipe { detail: Detail { sharp_amount: 9e9, sharp_radius: f32::NAN, nr_luma: -5.0, ..Default::default() }, ..Default::default() }.sanitized();
        assert_eq!((s.detail.sharp_amount, s.detail.sharp_radius, s.detail.nr_luma), (150.0, 1.0, 0.0));
        let old: Recipe = serde_json::from_str(r#"{"exposure":0.5}"#).unwrap();
        assert_eq!(old.detail, Detail::default());
        let radius_only: Recipe = serde_json::from_str(r#"{"detail":{"sharpAmount":40}}"#).unwrap();
        assert_eq!(radius_only.detail.sharp_radius, 1.0, "missing fields take their own defaults, not zero");
    }

    fn textured(w: u32, h: u32) -> RgbImage {
        ImageBuffer::from_fn(w, h, |x, y| {
            let v = (128.0 + 90.0 * (((x / 7 + y / 5) % 2) as f32 - 0.5) + noise(x + y * w) * 6.0).clamp(0.0, 255.0) as u8;
            Rgb([v, (v as u32 * 9 / 10) as u8, (255 - v as u32 / 2) as u8])
        })
    }

    #[test]
    fn a_region_matches_the_same_window_of_a_full_render() {
        let img = textured(600, 400);
        let r = Recipe {
            exposure: 0.4,
            contrast: 20.0,
            hsl: Hsl { sat: [-30.0; 8], ..Default::default() },
            detail: Detail { sharp_amount: 80.0, nr_luma: 30.0, nr_colour: 40.0, ..Default::default() },
            ..Default::default()
        };
        let whole = render(&img, &r);
        for (x, y, w, h) in [(100u32, 80u32, 200u32, 150u32), (0, 0, 120, 90), (480, 310, 120, 90)] {
            let part = render_region(&img, &r, x, y, w, h);
            assert_eq!((part.width(), part.height()), (w, h));
            let want = image::imageops::crop_imm(&whole, x, y, w, h).to_image();
            let worst = part.pixels().zip(want.pixels()).flat_map(|(a, b)| (0..3).map(move |i| (a[i] as i32 - b[i] as i32).abs())).max().unwrap();
            assert!(worst <= 2, "window {x},{y} differs from the full render by {worst}");
        }
    }

    #[test]
    fn a_region_is_clamped_to_the_picture() {
        let img = textured(100, 60);
        let r = Recipe { exposure: 0.2, ..Default::default() };
        let big = render_region(&img, &r, 50, 50, 999, 999);
        assert_eq!((big.width(), big.height()), (100, 60), "asking for more gives the whole picture");
        let shifted = render_region(&img, &r, 90, 50, 40, 30);
        assert_eq!((shifted.width(), shifted.height()), (40, 30));
        let same = render_region(&img, &r, 60, 30, 40, 30);
        assert_eq!(shifted, same, "a window pushed past the edge is moved back inside");
        assert_eq!(render_region(&img, &r, 0, 0, 0, 0).width(), 1, "never an empty image");
    }

    #[test]
    fn detail_radius_follows_the_whole_picture_not_the_window() {
        // the same piece of a big picture sharpens the same whether it is cut out first or not
        let img = textured(2400, 200);
        let r = Recipe { detail: Detail { sharp_amount: 120.0, ..Default::default() }, ..Default::default() };
        let part = render_region(&img, &r, 1000, 40, 150, 100);
        let want = image::imageops::crop_imm(&render(&img, &r), 1000, 40, 150, 100).to_image();
        let worst = part.pixels().zip(want.pixels()).flat_map(|(a, b)| (0..3).map(move |i| (a[i] as i32 - b[i] as i32).abs())).max().unwrap();
        assert!(worst <= 2, "differs by {worst}");
        // and cutting first, then sharpening with the window's own size, would not match
        let wrong = apply_detail(&image::imageops::crop_imm(&img, 1000, 40, 150, 100).to_image(), &r.detail);
        let wrong_worst = wrong.pixels().zip(want.pixels()).flat_map(|(a, b)| (0..3).map(move |i| (a[i] as i32 - b[i] as i32).abs())).max().unwrap();
        assert!(wrong_worst > worst, "the scale really matters here");
    }

    // ---- effects ----

    fn grey(w: u32, h: u32, v: u8) -> RgbImage {
        flat(w, h, [v, v, v])
    }

    #[test]
    fn default_effects_change_nothing() {
        let img = textured(60, 40);
        assert_eq!(apply_effects(&img, &Effects::default(), 0, 0, 60, 40), img);
    }

    #[test]
    fn a_dark_vignette_darkens_the_corners_and_leaves_the_centre() {
        let img = grey(300, 200, 160);
        let out = apply_effects(&img, &Effects { vignette_amount: -80.0, ..Default::default() }, 0, 0, 300, 200);
        assert_eq!(out.get_pixel(150, 100)[0], 160, "the centre is untouched");
        assert!(out.get_pixel(0, 0)[0] < 100, "the corner is much darker: {}", out.get_pixel(0, 0)[0]);
        assert!(out.get_pixel(0, 0)[0] < out.get_pixel(40, 30)[0], "darker towards the corner");
        let light = apply_effects(&img, &Effects { vignette_amount: 80.0, ..Default::default() }, 0, 0, 300, 200);
        assert!(light.get_pixel(0, 0)[0] > 200, "a positive amount lightens the corner");
        assert_eq!(light.get_pixel(150, 100)[0], 160);
    }

    #[test]
    fn vignette_roundness_midpoint_and_feather_each_change_the_shape() {
        let img = grey(400, 200, 200);
        let v = |e: Effects, x, y| apply_effects(&img, &Effects { vignette_amount: -90.0, ..e }, 0, 0, 400, 200).get_pixel(x, y)[0];
        let def = Effects::default();
        // wide picture: the middle of the top edge is nearer the centre than the middle of the side edge, so a circle leaves it lighter
        let (ellipse_top, circle_top) = (v(Effects { vignette_roundness: 0.0, ..def.clone() }, 200, 0), v(Effects { vignette_roundness: 100.0, ..def.clone() }, 200, 0));
        assert!(circle_top > ellipse_top, "{circle_top} vs {ellipse_top}");
        // a later midpoint leaves a point halfway out lighter
        let (early, late) = (v(Effects { vignette_midpoint: 10.0, ..def.clone() }, 320, 100), v(Effects { vignette_midpoint: 90.0, ..def.clone() }, 320, 100));
        assert!(late > early, "{late} vs {early}");
        // a wider feather spreads the change: a point just outside the start is darker with a hard edge
        let (hard, soft) = (v(Effects { vignette_feather: 0.0, vignette_midpoint: 50.0, ..def.clone() }, 330, 100), v(Effects { vignette_feather: 100.0, vignette_midpoint: 50.0, ..def.clone() }, 330, 100));
        assert!(hard < soft, "{hard} vs {soft}");
    }

    #[test]
    fn grain_is_repeatable_adds_texture_and_grows_with_amount() {
        let img = grey(200, 200, 128);
        let g = |amount: f32, size: f32, rough: f32| apply_effects(&img, &Effects { grain_amount: amount, grain_size: size, grain_roughness: rough, ..Default::default() }, 0, 0, 200, 200);
        let a = g(60.0, 25.0, 50.0);
        assert_eq!(a, g(60.0, 25.0, 50.0), "the same settings give the same grain");
        assert!(variance(&a, 0) > 4.0, "there is texture: {}", variance(&a, 0));
        assert!(variance(&g(100.0, 25.0, 50.0), 0) > variance(&g(30.0, 25.0, 50.0), 0) * 2.0, "more amount, more grain");
        // grain size is relative to the picture, so judge it on a picture 2048 px wide (smaller ones clamp to one-pixel grain)
        let wide = grey(2048, 24, 128);
        let wide_grain = |size: f32| apply_effects(&wide, &Effects { grain_amount: 60.0, grain_size: size, grain_roughness: 0.0, ..Default::default() }, 0, 0, 2048, 24);
        let neighbour = |img: &RgbImage| {
            let mut diff = 0.0;
            for y in 0..24 {
                for x in 0..2047 {
                    diff += (img.get_pixel(x, y)[0] as f32 - img.get_pixel(x + 1, y)[0] as f32).abs();
                }
            }
            diff
        };
        assert!(neighbour(&wide_grain(100.0)) < neighbour(&wide_grain(0.0)) * 0.6, "bigger grain changes more slowly from pixel to pixel");
        // grain is a brightness change only: the three channels move together
        let px = a.get_pixel(50, 50);
        assert!(px[0] == px[1] && px[1] == px[2]);
        // film grain shows in the midtones more than in the deep shadows
        let dark = apply_effects(&grey(200, 200, 8), &Effects { grain_amount: 100.0, ..Default::default() }, 0, 0, 200, 200);
        assert!(variance(&dark, 0) < variance(&g(100.0, 25.0, 50.0), 0));
    }

    #[test]
    fn effects_on_a_window_match_the_same_window_of_the_whole_picture() {
        let img = textured(600, 400);
        let r = Recipe { effects: Effects { vignette_amount: -60.0, grain_amount: 50.0, grain_size: 40.0, ..Default::default() }, ..Default::default() };
        let whole = render(&img, &r);
        let part = render_region(&img, &r, 220, 130, 180, 120);
        let want = image::imageops::crop_imm(&whole, 220, 130, 180, 120).to_image();
        let worst = part.pixels().zip(want.pixels()).flat_map(|(a, b)| (0..3).map(move |i| (a[i] as i32 - b[i] as i32).abs())).max().unwrap();
        assert!(worst <= 1, "the window differs from the whole by {worst}");
    }

    #[test]
    fn effects_values_are_clamped_and_old_recipes_still_load() {
        let s = Recipe { effects: Effects { vignette_amount: 9e9, grain_size: f32::NAN, vignette_midpoint: -3.0, ..Default::default() }, ..Default::default() }.sanitized();
        assert_eq!((s.effects.vignette_amount, s.effects.grain_size, s.effects.vignette_midpoint), (100.0, 25.0, 0.0));
        let old: Recipe = serde_json::from_str(r#"{"exposure":0.5}"#).unwrap();
        assert_eq!(old.effects, Effects::default());
        let part: Recipe = serde_json::from_str(r#"{"effects":{"grainAmount":30}}"#).unwrap();
        assert_eq!((part.effects.grain_amount, part.effects.vignette_midpoint), (30.0, 50.0), "missing fields keep their own defaults");
    }

    // ---- auto ----

    fn gradient(w: u32, lo: u8, hi: u8) -> RgbImage {
        ImageBuffer::from_fn(w, 20, |x, _| {
            let v = (lo as f32 + (hi - lo) as f32 * x as f32 / (w - 1) as f32) as u8;
            Rgb([v, v, v])
        })
    }

    #[test]
    fn auto_tone_adds_contrast_and_colour_and_sets_the_ends_from_the_picture() {
        let dark = auto_settings(&gradient(400, 0, 90));
        assert!(dark.exposure > 0.5, "{dark:?}");
        let bright = auto_settings(&gradient(400, 120, 255));
        assert!(bright.exposure < 0.0, "{bright:?}"); // not darkened further when its whites are clipped
        // a picture of ordinary lightness gets about no change of exposure (Lightroom's were within 0.1 of 0 for a mean tone near 95)
        let even = auto_settings(&gradient(400, 40, 150));
        assert!(even.exposure.abs() < 0.25, "{even:?}");
        // the same contrast, shadows, highlights and vibrance on every picture; only the ends follow it
        for a in [&dark, &bright, &even] {
            assert_eq!((a.contrast, a.shadows, a.vibrance), (12.0, 10.0, 20.0), "{a:?}");
            assert!((-35.0..=-25.0).contains(&a.highlights) && (0.0..=40.0).contains(&a.whites) && (-50.0..=-5.0).contains(&a.blacks), "{a:?}");
        }
    }

    #[test]
    fn auto_tone_stays_inside_the_slider_ranges_on_extreme_pictures() {
        for img in [grey(50, 50, 0), grey(50, 50, 255), RgbImage::new(0, 0)] {
            let a = auto_settings(&img);
            assert!(a.exposure.abs() <= 3.0 && a.contrast.abs() <= 100.0 && a.highlights.abs() <= 100.0 && a.shadows.abs() <= 100.0, "{a:?}");
            assert!(a.temperature.abs() <= 100.0 && a.tint.abs() <= 100.0);
        }
    }

    #[test]
    fn auto_white_balance_neutralises_a_colour_cast() {
        // a bluish cast on neutral content: auto must warm it up (positive temperature), and applying it must even out red and blue
        let cast: RgbImage = ImageBuffer::from_fn(100, 100, |x, _| {
            let v = 80 + (x as u32 * 90 / 99) as u8;
            Rgb([(v as f32 * 0.82) as u8, v, (v as f32 * 1.12).min(255.0) as u8])
        });
        let a = auto_settings(&cast);
        assert!(a.temperature > 5.0, "{a:?}");
        let fixed = apply_tone(&cast, &Recipe { temperature: a.temperature, tint: a.tint, ..Default::default() });
        let mean = |img: &RgbImage, ch: usize| img.pixels().map(|p| p[ch] as f32).sum::<f32>() / 10000.0;
        let before = (mean(&cast, 2) - mean(&cast, 0)).abs();
        let after = (mean(&fixed, 2) - mean(&fixed, 0)).abs();
        // one global setting cannot undo a cast that differs with brightness, but it removes most of it
        assert!(after < before * 0.8, "red and blue are closer: {before} -> {after}");
        // a neutral picture is left alone
        let neutral = auto_settings(&gradient(400, 10, 240));
        assert_eq!((neutral.temperature, neutral.tint), (0.0, 0.0));
    }

    // ---- masks in the pipeline ----

    fn masked_recipe() -> Recipe {
        use crate::masks::{LocalAdjust, Shape, Stroke};
        Recipe {
            exposure: 0.2,
            detail: Detail { sharp_amount: 30.0, ..Default::default() },
            effects: Effects { vignette_amount: -30.0, ..Default::default() },
            masks: vec![
                Mask {
                    id: "g".into(),
                    name: "Sky".into(),
                    visible: true,
                    invert: false,
                    parts: Vec::new(),
                    shape: Shape::Linear { x1: 0.5, y1: 0.0, x2: 0.5, y2: 0.6, feather: 0.8 },
                    adjust: LocalAdjust { exposure: -0.8, saturation: 20.0, ..Default::default() },
                },
                Mask {
                    id: "b".into(),
                    name: "Face".into(),
                    visible: true,
                    invert: false,
                    parts: Vec::new(),
                    shape: Shape::Brush { strokes: vec![Stroke { size: 0.15, feather: 0.6, flow: 0.9, points: vec![[0.3, 0.6], [0.55, 0.7]], ..Default::default() }] },
                    adjust: LocalAdjust { exposure: 0.6, sharpness: 50.0, noise: 30.0, ..Default::default() },
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn masks_change_the_picture_and_removing_them_changes_it_back() {
        let img = textured(400, 300);
        let with = render(&img, &masked_recipe());
        let without = render(&img, &Recipe { masks: vec![], ..masked_recipe() });
        assert_ne!(with, without);
        // the top of the picture (where the sky gradient is full) is darker with the mask
        let mean_top = |i: &RgbImage| (0..400).map(|x| i.get_pixel(x, 5)[1] as f32).sum::<f32>() / 400.0;
        assert!(mean_top(&with) < mean_top(&without), "the sky mask darkens the top");
        // a mask with no adjustment, or hidden, is the same as none
        let mut idle = masked_recipe();
        for m in idle.masks.iter_mut() {
            m.visible = false;
        }
        assert_eq!(render(&img, &idle), without);
        assert!(masked_recipe().has_masks() && !without_masks().has_masks());
    }

    fn without_masks() -> Recipe {
        Recipe { masks: vec![], ..masked_recipe() }
    }

    #[test]
    fn a_window_of_a_masked_picture_matches_the_whole() {
        let img = textured(600, 400);
        let r = masked_recipe();
        let whole = render(&img, &r);
        for (x, y, w, h) in [(180u32, 120u32, 200u32, 150u32), (0, 0, 150, 100), (450, 300, 150, 100)] {
            let part = render_region(&img, &r, x, y, w, h);
            let want = image::imageops::crop_imm(&whole, x, y, w, h).to_image();
            let worst = part.pixels().zip(want.pixels()).flat_map(|(a, b)| (0..3).map(move |i| (a[i] as i32 - b[i] as i32).abs())).max().unwrap();
            assert!(worst <= 2, "window {x},{y} differs by {worst}");
        }
    }

    #[test]
    fn masks_survive_json_and_old_recipes_load_without_them() {
        let r = masked_recipe();
        let back: Recipe = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(back.sanitized(), r.sanitized());
        let old: Recipe = serde_json::from_str(r#"{"exposure":0.5}"#).unwrap();
        assert!(old.masks.is_empty());
    }

    // ---- spots in the pipeline ----

    fn speck_picture() -> RgbImage {
        let mut img: RgbImage = ImageBuffer::from_fn(600, 400, |x, y| Rgb([(90.0 + x as f32 * 0.05) as u8, (100.0 + y as f32 * 0.04) as u8, 110]));
        for y in 195..205 {
            for x in 295..305 {
                img.put_pixel(x, y, Rgb([10, 10, 10]));
            }
        }
        img
    }

    fn spot_recipe() -> Recipe {
        use crate::spots::{Spot, SpotMode};
        Recipe {
            exposure: 0.3,
            spots: vec![
                Spot { id: "a".into(), visible: true, mode: SpotMode::Heal, x: 0.5, y: 0.5, sx: 0.8, sy: 0.3, size: 0.06, feather: 0.4, opacity: 1.0 },
                Spot { id: "b".into(), visible: true, mode: SpotMode::Clone, x: 0.2, y: 0.7, sx: 0.9, sy: 0.9, size: 0.05, feather: 0.0, opacity: 0.8 },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn a_spot_removes_the_speck_before_the_tone_edits_and_hiding_it_brings_the_speck_back() {
        let img = speck_picture();
        let with = render(&img, &spot_recipe());
        let hidden = {
            let mut r = spot_recipe();
            r.spots.iter_mut().for_each(|s| s.visible = false);
            render(&img, &r)
        };
        let (a, b) = (with.get_pixel(300, 200)[0] as i32, hidden.get_pixel(300, 200)[0] as i32);
        assert!(a > b + 60, "speck gone with the spot ({a}) and still there without it ({b})");
        assert_eq!(hidden, render(&img, &Recipe { spots: vec![], ..spot_recipe() }), "a hidden spot is the same as none");
        // spots come before tone: healing then brightening gives the same speck-free result as the other order would not
        let bright_then = render(&img, &Recipe { exposure: 1.0, ..spot_recipe() });
        assert!((bright_then.get_pixel(300, 200)[0] as i32 - bright_then.get_pixel(310, 200)[0] as i32).abs() <= 6, "no dark hole after the exposure change");
    }

    #[test]
    fn a_1_to_1_window_matches_the_whole_even_when_a_patch_is_copied_from_outside_it() {
        let img = speck_picture();
        let r = Recipe { detail: Detail { sharp_amount: 40.0, ..Default::default() }, ..spot_recipe() };
        let whole = render(&img, &r);
        // this window holds the first spot's target but not its source (0.8, 0.3 is at x = 480)
        for (x, y, w, h) in [(250u32, 150u32, 120u32, 100u32), (0, 240, 200, 150), (450, 100, 150, 150)] {
            let part = render_region(&img, &r, x, y, w, h);
            let want = image::imageops::crop_imm(&whole, x, y, w, h).to_image();
            let worst = part.pixels().zip(want.pixels()).flat_map(|(a, b)| (0..3).map(move |i| (a[i] as i32 - b[i] as i32).abs())).max().unwrap();
            assert!(worst <= 2, "window {x},{y} differs by {worst}");
        }
    }

    #[test]
    fn spots_survive_json_and_old_recipes_load_without_them() {
        let r = spot_recipe();
        let back: Recipe = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(back.sanitized(), r.sanitized());
        let old: Recipe = serde_json::from_str(r#"{"exposure":0.5}"#).unwrap();
        assert!(old.spots.is_empty());
    }

    // ---- geometry in the pipeline ----

    #[test]
    fn lens_and_transform_are_applied_before_the_crop_and_before_everything_else() {
        // a bright bar across the middle: rotating it first, then cropping a square, gives a tilted bar in the square
        let img: RgbImage = ImageBuffer::from_fn(400, 300, |_, y| if (145..155).contains(&y) { Rgb([240; 3]) } else { Rgb([10; 3]) });
        let straight = render(&img, &Recipe { crop: Crop { aspect: "1:1".into(), angle: 0.0, rect: None }, ..Default::default() });
        let tilted = render(&img, &Recipe { geometry: Geometry { rotate: 6.0, ..Default::default() }, crop: Crop { aspect: "1:1".into(), angle: 0.0, rect: None }, ..Default::default() });
        assert_eq!((straight.width(), straight.height()), (tilted.width(), tilted.height()), "the crop is the same size");
        let bar_row = |i: &RgbImage, x: u32| (0..i.height()).find(|y| i.get_pixel(x, *y)[0] > 128).unwrap() as i32;
        let w = straight.width();
        assert!((bar_row(&straight, 5) - bar_row(&straight, w - 6)).abs() <= 1, "level before");
        assert!((bar_row(&tilted, 5) - bar_row(&tilted, w - 6)).abs() >= 12, "tilted after, inside the same crop");
        // an identity geometry is the same as none, and a hidden effect is not needed to see the difference
        assert_eq!(render(&img, &Recipe::default()), render(&img, &Recipe { geometry: Geometry { constrain: false, ..Default::default() }, ..Default::default() }));
    }

    #[test]
    fn a_1_to_1_window_matches_the_whole_when_lens_and_transform_are_on() {
        // the page prepares the full-size picture with the geometry already applied, and asks for windows of that
        let img = textured(600, 400);
        let geo = Geometry { distortion: 30.0, vertical: 25.0, rotate: 2.0, ca_red: 20.0, ..Default::default() };
        let r = Recipe { exposure: 0.3, geometry: geo.clone(), ..Default::default() };
        let whole = render(&img, &r);
        let prepared = geometry::apply_geometry(&img, &geo);
        let region = render_region(&prepared, &Recipe { geometry: Geometry::default(), ..r.clone() }, 150, 90, 200, 150);
        let want = image::imageops::crop_imm(&whole, 150, 90, 200, 150).to_image();
        let worst = region.pixels().zip(want.pixels()).flat_map(|(a, b)| (0..3).map(move |i| (a[i] as i32 - b[i] as i32).abs())).max().unwrap();
        assert!(worst <= 2, "differs by {worst}");
    }

    #[test]
    fn json_round_trips_and_missing_fields_default() {
        let r: Recipe = serde_json::from_str(r#"{"exposure":1.5,"crop":{"angle":3}}"#).unwrap();
        assert_eq!(r.exposure, 1.5);
        assert_eq!(r.contrast, 0.0);
        assert_eq!(r.crop.aspect, "original");
        let back: Recipe = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
        assert_eq!(back, r);
    }

#[test]
    fn the_presence_sliders_are_clamped_saved_with_a_default_and_a_region_matches_the_full_render_with_them_on() {
        // clamped, and an old recipe without the new fields loads with zero
        let wild = Recipe { texture: 900.0, clarity: f32::NAN, dehaze: -900.0, ..Default::default() }.sanitized();
        assert_eq!((wild.texture, wild.clarity, wild.dehaze), (100.0, 0.0, -100.0));
        let old: Recipe = serde_json::from_str(r#"{"exposure":0.5}"#).unwrap();
        assert_eq!((old.texture, old.clarity, old.dehaze), (0.0, 0.0, 0.0));
        let json = serde_json::to_string(&Recipe { texture: 20.0, clarity: -10.0, dehaze: 35.0, ..Default::default() }).unwrap();
        assert!(json.contains("\"texture\":20") && json.contains("\"clarity\":-10") && json.contains("\"dehaze\":35"), "{json}");
        assert_eq!(serde_json::from_str::<Recipe>(&json).unwrap().dehaze, 35.0);
        // they make a recipe an edited one
        assert_ne!(Recipe { dehaze: 1.0, ..Default::default() }, Recipe::default());
        // a piece for the 100% view agrees with the same piece of the whole render
        let img = textured(600, 400);
        for r in [Recipe { clarity: 60.0, texture: 40.0, ..Default::default() }, Recipe { dehaze: 70.0, ..Default::default() }, Recipe { dehaze: -50.0, clarity: -30.0, texture: -40.0, exposure: 0.3, ..Default::default() }] {
            let whole = render(&img, &r);
            assert_ne!(whole, render(&img, &Recipe::default()), "it does something: {r:?}");
            for (x, y, w, h) in [(100u32, 80u32, 200u32, 150u32), (0, 0, 120, 90), (480, 310, 120, 90)] {
                let part = render_region(&img, &r, x, y, w, h);
                let want = image::imageops::crop_imm(&whole, x, y, w, h).to_image();
                let worst = part.pixels().zip(want.pixels()).flat_map(|(a, b)| (0..3).map(move |i| (a[i] as i32 - b[i] as i32).abs())).max().unwrap();
                assert!(worst <= 3, "{r:?} window {x},{y} differs from the full render by {worst}");
            }
        }
    }
}

#[cfg(test)]
mod timing {
    use super::*;
    use image::ImageBuffer;

    /// What the process holds in memory now, in KB (Linux only; elsewhere None, and the memory check is skipped).
    fn resident_kb() -> Option<u64> {
        let s = std::fs::read_to_string("/proc/self/status").ok()?;
        s.lines().find(|l| l.starts_with("VmRSS:"))?.split_whitespace().nth(1)?.parse().ok()
    }

    /// An editing session of many slider moves on one picture (the 1100 px preview the sliders drag over): a render must not get slower,
    /// and the memory the program holds must not keep growing. The budgets are loose (a slow computer passes); a real leak or a slow
    /// build-up fails. "Hours of editing" is many thousands of these; this is a few hundred, with every kind of edit in the mix.
    #[test]
    fn stays_fast_and_does_not_grow_over_a_long_editing_session() {
        let img: RgbImage = image::ImageBuffer::from_fn(1100, 733, |x, y| Rgb([(x % 251) as u8, (y % 241) as u8, ((x + y) % 239) as u8]));
        let mut seed = 12345u32;
        let mut next = move || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / 16_777_216.0 // 0..1
        };
        let mut times: Vec<std::time::Duration> = Vec::new();
        let recipe = |n: &mut dyn FnMut() -> f32| {
            let s = |n: &mut dyn FnMut() -> f32, a: f32| (n() * 2.0 - 1.0) * a;
            let mut r = Recipe { exposure: s(n, 1.5), contrast: s(n, 60.0), highlights: s(n, 60.0), shadows: s(n, 60.0), vibrance: s(n, 50.0), saturation: s(n, 40.0), temperature: s(n, 30.0), ..Default::default() };
            if n() > 0.5 {
                r.curve = vec![[64.0, 64.0 + s(n, 30.0)], [192.0, 192.0 + s(n, 30.0)]];
            }
            if n() > 0.6 {
                r.curve_red = vec![[128.0, 128.0 + s(n, 25.0)]];
                r.parametric.lights = s(n, 60.0);
            }
            if n() > 0.7 {
                r.hsl.sat[0] = s(n, 40.0);
                r.hsl.hue[3] = s(n, 30.0);
            }
            if n() > 0.7 {
                r.texture = s(n, 40.0);
                r.clarity = s(n, 40.0);
            }
            r
        };
        let rounds = 240usize;
        let mut rss_after_warmup = None;
        for i in 0..rounds {
            let r = recipe(&mut next);
            let t = std::time::Instant::now();
            let out = render(&img, &r);
            times.push(t.elapsed());
            assert_eq!(out.dimensions(), img.dimensions());
            if i == 20 {
                rss_after_warmup = resident_kb();
            }
        }
        // the fastest tenth of each quarter: other work on the computer (other tests, a virus scan) makes single renders slower, but it
        // cannot make the fastest ones faster, so a real slowing-down shows here and a busy moment does not
        let quick = |v: &[std::time::Duration]| {
            let mut v = v.to_vec();
            v.sort();
            v[..(v.len() / 10).max(1)].iter().sum::<std::time::Duration>() / (v.len() / 10).max(1) as u32
        };
        let quarter = rounds / 4;
        let (m_first, m_last) = (quick(&times[..quarter]), quick(&times[rounds - quarter..]));
        eprintln!("session: fastest renders {m_first:?} at the start, {m_last:?} at the end");
        assert!(m_first < std::time::Duration::from_millis(800), "a slider update is too slow: {m_first:?}");
        assert!(m_last < m_first * 2 + std::time::Duration::from_millis(20), "renders got slower over the session: {m_first:?} then {m_last:?}");
        // the memory of the whole test program is measured, and the other tests run beside this one, so the check only means something when this one runs
        // alone: cargo test stays_fast -- --test-threads=1
        let alone = std::env::args().any(|a| a == "--test-threads=1") || std::env::var("RUST_TEST_THREADS").map(|v| v == "1").unwrap_or(false);
        if let (true, Some(a), Some(b)) = (alone, rss_after_warmup, resident_kb()) {
            assert!(b < a + 80_000, "memory kept growing: {a} KB after warm-up, {b} KB after {rounds} edits");
        }
    }

    /// Prints how long a 2048 px render takes. Run: cargo test render_speed -- --nocapture --ignored
    #[test]
    #[ignore]
    fn render_speed() {
        let img: RgbImage = ImageBuffer::from_fn(2048, 1365, |x, y| Rgb([(x % 251) as u8, (y % 241) as u8, ((x + y) % 239) as u8]));
        let r = Recipe { exposure: 0.5, contrast: 20.0, highlights: -30.0, saturation: 10.0, ..Default::default() };
        let d = img.clone();
        let t = std::time::Instant::now();
        let n = 5;
        for _ in 0..n {
            let _ = render(&d, &r);
        }
        eprintln!("tone render, 2048x1365: {:?} each", t.elapsed() / n);
        let mut mixer = r.clone();
        mixer.hsl.sat[0] = -30.0;
        mixer.hsl.hue[3] = 20.0;
        mixer.curve = vec![[128.0, 150.0]];
        let t = std::time::Instant::now();
        for _ in 0..n {
            let _ = render(&d, &mixer);
        }
        eprintln!("tone + curve + colour mixer render: {:?} each", t.elapsed() / n);
        for (name, det) in [
            ("sharpen", Detail { sharp_amount: 60.0, ..Default::default() }),
            ("luma NR", Detail { nr_luma: 50.0, ..Default::default() }),
            ("colour NR", Detail { nr_colour: 50.0, ..Default::default() }),
            ("sharpen + both NR", Detail { sharp_amount: 60.0, nr_luma: 50.0, nr_colour: 50.0, ..Default::default() }),
        ] {
            let small = image::imageops::resize(&img, 1100, 733, image::imageops::FilterType::Triangle);
            let t = std::time::Instant::now();
            for _ in 0..n {
                let _ = apply_detail(&img, &det);
            }
            let full = t.elapsed() / n;
            let t = std::time::Instant::now();
            for _ in 0..n {
                let _ = apply_detail(&small, &det);
            }
            eprintln!("detail {name}: {:?} at 2048 px, {:?} at 1100 px", full, t.elapsed() / n);
        }
        let fx = Effects { vignette_amount: -50.0, grain_amount: 50.0, ..Default::default() };
        let small = image::imageops::resize(&img, 1100, 733, image::imageops::FilterType::Triangle);
        let t = std::time::Instant::now();
        for _ in 0..n {
            let _ = apply_effects(&img, &fx, 0, 0, 2048, 1365);
        }
        let full = t.elapsed() / n;
        let t = std::time::Instant::now();
        for _ in 0..n {
            let _ = apply_effects(&small, &fx, 0, 0, 1100, 733);
        }
        eprintln!("effects vignette + grain: {:?} at 2048 px, {:?} at 1100 px", full, t.elapsed() / n);
        let t = std::time::Instant::now();
        for _ in 0..n {
            let _ = auto_settings(&img);
        }
        eprintln!("auto settings: {:?}", t.elapsed() / n);
        {
            use crate::masks::{LocalAdjust, Shape, Stroke};
            let m = |id: &str, shape: Shape, adjust: LocalAdjust| Mask { id: id.into(), name: id.into(), visible: true, invert: false, parts: Vec::new(), shape, adjust };
            let exp = LocalAdjust { exposure: 0.5, saturation: 20.0, ..Default::default() };
            let two = Recipe { masks: vec![
                m("a", Shape::Linear { x1: 0.5, y1: 0.0, x2: 0.5, y2: 0.6, feather: 0.6 }, exp.clone()),
                m("b", Shape::Radial { cx: 0.5, cy: 0.5, rx: 0.25, ry: 0.15, angle: 0.0, feather: 0.5 }, exp.clone()),
            ], ..Default::default() };
            let stroke = Stroke { size: 0.12, feather: 0.5, flow: 0.8, points: (0..60).map(|i| [0.1 + i as f32 * 0.013, 0.5 + (i as f32 * 0.2).sin() * 0.2]).collect(), ..Default::default() };
            let brush = Recipe { masks: vec![m("c", Shape::Brush { strokes: vec![stroke.clone(), stroke.clone(), stroke] }, exp.clone())], ..Default::default() };
            let sharp = Recipe { masks: vec![m("d", Shape::Radial { cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, angle: 0.0, feather: 0.5 }, LocalAdjust { sharpness: 60.0, noise: 40.0, ..Default::default() })], ..Default::default() };
            let small = image::imageops::resize(&img, 1100, 733, image::imageops::FilterType::Triangle);
            for (name, r) in [("two gradients", &two), ("brush, 3 strokes", &brush), ("local sharpness and noise", &sharp)] {
                let t = std::time::Instant::now();
                for _ in 0..n { let _ = render(&img, r); }
                let full = t.elapsed() / n;
                let t = std::time::Instant::now();
                for _ in 0..n { let _ = render(&small, r); }
                eprintln!("masks {name}: {:?} at 2048 px, {:?} at 1100 px", full, t.elapsed() / n);
            }
        }
        {
            // what a mouse really records: a point every few pixels, a sweep across the whole picture
            use crate::masks::{LocalAdjust, Shape, Stroke};
            let sweep = |size: f32, n_points: usize| Stroke { size, feather: 0.5, flow: 0.8, points: (0..n_points).map(|i| { let t = i as f32 / n_points as f32; [0.05 + t * 0.9, 0.5 + (t * 12.0).sin() * 0.25] }).collect(), ..Default::default() };
            let small = image::imageops::resize(&img, 1100, 733, image::imageops::FilterType::Triangle);
            for (size, pts) in [(0.08f32, 400usize), (0.2, 400), (0.4, 400), (0.2, 1500)] {
                let r = Recipe { masks: vec![Mask { id: "b".into(), name: "b".into(), visible: true, invert: false, parts: Vec::new(), shape: Shape::Brush { strokes: vec![sweep(size, pts), sweep(size, pts)] }, adjust: LocalAdjust { exposure: 0.5, ..Default::default() } }], ..Default::default() };
                let t = std::time::Instant::now();
                let _ = render(&img, &r);
                let full = t.elapsed();
                let t = std::time::Instant::now();
                let _ = render(&small, &r);
                eprintln!("real brush, size {size}, {pts} points x2 strokes: {:?} at 2048 px, {:?} at 1100 px", full, t.elapsed());
            }
        }
        {
            use crate::spots::{Spot, SpotMode};
            let small = image::imageops::resize(&img, 1100, 733, image::imageops::FilterType::Triangle);
            let spots = |n: usize, size: f32, mode: SpotMode| -> Recipe {
                Recipe { spots: (0..n).map(|i| Spot { id: format!("s{i}"), visible: true, mode, x: 0.1 + (i % 10) as f32 * 0.08, y: 0.15 + (i / 10) as f32 * 0.14, sx: 0.15 + (i % 10) as f32 * 0.08, sy: 0.3 + (i / 10) as f32 * 0.14, size, feather: 0.5, opacity: 1.0 }).collect(), ..Default::default() }
            };
            for (name, r) in [("10 small heal spots", spots(10, 0.03, SpotMode::Heal)), ("50 medium heal spots", spots(50, 0.06, SpotMode::Heal)), ("5 very large heal spots", spots(5, 0.3, SpotMode::Heal)), ("50 medium clone spots", spots(50, 0.06, SpotMode::Clone))] {
                let t = std::time::Instant::now();
                let _ = render(&img, &r);
                let full = t.elapsed();
                let t = std::time::Instant::now();
                let _ = render(&small, &r);
                eprintln!("spots {name}: {:?} at 2048 px, {:?} at 1100 px", full, t.elapsed());
            }
            let t = std::time::Instant::now();
            let _ = crate::spots::suggest_source(&img, 0.5, 0.5, 0.06);
            eprintln!("spots source suggestion: {:?}", t.elapsed());
        }
        {
            use crate::masks::{LocalAdjust, Op, Part, Shape};
            let small = image::imageops::resize(&img, 1100, 733, image::imageops::FilterType::Triangle);
            let exp = LocalAdjust { exposure: 0.6, ..Default::default() };
            let mk = |shape: Shape, parts: Vec<Part>| Recipe { masks: vec![Mask { id: "m".into(), name: "m".into(), visible: true, invert: false, parts, shape, adjust: exp.clone() }], ..Default::default() };
            let radial = || Shape::Radial { cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.2, angle: 0.0, feather: 0.5 };
            for (name, r) in [
                ("luminance range alone", mk(Shape::Luminance { lo: 0.5, hi: 1.0, smooth: 0.3 }, vec![])),
                ("colour range alone", mk(Shape::Colour { hue: 30.0, range: 40.0, sat: 0.2, smooth: 0.4 }, vec![])),
                ("radial intersect luminance", mk(radial(), vec![Part { op: Op::Intersect, shape: Shape::Luminance { lo: 0.5, hi: 1.0, smooth: 0.3 } }])),
                ("radial plus 5 parts", mk(radial(), (0..5).map(|i| Part { op: if i % 2 == 0 { Op::Add } else { Op::Subtract }, shape: Shape::Radial { cx: 0.2 + i as f32 * 0.15, cy: 0.5, rx: 0.1, ry: 0.1, angle: 0.0, feather: 0.5 } }).collect())),
            ] {
                let t = std::time::Instant::now();
                let _ = render(&img, &r);
                let full = t.elapsed();
                let t = std::time::Instant::now();
                let _ = render(&small, &r);
                eprintln!("masks {name}: {:?} at 2048 px, {:?} at 1100 px", full, t.elapsed());
            }
        }
        let rc = Recipe { crop: Crop { aspect: "3:2".into(), angle: 3.0, rect: None }, ..r.clone() };
        let t = std::time::Instant::now();
        for _ in 0..n {
            let _ = render(&d, &rc);
        }
        eprintln!("tone + straighten render: {:?} each", t.elapsed() / n);
        let t = std::time::Instant::now();
        let mut jpg = Vec::new();
        let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 88);
        image::DynamicImage::ImageRgb8(img.clone()).write_with_encoder(enc).unwrap();
        eprintln!("jpeg encode: {:?} ({} bytes)", t.elapsed(), jpg.len());
        let t = std::time::Instant::now();
        let mut bmp = Vec::new();
        image::DynamicImage::ImageRgb8(img).write_to(&mut std::io::Cursor::new(&mut bmp), image::ImageFormat::Bmp).unwrap();
        eprintln!("bmp encode: {:?} ({} bytes)", t.elapsed(), bmp.len());
    }
}

#[cfg(test)]
mod auto_on_real_photos {
    use super::*;

    /// Prints what Auto tone does to the photographs in the folder named by LUCENT_CC0_DIR (01.jpg, 02.jpg ...). Run by hand:
    /// LUCENT_CC0_DIR=... cargo test --lib auto_on_real_photos -- --ignored --nocapture
    #[test]
    #[ignore]
    fn show_what_auto_tone_does() {
        let Ok(dir) = std::env::var("LUCENT_CC0_DIR") else { return };
        let med = |img: &RgbImage| {
            let mut v: Vec<u8> = img.pixels().map(|p| (0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32) as u8).collect();
            v.sort_unstable();
            (v[v.len() / 20], v[v.len() / 2], v[v.len() * 19 / 20])
        };
        let (mut changed, mut total) = (0, 0);
        for i in 1..=24 {
            let Ok(img) = image::open(format!("{dir}/{i:02}.jpg")) else { continue };
            let img = img.to_rgb8();
            let a = auto_settings(&img);
            let r = Recipe { exposure: a.exposure, contrast: a.contrast, highlights: a.highlights, shadows: a.shadows, whites: a.whites, blacks: a.blacks, ..Default::default() };
            let after = apply_tone(&img, &r);
            let (b, a2) = (med(&img), med(&after));
            total += 1;
            if a.exposure != 0.0 || a.contrast != 0.0 || a.highlights != 0.0 || a.shadows != 0.0 || a.whites != 0.0 || a.blacks != 0.0 {
                changed += 1;
            }
            println!("{i:02} exp {:+.1} con {:+.0} hi {:+.0} sh {:+.0} wh {:+.0} bl {:+.0} | p5/med/p95 {:?} -> {:?}", a.exposure, a.contrast, a.highlights, a.shadows, a.whites, a.blacks, b, a2);
        }
        println!("{changed} of {total} photographs were changed at all");
    }
}

#[cfg(test)]
mod lightroom_reference {
    use super::*;

    /// Writes the measures of every photograph that has a Lightroom sidecar to the CSV named by LUCENT_LR_CSV, so Auto tone can be
    /// compared with what Lightroom's Auto did to the same photographs. Run by hand:
    /// LUCENT_LR_DIR=... LUCENT_LR_CSV=... cargo test --lib lightroom_reference -- --ignored
    #[test]
    #[ignore]
    fn measure_the_photographs_with_a_lightroom_sidecar() {
        let (Ok(dir), Ok(out)) = (std::env::var("LUCENT_LR_DIR"), std::env::var("LUCENT_LR_CSV")) else { return };
        let mut csv = String::from("file,p005,p05,p25,p50,p75,p95,p995,blown,crushed,mean,sat,r,g,b,w,h\n");
        let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().map(|x| x.eq_ignore_ascii_case("cr2")).unwrap_or(false)).collect();
        names.sort();
        for p in names {
            let sidecar = p.with_extension("xmp");
            let Ok(text) = std::fs::read_to_string(&sidecar) else { continue };
            if !text.contains("crs:Exposure2012") {
                continue;
            }
            let Ok(img) = crate::media::edited_picture(&p, 2048, None) else { continue };
            let img = img.to_rgb8();
            let n = (img.width() * img.height()) as f32;
            let mut h = [0u32; 256];
            let (mut sat, mut rs, mut gs, mut bs, mut sum) = (0f64, 0f64, 0f64, 0f64, 0f64);
            for px in img.pixels() {
                let y = (0.2126 * px[0] as f32 + 0.7152 * px[1] as f32 + 0.0722 * px[2] as f32).round() as usize;
                h[y.min(255)] += 1;
                sum += y as f64;
                let (mx, mn) = (px[0].max(px[1]).max(px[2]) as f64, px[0].min(px[1]).min(px[2]) as f64);
                sat += if mx > 0.0 { (mx - mn) / mx } else { 0.0 };
                rs += px[0] as f64;
                gs += px[1] as f64;
                bs += px[2] as f64;
            }
            let pct = |q: f32| {
                let goal = (n * q) as u32;
                let mut run = 0;
                for (v, c) in h.iter().enumerate() {
                    run += c;
                    if run > goal {
                        return v;
                    }
                }
                255
            };
            let blown = h[253..].iter().sum::<u32>() as f32 / n;
            let crushed = h[..=2].iter().sum::<u32>() as f32 / n;
            csv += &format!(
                "{},{},{},{},{},{},{},{},{:.4},{:.4},{:.1},{:.3},{:.1},{:.1},{:.1},{},{}\n",
                p.file_stem().unwrap().to_string_lossy(),
                pct(0.005), pct(0.05), pct(0.25), pct(0.5), pct(0.75), pct(0.95), pct(0.995), blown, crushed, sum / n as f64, sat / n as f64,
                rs / n as f64, gs / n as f64, bs / n as f64, img.width(), img.height()
            );
        }
        std::fs::write(out, csv).unwrap();
    }
}

#[cfg(test)]
mod auto_before_after {
    use super::*;

    /// Writes before and after side by side for the named photographs: LUCENT_LR_DIR (the folder), LUCENT_BA_NAMES (comma separated
    /// names without the extension), LUCENT_BA_OUT (where the JPEGs go). Run by hand.
    #[test]
    #[ignore]
    fn render_before_and_after() {
        let (Ok(dir), Ok(names), Ok(out)) = (std::env::var("LUCENT_LR_DIR"), std::env::var("LUCENT_BA_NAMES"), std::env::var("LUCENT_BA_OUT")) else { return };
        for name in names.split(',') {
            let path = std::path::Path::new(&dir).join(format!("{name}.CR2"));
            let img = crate::media::edited_picture(&path, 900, None).unwrap().to_rgb8();
            let a = auto_settings(&img);
            let k: f32 = std::env::var("LUCENT_BA_SCALE").ok().and_then(|v| v.parse().ok()).unwrap_or(1.0);
            let r = Recipe { exposure: a.exposure, contrast: a.contrast * k, highlights: a.highlights * k, shadows: a.shadows * k, whites: a.whites * k, blacks: a.blacks * k, vibrance: a.vibrance * k, ..Default::default() };
            let after = apply_tone(&img, &r);
            let mut both = RgbImage::new(img.width() * 2 + 10, img.height());
            image::imageops::replace(&mut both, &img, 0, 0);
            image::imageops::replace(&mut both, &after, img.width() as i64 + 10, 0);
            both.save(std::path::Path::new(&out).join(format!("{name}.jpg"))).unwrap();
            println!("{name}: {a:?}");
        }
    }
}
