//! Masks: a shape that limits a set of adjustments to part of the picture.
//!
//! Positions are fractions (0 to 1) of the cropped picture, so a mask means the same thing at any
//! size. A mask becomes a soft map of weights from 0 to 1, and the adjusted picture is blended in
//! through it. Everything is computed from absolute positions in the whole picture, so a window of
//! it (the 1:1 view) gets exactly the weights the whole picture would.

use crate::develop::{apply_detail_scaled, apply_tone, par_bands, rgb_to_hsl, smoothstep, Detail, Recipe};
use image::RgbImage;
use serde::{Deserialize, Serialize};

pub const MAX_MASKS: usize = 10;
pub const MAX_STROKES: usize = 200;
pub const MAX_STROKE_POINTS: usize = 20_000;
/// Shapes that can be combined with a mask's first shape.
pub const MAX_PARTS: usize = 6;

fn yes() -> bool {
    true
}

/// The adjustments a mask applies. All zero means the mask does nothing.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LocalAdjust {
    pub exposure: f32, // -5..5 stops
    pub contrast: f32, // -100..100 from here down
    pub highlights: f32,
    pub shadows: f32,
    pub saturation: f32,
    pub temperature: f32,
    pub sharpness: f32, // 0..100
    pub noise: f32,     // 0..100, luminance noise reduction
    /// 0..100: how much the part under the mask is blurred (up to a blur about 1% of the picture's long edge across), for a lens blur
    pub blur: f32,
}

impl LocalAdjust {
    pub fn is_zero(&self) -> bool {
        [self.exposure, self.contrast, self.highlights, self.shadows, self.saturation, self.temperature, self.sharpness, self.noise, self.blur].iter().all(|v| v.abs() < 1e-4)
    }

    /// Does this need the slower sharpen and noise pass?
    pub fn needs_detail(&self) -> bool {
        self.sharpness.abs() >= 0.5 || self.noise.abs() >= 0.5
    }

    fn sanitized(&self) -> LocalAdjust {
        let c = |v: f32, lo: f32, hi: f32| if v.is_finite() { v.clamp(lo, hi) } else { 0.0 };
        LocalAdjust {
            exposure: c(self.exposure, -5.0, 5.0),
            contrast: c(self.contrast, -100.0, 100.0),
            highlights: c(self.highlights, -100.0, 100.0),
            shadows: c(self.shadows, -100.0, 100.0),
            saturation: c(self.saturation, -100.0, 100.0),
            temperature: c(self.temperature, -100.0, 100.0),
            sharpness: c(self.sharpness, 0.0, 100.0),
            noise: c(self.noise, 0.0, 100.0),
            blur: c(self.blur, 0.0, 100.0),
        }
    }

    /// The tone part, as a recipe the ordinary tone pass can run.
    fn tone_recipe(&self) -> Recipe {
        Recipe {
            exposure: self.exposure,
            contrast: self.contrast,
            highlights: self.highlights,
            shadows: self.shadows,
            saturation: self.saturation,
            temperature: self.temperature,
            ..Default::default()
        }
    }
}

/// One brush stroke. Points are fractions of the picture; the size is a fraction of its long edge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Stroke {
    pub erase: bool,
    pub size: f32,    // 0.005..0.5
    pub feather: f32, // 0..1, how much of the radius is soft
    pub flow: f32,    // 0..1, how much each pass adds
    pub points: Vec<[f32; 2]>,
}

impl Default for Stroke {
    fn default() -> Self {
        Stroke { erase: false, size: 0.08, feather: 0.5, flow: 1.0, points: Vec::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Shape {
    /// Full effect at (x1, y1), none at (x2, y2). `feather` 0 is a hard edge, 1 fades over the whole distance.
    #[serde(rename_all = "camelCase")]
    Linear { x1: f32, y1: f32, x2: f32, y2: f32, feather: f32 },
    /// An ellipse around (cx, cy). The radii are fractions of the long edge, `angle` is in degrees.
    #[serde(rename_all = "camelCase")]
    Radial { cx: f32, cy: f32, rx: f32, ry: f32, angle: f32, feather: f32 },
    Brush { strokes: Vec<Stroke> },
    /// Wherever the picture's brightness (0..1) is between `lo` and `hi`, fading over `smooth` (0..1) beyond them.
    /// It has no place of its own, so on its own it covers the whole picture; combined, it narrows or widens another shape.
    #[serde(rename_all = "camelCase")]
    Luminance { lo: f32, hi: f32, smooth: f32 },
    /// Wherever the colour is within `range` degrees of `hue` and has at least `sat` (0..1) colour in it.
    #[serde(rename_all = "camelCase")]
    Colour { hue: f32, range: f32, sat: f32, smooth: f32 },
    /// The main subject of the picture, found by the subject model when the mask was made. `map` is its answer as a small grey
    /// picture (see subject.rs). Invert the mask for the background. No usable map covers nothing.
    Subject { map: String },
    /// Where the picture is between two distances, found by the depth model when the mask was made: `map` is its answer as a small grey
    /// picture (white near, black far, see depth.rs); `near` and `far` (0 to 1) are the ends of the range and `smooth` (0 to 1) how far it fades.
    #[serde(rename_all = "camelCase")]
    Depth { map: String, near: f32, far: f32, smooth: f32 },
    /// The sky, found from the colours and where they are in the picture: blue, and bright cloud near the top. `sensitivity`
    /// 0 to 1: higher takes in more.
    #[serde(rename_all = "camelCase")]
    Sky { sensitivity: f32 },
}

/// How a further shape is combined with what the mask covers so far.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Op {
    /// Cover this as well.
    Add,
    /// Take this out.
    Subtract,
    /// Keep only where this also covers.
    Intersect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Part {
    pub op: Op,
    pub shape: Shape,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mask {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "yes")]
    pub visible: bool,
    #[serde(default)]
    pub invert: bool,
    pub shape: Shape,
    /// More shapes, combined one after another with the first. Empty for a simple mask.
    #[serde(default)]
    pub parts: Vec<Part>,
    #[serde(default)]
    pub adjust: LocalAdjust,
}

fn sanitize_shape(shape: &Shape) -> Shape {
    let f = |v: f32, lo: f32, hi: f32, d: f32| if v.is_finite() { v.clamp(lo, hi) } else { d };
    let pos = |v: f32| f(v, -1.0, 2.0, 0.5);
    match shape {
        Shape::Linear { x1, y1, x2, y2, feather } => Shape::Linear { x1: pos(*x1), y1: pos(*y1), x2: pos(*x2), y2: pos(*y2), feather: f(*feather, 0.0, 1.0, 0.5) },
        Shape::Radial { cx, cy, rx, ry, angle, feather } => Shape::Radial {
            cx: pos(*cx),
            cy: pos(*cy),
            rx: f(*rx, 0.005, 2.0, 0.2),
            ry: f(*ry, 0.005, 2.0, 0.2),
            angle: f(*angle, -180.0, 180.0, 0.0),
            feather: f(*feather, 0.0, 1.0, 0.5),
        },
        Shape::Brush { strokes } => {
            let mut budget = MAX_STROKE_POINTS;
            let strokes = strokes
                .iter()
                .take(MAX_STROKES)
                .map_while(|s| {
                    if budget == 0 {
                        return None;
                    }
                    let points: Vec<[f32; 2]> = s.points.iter().filter(|p| p[0].is_finite() && p[1].is_finite()).take(budget).map(|p| [pos(p[0]), pos(p[1])]).collect();
                    budget -= points.len();
                    Some(Stroke { erase: s.erase, size: f(s.size, 0.005, 0.5, 0.08), feather: f(s.feather, 0.0, 1.0, 0.5), flow: f(s.flow, 0.0, 1.0, 1.0), points })
                })
                .collect();
            Shape::Brush { strokes }
        }
        Shape::Luminance { lo, hi, smooth } => {
            let (lo, hi) = (f(*lo, 0.0, 1.0, 0.0), f(*hi, 0.0, 1.0, 1.0));
            // a low end above the high end would select nothing: put them in order
            Shape::Luminance { lo: lo.min(hi), hi: lo.max(hi), smooth: f(*smooth, 0.0, 1.0, 0.5) }
        }
        Shape::Colour { hue, range, sat, smooth } => Shape::Colour { hue: f(*hue, 0.0, 360.0, 0.0), range: f(*range, 1.0, 180.0, 30.0), sat: f(*sat, 0.0, 1.0, 0.2), smooth: f(*smooth, 0.0, 1.0, 0.5) },
        // a map that is too long, or not a small grey picture, is dropped here so that it covers nothing
        Shape::Subject { map } => Shape::Subject { map: if crate::subject::decode(map).is_some() { map.clone() } else { String::new() } },
        Shape::Sky { sensitivity } => Shape::Sky { sensitivity: f(*sensitivity, 0.0, 1.0, 0.5) },
        Shape::Depth { map, near, far, smooth } => {
            let (a, b) = (f(*near, 0.0, 1.0, 0.0), f(*far, 0.0, 1.0, 1.0));
            Shape::Depth { map: if crate::subject::decode(map).is_some() { map.clone() } else { String::new() }, near: a.min(b), far: a.max(b), smooth: f(*smooth, 0.0, 1.0, 0.3) }
        }
    }
}

impl Mask {
    fn sanitized(&self) -> Mask {
        Mask {
            id: self.id.chars().take(64).collect(),
            name: self.name.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(100).collect(),
            visible: self.visible,
            invert: self.invert,
            shape: sanitize_shape(&self.shape),
            parts: self.parts.iter().take(MAX_PARTS).map(|p| Part { op: p.op, shape: sanitize_shape(&p.shape) }).collect(),
            adjust: self.adjust.sanitized(),
        }
    }
}

/// Clean the masks of a recipe: at most MAX_MASKS, unique ids, every value in range.
pub fn sanitize_masks(masks: &[Mask]) -> Vec<Mask> {
    let mut seen = std::collections::HashSet::new();
    masks
        .iter()
        .map(Mask::sanitized)
        .filter(|m| !m.id.is_empty() && seen.insert(m.id.clone()))
        .take(MAX_MASKS)
        .collect()
}

/// A mask that changes the picture (visible, with some adjustment). Hidden or empty masks are skipped.
fn is_active(m: &Mask) -> bool {
    m.visible && !m.adjust.is_zero()
}

pub fn any_needs_detail(masks: &[Mask]) -> bool {
    masks.iter().any(|m| is_active(m) && m.adjust.needs_detail())
}

/// Weights (0..1) for the window of `w` by `h` pixels that starts at (ox, oy) of a picture `fw` by `fh`, with no
/// picture to look at: a range shape then covers everything.
pub fn mask_weights(mask: &Mask, ox: u32, oy: u32, w: u32, h: u32, fw: u32, fh: u32) -> Vec<f32> {
    mask_weights_with(mask, ox, oy, w, h, fw, fh, None)
}

/// The weights of a whole mask: its first shape, then each further shape combined in order, then the invert.
/// `img` is the window's pixels, which the range shapes read.
#[allow(clippy::too_many_arguments)]
pub fn mask_weights_with(mask: &Mask, ox: u32, oy: u32, w: u32, h: u32, fw: u32, fh: u32, img: Option<&RgbImage>) -> Vec<f32> {
    let mut out = shape_weights(&mask.shape, ox, oy, w, h, fw, fh, img);
    for part in &mask.parts {
        let next = shape_weights(&part.shape, ox, oy, w, h, fw, fh, img);
        for (o, n) in out.iter_mut().zip(&next) {
            *o = match part.op {
                Op::Add => *o + n - *o * n,
                Op::Subtract => *o * (1.0 - n),
                Op::Intersect => *o * n,
            };
        }
    }
    if mask.invert {
        for v in out.iter_mut() {
            *v = 1.0 - *v;
        }
    }
    out
}

/// 1 between `lo` and `hi`, fading to 0 over `smooth` outside them; a hard window when `smooth` is 0.
fn window01(v: f32, lo: f32, hi: f32, smooth: f32) -> f32 {
    if smooth <= 0.0 {
        return (v >= lo && v <= hi) as u8 as f32;
    }
    smoothstep(lo - smooth, lo, v) * (1.0 - smoothstep(hi, hi + smooth, v))
}

/// The weights of one shape (before any invert).
#[allow(clippy::too_many_arguments)]
fn shape_weights(shape: &Shape, ox: u32, oy: u32, w: u32, h: u32, fw: u32, fh: u32, img: Option<&RgbImage>) -> Vec<f32> {
    let (wu, hu) = (w as usize, h as usize);
    let long = fw.max(fh) as f32;
    let mut out = vec![0.0f32; wu * hu];
    match shape {
        Shape::Linear { x1, y1, x2, y2, feather } => {
            let (p1x, p1y, p2x, p2y) = (x1 * fw as f32, y1 * fh as f32, x2 * fw as f32, y2 * fh as f32);
            let (dx, dy) = (p2x - p1x, p2y - p1y);
            let len2 = dx * dx + dy * dy;
            let (lo, hi) = (0.5 - 0.5 * feather, 0.5 + 0.5 * feather);
            par_bands(&mut out, wu, |row0, band| {
                for (ry, row) in band.chunks_exact_mut(wu).enumerate() {
                    let py = (oy as usize + row0 + ry) as f32 + 0.5;
                    for (x, v) in row.iter_mut().enumerate() {
                        let px = (ox as usize + x) as f32 + 0.5;
                        *v = if len2 < 1.0 { 1.0 } else { 1.0 - smoothstep(lo, hi, ((px - p1x) * dx + (py - p1y) * dy) / len2) };
                    }
                }
            });
        }
        Shape::Radial { cx, cy, rx, ry, angle, feather } => {
            let (cxp, cyp) = (cx * fw as f32, cy * fh as f32);
            let (rxp, ryp) = ((rx * long).max(1.0), (ry * long).max(1.0));
            let (sin, cos) = angle.to_radians().sin_cos();
            let inner = 1.0 - feather;
            par_bands(&mut out, wu, |row0, band| {
                for (r, row) in band.chunks_exact_mut(wu).enumerate() {
                    let dy = (oy as usize + row0 + r) as f32 + 0.5 - cyp;
                    for (x, v) in row.iter_mut().enumerate() {
                        let dx = (ox as usize + x) as f32 + 0.5 - cxp;
                        let (u, t) = (dx * cos + dy * sin, -dx * sin + dy * cos);
                        let d = ((u / rxp).powi(2) + (t / ryp).powi(2)).sqrt();
                        *v = 1.0 - smoothstep(inner, 1.0, d);
                    }
                }
            });
        }
        Shape::Brush { strokes } => {
            // Painting the strokes is the costly part and the strokes rarely change while a slider moves, so
            // the finished map is remembered for the next render.
            let key = brush_key(strokes, ox, oy, w, h, fw, fh);
            if let Some(hit) = brush_cache_get(key) {
                out.copy_from_slice(&hit);
            } else {
                let stamps: Vec<Stamp> = strokes.iter().flat_map(|s| stroke_stamps(s, ox, oy, fw, fh, long)).collect();
                paint_stamps(&mut out, &stamps, wu, hu);
                brush_cache_put(key, &out);
            }
        }
        Shape::Luminance { lo, hi, smooth } => match img {
            // the fade is a fraction of the whole brightness range, so "smooth" 1 reaches a long way
            Some(img) => {
                let (src, fade) = (img.as_raw(), smooth * 0.3);
                par_bands(&mut out, wu, |row0, band| {
                    for (ry, row) in band.chunks_exact_mut(wu).enumerate() {
                        for (x, v) in row.iter_mut().enumerate() {
                            let i = ((row0 + ry) * wu + x) * 3;
                            let l = (0.2126 * src[i] as f32 + 0.7152 * src[i + 1] as f32 + 0.0722 * src[i + 2] as f32) / 255.0;
                            *v = window01(l, *lo, *hi, fade);
                        }
                    }
                });
            }
            None => out.fill(1.0),
        },
        Shape::Colour { hue, range, sat, smooth } => match img {
            Some(img) => {
                let src = img.as_raw();
                par_bands(&mut out, wu, |row0, band| {
                    for (ry, row) in band.chunks_exact_mut(wu).enumerate() {
                        for (x, v) in row.iter_mut().enumerate() {
                            let i = ((row0 + ry) * wu + x) * 3;
                            let (h, s, _) = rgb_to_hsl([src[i] as f32 / 255.0, src[i + 1] as f32 / 255.0, src[i + 2] as f32 / 255.0]);
                            let d = (h - hue).abs().rem_euclid(360.0);
                            let d = d.min(360.0 - d); // round the colour wheel
                            let near = 1.0 - smoothstep(range * (1.0 - smooth), *range, d);
                            // grey has no colour to select: it needs some saturation, and more when asked for
                            let coloured = smoothstep((sat * 0.6).max(0.02), sat.max(0.04), s);
                            *v = near * coloured;
                        }
                    }
                });
            }
            None => out.fill(1.0),
        },
        Shape::Subject { map } => {
            if let Some(g) = crate::subject::decode(map) {
                par_bands(&mut out, wu, |row0, band| {
                    for (ry, row) in band.chunks_exact_mut(wu).enumerate() {
                        let fy = ((oy as usize + row0 + ry) as f32 + 0.5) / fh as f32;
                        for (x, v) in row.iter_mut().enumerate() {
                            *v = crate::subject::sample(&g, ((ox as usize + x) as f32 + 0.5) / fw as f32, fy);
                        }
                    }
                });
            }
        }
        Shape::Depth { map, near, far, smooth } => {
            // the range is of nearness: 0 is the farthest and 1 the nearest thing in the picture
            if let Some(g) = crate::subject::decode(map) {
                let fade = smooth * 0.3;
                par_bands(&mut out, wu, |row0, band| {
                    for (ry, row) in band.chunks_exact_mut(wu).enumerate() {
                        let fy = ((oy as usize + row0 + ry) as f32 + 0.5) / fh as f32;
                        for (x, v) in row.iter_mut().enumerate() {
                            *v = window01(crate::depth::sample(&g, ((ox as usize + x) as f32 + 0.5) / fw as f32, fy), *near, *far, fade);
                        }
                    }
                });
            }
        }
        Shape::Sky { sensitivity } => {
            if let Some(img) = img {
                let src = img.as_raw();
                let t = 0.7 - 0.5 * sensitivity;
                par_bands(&mut out, wu, |row0, band| {
                    for (ry, row) in band.chunks_exact_mut(wu).enumerate() {
                        let fy = ((oy as usize + row0 + ry) as f32 + 0.5) / fh as f32;
                        // low in the picture is rarely sky: blue water and clothes are left out more and more
                        let prior = 1.0 - smoothstep(0.6, 0.95, fy);
                        for (x, v) in row.iter_mut().enumerate() {
                            let i = ((row0 + ry) * wu + x) * 3;
                            let (h, s, l) = rgb_to_hsl([src[i] as f32 / 255.0, src[i + 1] as f32 / 255.0, src[i + 2] as f32 / 255.0]);
                            let blue = window01(h, 195.0, 255.0, 18.0) * smoothstep(0.08, 0.22, s) * smoothstep(0.22, 0.4, l) * (1.0 - smoothstep(0.9, 0.97, l));
                            // near white, saturation is unsteady, so how colourful it is is measured by the spread of the three colours
                            let spread = (src[i].max(src[i + 1]).max(src[i + 2]) - src[i].min(src[i + 1]).min(src[i + 2])) as f32 / 255.0;
                            let cloud = (1.0 - smoothstep(0.03, 0.1, spread)) * smoothstep(0.6, 0.8, l) * (1.0 - smoothstep(0.4, 0.7, fy));
                            *v = smoothstep(t - 0.15, t + 0.15, blue.max(cloud) * prior);
                        }
                    }
                });
            }
        }
    }
    out
}

/// The last few painted brush maps, newest last. A map is 4 bytes a pixel, so the cache is kept small.
static BRUSH_CACHE: std::sync::Mutex<Vec<(u64, std::sync::Arc<Vec<f32>>)>> = std::sync::Mutex::new(Vec::new());
const BRUSH_CACHE_ENTRIES: usize = 3;

/// A fingerprint of everything a painted map depends on: the strokes and which window of which picture.
fn brush_key(strokes: &[Stroke], ox: u32, oy: u32, w: u32, h: u32, fw: u32, fh: u32) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    (ox, oy, w, h, fw, fh, strokes.len()).hash(&mut hasher);
    for s in strokes {
        (s.erase, s.size.to_bits(), s.feather.to_bits(), s.flow.to_bits(), s.points.len()).hash(&mut hasher);
        for p in &s.points {
            (p[0].to_bits(), p[1].to_bits()).hash(&mut hasher);
        }
    }
    hasher.finish()
}

fn brush_cache_get(key: u64) -> Option<std::sync::Arc<Vec<f32>>> {
    let cache = BRUSH_CACHE.lock().ok()?;
    cache.iter().find(|(k, _)| *k == key).map(|(_, v)| v.clone())
}

fn brush_cache_put(key: u64, map: &[f32]) {
    if let Ok(mut cache) = BRUSH_CACHE.lock() {
        cache.retain(|(k, _)| *k != key);
        cache.push((key, std::sync::Arc::new(map.to_vec())));
        while cache.len() > BRUSH_CACHE_ENTRIES {
            cache.remove(0);
        }
    }
}

/// One soft disc of a brush stroke, in window pixels.
struct Stamp {
    x: f32,
    y: f32,
    radius: f32,
    /// inside this distance the disc is solid
    inner: f32,
    flow: f32,
    erase: bool,
}

/// The most stamps one stroke may make. A very long stroke gets wider spacing instead of a slower mask.
const MAX_STAMPS_PER_STROKE: f32 = 4000.0;

/// Where a stroke puts its discs: one every quarter of a radius *along the path*, however many points the
/// mouse recorded. (Stamping once per recorded point made a stroke cost more the more the mouse moved,
/// and made the paint build up differently depending on how fast it was drawn.)
fn stroke_stamps(s: &Stroke, ox: u32, oy: u32, fw: u32, fh: u32, long: f32) -> Vec<Stamp> {
    let radius = (s.size * long / 2.0).max(0.5);
    let pts: Vec<(f32, f32)> = s.points.iter().map(|p| (p[0] * fw as f32 - ox as f32, p[1] * fh as f32 - oy as f32)).collect();
    let make = |x: f32, y: f32| Stamp { x, y, radius, inner: radius * (1.0 - s.feather), flow: s.flow, erase: s.erase };
    match pts.len() {
        0 => return Vec::new(),
        1 => return vec![make(pts[0].0, pts[0].1)],
        _ => {}
    }
    let total: f32 = pts.windows(2).map(|p| ((p[1].0 - p[0].0).powi(2) + (p[1].1 - p[0].1).powi(2)).sqrt()).sum();
    let spacing = (radius * 0.25).max(1.0).max(total / MAX_STAMPS_PER_STROKE);
    let mut stamps = vec![make(pts[0].0, pts[0].1)];
    let mut until_next = spacing; // distance still to walk before the next stamp
    for pair in pts.windows(2) {
        let ((ax, ay), (bx, by)) = (pair[0], pair[1]);
        let len = ((bx - ax).powi(2) + (by - ay).powi(2)).sqrt();
        let mut at = 0.0;
        while len - at >= until_next {
            at += until_next;
            let t = at / len;
            stamps.push(make(ax + (bx - ax) * t, ay + (by - ay) * t));
            until_next = spacing;
        }
        until_next -= len - at;
    }
    stamps
}

/// Paint the stamps in order. Each thread paints its own rows but walks every stamp in the same order, so
/// the result is exactly what one thread would make.
fn paint_stamps(buf: &mut [f32], stamps: &[Stamp], w: usize, h: usize) {
    if stamps.is_empty() || w == 0 || h == 0 {
        return;
    }
    par_bands(buf, w, |row0, band| {
        let rows = band.len() / w;
        let (top, bottom) = (row0 as i64, (row0 + rows) as i64 - 1);
        for st in stamps {
            let y0 = ((st.y - st.radius).floor() as i64).max(top);
            let y1 = ((st.y + st.radius).ceil() as i64).min(bottom).min(h as i64 - 1);
            let x0 = ((st.x - st.radius).floor() as i64).max(0);
            let x1 = ((st.x + st.radius).ceil() as i64).min(w as i64 - 1);
            if y0 > y1 || x0 > x1 {
                continue;
            }
            let (r2, in2) = (st.radius * st.radius, st.inner * st.inner);
            for y in y0..=y1 {
                let dy = (y as f32 + 0.5) - st.y;
                let row = &mut band[(y - row0 as i64) as usize * w..][..w];
                for x in x0..=x1 {
                    let dx = (x as f32 + 0.5) - st.x;
                    let d2 = dx * dx + dy * dy;
                    if d2 >= r2 {
                        continue;
                    }
                    // solid inside the inner radius, soft in the ring (the square root is only needed there)
                    let fall = if d2 <= in2 { st.flow } else { (1.0 - smoothstep(st.inner, st.radius, d2.sqrt())) * st.flow };
                    let v = &mut row[x as usize];
                    *v = if st.erase { *v * (1.0 - fall) } else { *v + (1.0 - *v) * fall };
                }
            }
        }
    });
}

/// Apply every active mask in order, each on top of the result of the one before. (ox, oy) is where
/// `img` sits in the whole picture, which is fw by fh.
pub fn apply_masks(img: &RgbImage, masks: &[Mask], ox: u32, oy: u32, fw: u32, fh: u32) -> RgbImage {
    let mut cur: Option<RgbImage> = None;
    let scale = fw.max(fh) as f32 / 2048.0;
    for mask in masks.iter().filter(|m| is_active(m)) {
        let base = cur.as_ref().unwrap_or(img);
        let weights = mask_weights_with(mask, ox, oy, img.width(), img.height(), fw, fh, Some(base));
        let mut adjusted = if mask.adjust.tone_recipe().has_tone_edits() { apply_tone(base, &mask.adjust.tone_recipe()) } else { base.clone() };
        if mask.adjust.needs_detail() {
            let detail = Detail { sharp_amount: mask.adjust.sharpness * 1.5, nr_luma: mask.adjust.noise, ..Default::default() };
            adjusted = apply_detail_scaled(&adjusted, &detail, scale);
        }
        if mask.adjust.blur >= 0.5 {
            adjusted = lens_blur(&adjusted, mask.adjust.blur / 100.0 * 0.01 * fw.max(fh) as f32 * (img.width().max(img.height()) as f32 / fw.max(fh) as f32));
        }
        cur = Some(blend(base, &adjusted, &weights));
    }
    cur.unwrap_or_else(|| img.clone())
}

/// The picture blurred by a gaussian of this many pixels (sigma). A wide blur is done on a smaller copy, which looks the same and is much faster.
fn lens_blur(img: &RgbImage, sigma: f32) -> RgbImage {
    if sigma < 0.3 {
        return img.clone();
    }
    if sigma <= 6.0 {
        return image::imageops::blur(img, sigma);
    }
    let k = (sigma / 4.0).ceil().max(2.0);
    let (w, h) = (img.width(), img.height());
    let small = image::imageops::resize(img, ((w as f32 / k) as u32).max(1), ((h as f32 / k) as u32).max(1), image::imageops::FilterType::Triangle);
    let blurred = image::imageops::blur(&small, sigma / k);
    image::imageops::resize(&blurred, w, h, image::imageops::FilterType::CatmullRom)
}

fn blend(base: &RgbImage, adjusted: &RgbImage, weights: &[f32]) -> RgbImage {
    let (w, h) = (base.width() as usize, base.height() as usize);
    let (a, b) = (base.as_raw(), adjusted.as_raw());
    let mut out = vec![0u8; a.len()];
    par_bands(&mut out, w * 3, |row0, band| {
        for (ry, row) in band.chunks_exact_mut(w * 3).enumerate() {
            let y = row0 + ry;
            for x in 0..w {
                let wt = weights[y * w + x];
                for k in 0..3 {
                    let i = (y * w + x) * 3 + k;
                    row[x * 3 + k] = (a[i] as f32 + (b[i] as f32 - a[i] as f32) * wt + 0.5) as u8;
                }
            }
        }
    });
    RgbImage::from_raw(w as u32, h as u32, out).expect("same size as the input")
}

/// A red wash over where one mask applies, for the "show mask" view.
pub fn apply_overlay(img: &RgbImage, mask: &Mask, ox: u32, oy: u32, fw: u32, fh: u32) -> RgbImage {
    let weights = mask_weights_with(mask, ox, oy, img.width(), img.height(), fw, fh, Some(img));
    let red = RgbImage::from_pixel(img.width(), img.height(), image::Rgb([225, 40, 40]));
    let half: Vec<f32> = weights.iter().map(|w| w * 0.55).collect();
    blend(img, &red, &half)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn mask(shape: Shape, adjust: LocalAdjust) -> Mask {
        Mask { id: "m1".into(), name: "Test".into(), visible: true, invert: false, parts: Vec::new(), shape, adjust }
    }
    fn linear(x1: f32, y1: f32, x2: f32, y2: f32, feather: f32) -> Shape {
        Shape::Linear { x1, y1, x2, y2, feather }
    }
    fn grey(w: u32, h: u32, v: u8) -> RgbImage {
        ImageBuffer::from_pixel(w, h, Rgb([v; 3]))
    }
    fn at(weights: &[f32], w: u32, x: u32, y: u32) -> f32 {
        weights[(y * w + x) as usize]
    }
    const BRIGHTER: LocalAdjust = LocalAdjust { exposure: 1.0, contrast: 0.0, highlights: 0.0, shadows: 0.0, saturation: 0.0, temperature: 0.0, sharpness: 0.0, noise: 0.0, blur: 0.0 };

    #[test]
    fn a_linear_gradient_is_full_at_the_start_and_gone_at_the_end() {
        let m = mask(linear(0.2, 0.5, 0.8, 0.5, 1.0), LocalAdjust::default());
        let w = mask_weights(&m, 0, 0, 100, 40, 100, 40);
        assert!((at(&w, 100, 5, 20) - 1.0).abs() < 1e-3 && at(&w, 100, 90, 20) < 1e-3);
        assert!(at(&w, 100, 50, 20) > 0.4 && at(&w, 100, 50, 20) < 0.6, "half way is about half: {}", at(&w, 100, 50, 20));
        // it only changes along the line, not across it
        assert_eq!(at(&w, 100, 40, 2), at(&w, 100, 40, 37));
        let along: Vec<f32> = (0..100).map(|x| at(&w, 100, x, 20)).collect();
        assert!(along.windows(2).all(|p| p[1] <= p[0] + 1e-6), "never rises on the way to the end");
    }

    #[test]
    fn a_linear_gradients_feather_sets_how_hard_the_edge_is() {
        let hard = mask_weights(&mask(linear(0.0, 0.5, 1.0, 0.5, 0.0), LocalAdjust::default()), 0, 0, 100, 10, 100, 10);
        let soft = mask_weights(&mask(linear(0.0, 0.5, 1.0, 0.5, 1.0), LocalAdjust::default()), 0, 0, 100, 10, 100, 10);
        assert!(at(&hard, 100, 45, 5) > 0.99 && at(&hard, 100, 55, 5) < 0.01, "a hard edge flips at the middle");
        assert!(at(&soft, 100, 25, 5) > 0.5 && at(&soft, 100, 25, 5) < 0.95, "a soft one is still part way");
        // a degenerate line (both points the same) does not break
        let flat = mask_weights(&mask(linear(0.5, 0.5, 0.5, 0.5, 0.5), LocalAdjust::default()), 0, 0, 20, 20, 20, 20);
        assert!(flat.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn a_radial_mask_is_full_inside_and_gone_outside_and_can_be_inverted() {
        let shape = Shape::Radial { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, angle: 0.0, feather: 0.5 };
        let w = mask_weights(&mask(shape.clone(), LocalAdjust::default()), 0, 0, 100, 100, 100, 100);
        assert!((at(&w, 100, 50, 50) - 1.0).abs() < 1e-3, "centre");
        assert!(at(&w, 100, 5, 5) < 1e-3, "far outside");
        let mid = at(&w, 100, 50 + 15, 50);
        assert!(mid > 0.0 && mid < 1.0, "the soft rim is part way: {mid}");
        let mut inv = mask(shape, LocalAdjust::default());
        inv.invert = true;
        let wi = mask_weights(&inv, 0, 0, 100, 100, 100, 100);
        assert!((at(&wi, 100, 50, 50)).abs() < 1e-3 && (at(&wi, 100, 5, 5) - 1.0).abs() < 1e-3);
        assert!((at(&w, 100, 20, 60) + at(&wi, 100, 20, 60) - 1.0).abs() < 1e-5, "inverting is one minus");
    }

    #[test]
    fn a_radial_mask_can_be_stretched_and_turned() {
        let wide = Shape::Radial { cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.1, angle: 0.0, feather: 0.0 };
        let turned = Shape::Radial { cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.1, angle: 90.0, feather: 0.0 };
        let (a, b) = (mask_weights(&mask(wide, LocalAdjust::default()), 0, 0, 100, 100, 100, 100), mask_weights(&mask(turned, LocalAdjust::default()), 0, 0, 100, 100, 100, 100));
        assert!(at(&a, 100, 80, 50) > 0.9 && at(&a, 100, 50, 80) < 0.1, "wide");
        assert!(at(&b, 100, 80, 50) < 0.1 && at(&b, 100, 50, 80) > 0.9, "the same ellipse turned a quarter");
    }

    #[test]
    fn a_brush_paints_near_its_path_and_an_eraser_takes_it_back() {
        let stroke = |erase: bool, flow: f32| Stroke { erase, size: 0.2, feather: 0.4, flow, points: vec![[0.2, 0.5], [0.8, 0.5]] };
        let painted = mask_weights(&mask(Shape::Brush { strokes: vec![stroke(false, 1.0)] }, LocalAdjust::default()), 0, 0, 100, 100, 100, 100);
        assert!(at(&painted, 100, 50, 50) > 0.99 && at(&painted, 100, 20, 50) > 0.99, "on the path");
        assert!(at(&painted, 100, 50, 5) < 1e-3 && at(&painted, 100, 2, 50) < 1e-3, "away from it");
        let both = mask_weights(&mask(Shape::Brush { strokes: vec![stroke(false, 1.0), Stroke { erase: true, points: vec![[0.5, 0.5]], ..stroke(true, 1.0) }] }, LocalAdjust::default()), 0, 0, 100, 100, 100, 100);
        assert!(at(&both, 100, 50, 50) < 0.05, "erased in the middle");
        assert!(at(&both, 100, 25, 50) > 0.99, "but not further along");
    }

    #[test]
    fn a_stroke_costs_the_same_however_many_points_the_mouse_recorded() {
        let path = |n: usize| -> Vec<[f32; 2]> { (0..n).map(|i| [0.1 + 0.8 * i as f32 / (n - 1) as f32, 0.5]).collect() };
        let weights = |n: usize| {
            let s = Stroke { size: 0.2, feather: 0.5, flow: 0.5, points: path(n), ..Default::default() };
            mask_weights(&mask(Shape::Brush { strokes: vec![s] }, LocalAdjust::default()), 0, 0, 200, 100, 200, 100)
        };
        let (sparse, dense) = (weights(5), weights(2000));
        let worst = sparse.iter().zip(&dense).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        // the same path drawn with 5 or 2000 points paints (nearly) the same thing: the build-up with a flow below 1
        // follows the distance along the path, not the number of mouse events
        assert!(worst < 0.08, "the strokes differ by {worst}");
        // and a dense stroke is not slow: this would take many seconds if every point stamped a disc
        let started = std::time::Instant::now();
        let big = Stroke { size: 0.5, feather: 0.5, flow: 0.8, points: path(20_000), ..Default::default() };
        let w = mask_weights(&mask(Shape::Brush { strokes: vec![big] }, LocalAdjust::default()), 0, 0, 600, 400, 600, 400);
        assert!(started.elapsed().as_secs_f32() < 3.0, "20 000 points of a very wide brush took {:?}", started.elapsed());
        assert!(w.iter().all(|v| (0.0..=1.0).contains(v)));
    }

    #[test]
    fn a_remembered_brush_map_is_the_same_as_a_fresh_one_and_follows_changes() {
        let stroke = |y: f32| Stroke { size: 0.2, feather: 0.4, flow: 1.0, points: vec![[0.2, y], [0.8, y]], ..Default::default() };
        let m = |y: f32| mask(Shape::Brush { strokes: vec![stroke(y)] }, LocalAdjust::default());
        let first = mask_weights(&m(0.3), 0, 0, 100, 100, 100, 100);
        let again = mask_weights(&m(0.3), 0, 0, 100, 100, 100, 100); // served from the cache
        assert_eq!(first, again);
        let moved = mask_weights(&m(0.7), 0, 0, 100, 100, 100, 100);
        assert_ne!(first, moved, "a different stroke must not get the old map");
        assert!(at(&moved, 100, 50, 70) > 0.99 && at(&moved, 100, 50, 30) < 0.01);
        // invert is applied after the cache, so an inverted mask does not poison a normal one
        let mut inv = m(0.3);
        inv.invert = true;
        let inverted = mask_weights(&inv, 0, 0, 100, 100, 100, 100);
        assert!((at(&inverted, 100, 50, 30) - (1.0 - at(&first, 100, 50, 30))).abs() < 1e-6);
        assert_eq!(first, mask_weights(&m(0.3), 0, 0, 100, 100, 100, 100));
        // a window is a different entry from the whole
        let window = mask_weights(&m(0.3), 20, 10, 50, 50, 100, 100);
        assert_eq!(at(&window, 50, 10, 20), at(&first, 100, 30, 30));
    }

    #[test]
    fn brush_flow_builds_up_with_each_pass() {
        let one = Stroke { size: 0.2, feather: 0.0, flow: 0.3, points: vec![[0.5, 0.5]], ..Default::default() };
        let w1 = mask_weights(&mask(Shape::Brush { strokes: vec![one.clone()] }, LocalAdjust::default()), 0, 0, 100, 100, 100, 100);
        let w3 = mask_weights(&mask(Shape::Brush { strokes: vec![one.clone(), one.clone(), one] }, LocalAdjust::default()), 0, 0, 100, 100, 100, 100);
        assert!((at(&w1, 100, 50, 50) - 0.3).abs() < 0.02, "{}", at(&w1, 100, 50, 50));
        assert!(at(&w3, 100, 50, 50) > 0.6 && at(&w3, 100, 50, 50) < 0.7, "three passes: {}", at(&w3, 100, 50, 50));
    }

    #[test]
    fn a_window_gets_the_same_weights_as_the_same_part_of_the_whole() {
        let shapes = [
            linear(0.1, 0.2, 0.9, 0.7, 0.6),
            Shape::Radial { cx: 0.4, cy: 0.6, rx: 0.25, ry: 0.15, angle: 30.0, feather: 0.7 },
            Shape::Brush { strokes: vec![Stroke { size: 0.15, feather: 0.6, flow: 0.8, points: vec![[0.1, 0.1], [0.5, 0.4], [0.9, 0.8]], ..Default::default() }] },
        ];
        for shape in shapes {
            let m = mask(shape, LocalAdjust::default());
            let whole = mask_weights(&m, 0, 0, 300, 200, 300, 200);
            let part = mask_weights(&m, 120, 70, 100, 80, 300, 200);
            for y in 0..80u32 {
                for x in 0..100u32 {
                    let (a, b) = (at(&part, 100, x, y), at(&whole, 300, 120 + x, 70 + y));
                    assert!((a - b).abs() < 1e-4, "{m:?} at {x},{y}: {a} vs {b}");
                }
            }
        }
    }

    #[test]
    fn a_masked_exposure_change_brightens_only_where_the_mask_is() {
        let img = grey(200, 100, 100);
        let m = mask(linear(0.4, 0.5, 0.6, 0.5, 0.2), BRIGHTER);
        let out = apply_masks(&img, &[m.clone()], 0, 0, 200, 100);
        assert!(out.get_pixel(10, 50)[0] > 130, "inside: {}", out.get_pixel(10, 50)[0]);
        assert_eq!(out.get_pixel(190, 50)[0], 100, "outside is untouched");
        let mut inv = m;
        inv.invert = true;
        let o2 = apply_masks(&img, &[inv], 0, 0, 200, 100);
        assert_eq!(o2.get_pixel(10, 50)[0], 100);
        assert!(o2.get_pixel(190, 50)[0] > 130);
    }

    #[test]
    fn hidden_and_empty_masks_do_nothing_and_active_ones_stack() {
        let img = grey(100, 100, 100);
        let everywhere = |adjust: LocalAdjust| mask(Shape::Radial { cx: 0.5, cy: 0.5, rx: 2.0, ry: 2.0, angle: 0.0, feather: 0.0 }, adjust);
        let mut hidden = everywhere(BRIGHTER);
        hidden.visible = false;
        assert_eq!(apply_masks(&img, &[hidden], 0, 0, 100, 100), img);
        assert_eq!(apply_masks(&img, &[everywhere(LocalAdjust::default())], 0, 0, 100, 100), img, "no adjustment, no change");
        assert_eq!(apply_masks(&img, &[], 0, 0, 100, 100), img);
        let (mut a, mut b) = (everywhere(BRIGHTER), everywhere(BRIGHTER));
        a.id = "a".into();
        b.id = "b".into();
        let one = apply_masks(&img, &[a.clone()], 0, 0, 100, 100).get_pixel(50, 50)[0];
        let two = apply_masks(&img, &[a, b], 0, 0, 100, 100).get_pixel(50, 50)[0];
        assert!(two > one, "{two} vs {one}");
    }

    #[test]
    fn local_saturation_and_temperature_work_inside_a_mask() {
        let img: RgbImage = ImageBuffer::from_pixel(100, 100, Rgb([200, 80, 80]));
        let all = |adjust| mask(Shape::Radial { cx: 0.5, cy: 0.5, rx: 2.0, ry: 2.0, angle: 0.0, feather: 0.0 }, adjust);
        let grey_out = apply_masks(&img, &[all(LocalAdjust { saturation: -100.0, ..Default::default() })], 0, 0, 100, 100).get_pixel(5, 5).0;
        assert!(grey_out[0].abs_diff(grey_out[1]) <= 2, "{grey_out:?}");
        let warm = apply_masks(&grey(100, 100, 128), &[all(LocalAdjust { temperature: 60.0, ..Default::default() })], 0, 0, 100, 100).get_pixel(5, 5).0;
        assert!(warm[0] > warm[2], "{warm:?}");
    }

    #[test]
    fn local_sharpness_sharpens_only_inside_the_mask() {
        let step: RgbImage = ImageBuffer::from_fn(200, 40, |x, _| if x % 100 < 50 { Rgb([100; 3]) } else { Rgb([156; 3]) });
        let m = mask(linear(0.45, 0.5, 0.55, 0.5, 0.0), LocalAdjust { sharpness: 100.0, ..Default::default() });
        let out = apply_masks(&step, &[m], 0, 0, 200, 40);
        assert!(out.get_pixel(49, 20)[0] < 100, "the edge inside the mask is sharpened: {}", out.get_pixel(49, 20)[0]);
        assert_eq!(out.get_pixel(149, 20)[0], 100, "the same kind of edge outside it is not");
    }

    #[test]
    fn the_overlay_tints_red_only_where_the_mask_is() {
        let img = grey(100, 50, 100);
        let m = mask(linear(0.4, 0.5, 0.6, 0.5, 0.0), LocalAdjust::default());
        let o = apply_overlay(&img, &m, 0, 0, 100, 50);
        let inside = o.get_pixel(5, 25).0;
        assert!(inside[0] > inside[1] + 40, "{inside:?}");
        assert_eq!(o.get_pixel(95, 25).0, [100, 100, 100]);
    }

    // ---- depth and lens blur ----

    fn depth_map(near_left: bool) -> String {
        let g = image::GrayImage::from_fn(128, 128, |x, _| image::Luma([if (x < 64) == near_left { 230 } else { 20 }]));
        crate::subject::encode(&g).unwrap()
    }

    #[test]
    fn a_depth_mask_covers_the_range_of_distances_asked_for_and_the_far_part_is_its_other_end() {
        let near = plain(Shape::Depth { map: depth_map(true), near: 0.6, far: 1.0, smooth: 0.0 });
        let far = plain(Shape::Depth { map: depth_map(true), near: 0.0, far: 0.4, smooth: 0.0 });
        let (w, h) = (80u32, 40u32);
        let a = mask_weights(&near, 0, 0, w, h, w, h);
        let b = mask_weights(&far, 0, 0, w, h, w, h);
        assert!(at(&a, w, 5, 20) > 0.95 && at(&a, w, 75, 20) < 0.05, "near part: left is in, right is out");
        assert!(at(&b, w, 5, 20) < 0.05 && at(&b, w, 75, 20) > 0.95, "far part: the other way round");
        // no usable map covers nothing, and a damaged map is dropped
        let bad = sanitize_masks(&[plain(Shape::Depth { map: "garbage".into(), near: 0.9, far: 0.1, smooth: 5.0 })]);
        assert!(matches!(&bad[0].shape, Shape::Depth { map, near, far, smooth } if map.is_empty() && near <= far && *smooth <= 1.0));
        let j = serde_json::to_value(&Shape::Depth { map: "x".into(), near: 0.2, far: 0.8, smooth: 0.3 }).unwrap();
        assert_eq!(j["type"], "depth");
        assert!(j.get("near").is_some() && j.get("far").is_some());
    }

    #[test]
    fn a_blur_under_a_mask_smooths_only_the_masked_part() {
        let img = ImageBuffer::from_fn(100u32, 60u32, |x, y| Rgb([if (x / 2 + y / 2) % 2 == 0 { 230 } else { 20 }; 3]));
        let m = mask(Shape::Depth { map: depth_map(true), near: 0.6, far: 1.0, smooth: 0.0 }, LocalAdjust { blur: 80.0, ..Default::default() });
        let out = apply_masks(&img, &[m], 0, 0, 100, 60);
        let range = |im: &RgbImage, x0: u32, x1: u32| {
            let v: Vec<u8> = (x0..x1).flat_map(|x| (10..50).map(move |y| (x, y))).map(|(x, y)| im.get_pixel(x, y)[0]).collect();
            (*v.iter().max().unwrap() as i32) - (*v.iter().min().unwrap() as i32)
        };
        assert!(range(&out, 60, 95) > 150, "the unmasked side keeps its detail");
        assert!(range(&out, 5, 40) < 80, "the masked side is blurred: {}", range(&out, 5, 40));
        assert!(LocalAdjust { blur: 3.0, ..Default::default() }.is_zero() == false && LocalAdjust::default().is_zero());
    }
    // ---- subject, background and sky ----

    fn png_map(left_white: bool) -> String {
        let g = image::GrayImage::from_fn(64, 64, |x, _| image::Luma([if (x < 32) == left_white { 255 } else { 0 }]));
        crate::subject::encode(&g).unwrap()
    }
    fn plain(shape: Shape) -> Mask {
        mask(shape, LocalAdjust::default())
    }

    #[test]
    fn a_subject_mask_follows_its_map_at_any_size_and_the_background_is_its_invert() {
        let m = plain(Shape::Subject { map: png_map(true) });
        for (w, h) in [(100u32, 50u32), (400, 200)] {
            let wt = mask_weights(&m, 0, 0, w, h, w, h);
            assert_eq!(wt[(h as usize / 2) * w as usize + 5], 1.0, "the left is the subject");
            assert_eq!(wt[(h as usize / 2) * w as usize + w as usize - 5], 0.0, "the right is not");
        }
        let mut bg = m.clone();
        bg.invert = true;
        let wt = mask_weights(&bg, 0, 0, 100, 50, 100, 50);
        assert_eq!((wt[25 * 100 + 5], wt[25 * 100 + 95]), (0.0, 1.0));
        // a window cut out of the picture gives the same weights as the same part of the whole
        let whole = mask_weights(&m, 0, 0, 100, 50, 100, 50);
        let part = mask_weights(&m, 40, 10, 30, 20, 100, 50);
        for y in 0..20usize {
            for x in 0..30usize {
                assert_eq!(part[y * 30 + x], whole[(y + 10) * 100 + x + 40]);
            }
        }
    }

    #[test]
    fn a_subject_mask_with_no_usable_map_covers_nothing_and_a_long_one_is_dropped() {
        for bad in ["", "garbage", &"A".repeat(crate::subject::MAX_TEXT + 1)] {
            let m = plain(Shape::Subject { map: bad.to_string() });
            assert!(mask_weights(&m, 0, 0, 20, 10, 20, 10).iter().all(|v| *v == 0.0), "{bad:.10}");
            let kept = sanitize_masks(&[m]);
            assert!(matches!(&kept[0].shape, Shape::Subject { map } if map.is_empty()));
        }
        let good = sanitize_masks(&[plain(Shape::Subject { map: png_map(true) })]);
        assert!(matches!(&good[0].shape, Shape::Subject { map } if !map.is_empty()));
        // it is written as the page writes it
        let j = serde_json::to_value(&Shape::Subject { map: "x".into() }).unwrap();
        assert_eq!(j, serde_json::json!({"type": "subject", "map": "x"}));
        let s: Shape = serde_json::from_str(r#"{"type":"sky","sensitivity":0.3}"#).unwrap();
        assert!(matches!(s, Shape::Sky { sensitivity } if sensitivity == 0.3));
    }

    /// Blue sky above, green ground below, a white wall at the bottom left and a white cloud at the top.
    fn landscape() -> RgbImage {
        ImageBuffer::from_fn(100, 100, |x, y| {
            if y < 55 {
                if (30..50).contains(&x) && (10..25).contains(&y) {
                    Rgb([245, 245, 248]) // a cloud
                } else {
                    Rgb([90, 150, 235]) // blue sky
                }
            } else if x < 40 && y > 70 {
                Rgb([240, 240, 240]) // a white wall
            } else {
                Rgb([60, 120, 50]) // grass
            }
        })
    }

    #[test]
    fn the_sky_mask_takes_the_blue_and_the_cloud_and_leaves_the_ground_and_a_white_wall() {
        let img = landscape();
        let m = plain(Shape::Sky { sensitivity: 0.5 });
        let w = weights_on(&m, &img);
        let at = |x: usize, y: usize| w[y * 100 + x];
        assert!(at(70, 30) > 0.9, "blue sky: {}", at(70, 30));
        assert!(at(40, 17) > 0.9, "cloud in the sky: {}", at(40, 17));
        assert!(at(70, 85) < 0.05, "grass: {}", at(70, 85));
        assert!(at(10, 85) < 0.05, "a white wall low in the picture: {}", at(10, 85));
        // more sensitive takes in at least as much, less takes in at most as much
        let sum = |s: f32| weights_on(&plain(Shape::Sky { sensitivity: s }), &img).iter().sum::<f32>();
        assert!(sum(1.0) >= sum(0.5) && sum(0.5) >= sum(0.0), "{} {} {}", sum(0.0), sum(0.5), sum(1.0));
        // with no picture to look at it covers nothing, and a window gives what the whole gives
        assert!(mask_weights(&m, 0, 0, 10, 10, 100, 100).iter().all(|v| *v == 0.0));
        let part = mask_weights_with(&m, 20, 5, 30, 40, 100, 100, Some(&image::imageops::crop_imm(&img, 20, 5, 30, 40).to_image()));
        for y in 0..40usize {
            for x in 0..30usize {
                assert!((part[y * 30 + x] - w[(y + 5) * 100 + x + 20]).abs() < 1e-6);
            }
        }
    }

    // ---- range masks and combining ----

    fn lum(lo: f32, hi: f32, smooth: f32) -> Shape {
        Shape::Luminance { lo, hi, smooth }
    }
    fn colour(hue: f32, range: f32, sat: f32, smooth: f32) -> Shape {
        Shape::Colour { hue, range, sat, smooth }
    }
    fn weights_on(m: &Mask, img: &RgbImage) -> Vec<f32> {
        mask_weights_with(m, 0, 0, img.width(), img.height(), img.width(), img.height(), Some(img))
    }
    /// dark on the left, bright on the right
    fn two_tone() -> RgbImage {
        ImageBuffer::from_fn(100, 40, |x, _| Rgb([if x < 50 { 40 } else { 220 }; 3]))
    }

    #[test]
    fn a_luminance_range_selects_by_brightness() {
        let m = mask(lum(0.6, 1.0, 0.0), LocalAdjust::default());
        let w = weights_on(&m, &two_tone());
        assert_eq!((at(&w, 100, 10, 5), at(&w, 100, 90, 5)), (0.0, 1.0), "the bright half only");
        let dark = mask(lum(0.0, 0.4, 0.0), LocalAdjust::default());
        let wd = weights_on(&dark, &two_tone());
        assert_eq!((at(&wd, 100, 10, 5), at(&wd, 100, 90, 5)), (1.0, 0.0), "the dark half only, and black itself is included");
        let black: RgbImage = ImageBuffer::from_pixel(4, 4, Rgb([0, 0, 0]));
        assert_eq!(weights_on(&dark, &black)[0], 1.0);
    }

    #[test]
    fn a_luminance_range_fades_smoothly_when_asked() {
        let ramp: RgbImage = ImageBuffer::from_fn(256, 4, |x, _| Rgb([x as u8; 3]));
        let w = weights_on(&mask(lum(0.5, 1.0, 1.0), LocalAdjust::default()), &ramp);
        let row: Vec<f32> = (0..256).map(|x| at(&w, 256, x, 1)).collect();
        assert!(row.windows(2).all(|p| p[1] >= p[0] - 1e-6), "it never falls on the way up");
        assert!(row[10] < 0.05 && row[255] > 0.99, "{} {}", row[10], row[255]);
        let hard = weights_on(&mask(lum(0.5, 1.0, 0.0), LocalAdjust::default()), &ramp);
        let steps = (0..255).filter(|&x| (at(&hard, 256, x + 1, 1) - at(&hard, 256, x, 1)).abs() > 0.5).count();
        assert_eq!(steps, 1, "a hard range has one edge");
        let soft_edge = (row[100] - row[140]).abs();
        assert!(soft_edge > 0.0 && soft_edge < 1.0, "a soft range is part way in between");
    }

    #[test]
    fn a_colour_range_selects_a_colour_and_not_grey() {
        // red, green, blue, grey and a washed-out red side by side
        let colours = [[220u8, 30, 30], [30, 200, 40], [30, 40, 220], [128, 128, 128], [150, 120, 120]];
        let img: RgbImage = ImageBuffer::from_fn(50, 10, |x, _| Rgb(colours[(x / 10) as usize]));
        let w = weights_on(&mask(colour(0.0, 30.0, 0.3, 0.3), LocalAdjust::default()), &img);
        let at_x = |i: u32| at(&w, 50, i * 10 + 5, 5);
        assert!(at_x(0) > 0.95, "red is selected: {}", at_x(0));
        assert!(at_x(1) < 0.01 && at_x(2) < 0.01, "green and blue are not");
        assert!(at_x(3) < 0.01, "grey has no colour to select");
        assert!(at_x(4) < at_x(0), "a washed-out red is selected less");
        // the hue wheel wraps: 350 degrees is next to red
        let wrap = weights_on(&mask(colour(350.0, 30.0, 0.3, 0.3), LocalAdjust::default()), &img);
        assert!(at(&wrap, 50, 5, 5) > 0.9, "{}", at(&wrap, 50, 5, 5));
        // a wider range takes in more
        let wide = weights_on(&mask(colour(0.0, 150.0, 0.3, 0.3), LocalAdjust::default()), &img);
        assert!(at(&wide, 50, 15, 5) > at(&w, 50, 15, 5), "a wide range reaches green");
    }

    #[test]
    fn a_range_with_no_picture_to_look_at_covers_everything() {
        let w = mask_weights(&mask(lum(0.9, 1.0, 0.0), LocalAdjust::default()), 0, 0, 20, 20, 20, 20);
        assert!(w.iter().all(|v| *v == 1.0));
        let c = mask_weights(&mask(colour(120.0, 20.0, 0.5, 0.0), LocalAdjust::default()), 0, 0, 20, 20, 20, 20);
        assert!(c.iter().all(|v| *v == 1.0));
    }

    #[test]
    fn shapes_combine_by_adding_subtracting_and_intersecting() {
        let all = Shape::Radial { cx: 0.5, cy: 0.5, rx: 2.0, ry: 2.0, angle: 0.0, feather: 0.0 };
        let left = linear(0.5, 0.5, 0.51, 0.5, 0.0); // full on the left half, none on the right
        let right = Shape::Radial { cx: 0.75, cy: 0.5, rx: 0.12, ry: 3.0, angle: 0.0, feather: 0.0 }; // a band about 63 to 87 px wide
        let with = |first: Shape, op: Op, second: Shape| {
            let mut m = mask(first, LocalAdjust::default());
            m.parts = vec![Part { op, shape: second }];
            mask_weights(&m, 0, 0, 100, 40, 100, 40)
        };
        let (l, r) = (at(&with(left.clone(), Op::Add, left.clone()), 100, 10, 5), at(&with(all.clone(), Op::Subtract, left.clone()), 100, 10, 5));
        assert_eq!((l, r), (1.0, 0.0), "adding the same shape changes nothing; taking the left out of everything empties the left");
        let union = with(left.clone(), Op::Add, right.clone());
        assert_eq!((at(&union, 100, 10, 5), at(&union, 100, 75, 5), at(&union, 100, 98, 5)), (1.0, 1.0, 0.0), "left, plus a band on the right, nothing past it");
        let both = with(left.clone(), Op::Intersect, all.clone());
        assert_eq!((at(&both, 100, 10, 5), at(&both, 100, 90, 5)), (1.0, 0.0), "keeping only where both cover");
        let none = with(left.clone(), Op::Intersect, right);
        assert!(none.iter().all(|v| *v == 0.0), "the left half and a band on the right never meet");
        // soft edges combine as probabilities: half and half make three quarters when added, one quarter when intersected
        let half = Shape::Radial { cx: 0.5, cy: 0.5, rx: 2.0, ry: 2.0, angle: 0.0, feather: 1.0 };
        let mut m = mask(half.clone(), LocalAdjust::default());
        let base = at(&mask_weights(&m, 0, 0, 100, 40, 100, 40), 100, 70, 5);
        m.parts = vec![Part { op: Op::Add, shape: half.clone() }];
        assert!((at(&mask_weights(&m, 0, 0, 100, 40, 100, 40), 100, 70, 5) - (base + base - base * base)).abs() < 1e-5);
        m.parts[0].op = Op::Intersect;
        assert!((at(&mask_weights(&m, 0, 0, 100, 40, 100, 40), 100, 70, 5) - base * base).abs() < 1e-5);
    }

    #[test]
    fn a_range_narrows_a_shape_and_the_invert_applies_to_the_result() {
        // "the bright parts, inside the circle": a circle over the middle of a dark and bright picture
        let circle = Shape::Radial { cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, angle: 0.0, feather: 0.0 };
        let mut m = mask(circle, LocalAdjust::default());
        m.parts = vec![Part { op: Op::Intersect, shape: lum(0.6, 1.0, 0.0) }];
        let img = two_tone();
        let w = weights_on(&m, &img);
        assert_eq!(at(&w, 100, 60, 20), 1.0, "bright and inside the circle");
        assert_eq!(at(&w, 100, 40, 20), 0.0, "inside the circle but dark");
        assert_eq!(at(&w, 100, 95, 20), 0.0, "bright but outside the circle");
        m.invert = true;
        let inv = weights_on(&m, &img);
        assert_eq!((at(&inv, 100, 60, 20), at(&inv, 100, 40, 20), at(&inv, 100, 95, 20)), (0.0, 1.0, 1.0), "everything except that");
    }

    #[test]
    fn a_range_mask_on_its_own_adjusts_only_what_it_selects() {
        let img = two_tone();
        let m = mask(lum(0.6, 1.0, 0.0), BRIGHTER);
        let out = apply_masks(&img, &[m], 0, 0, 100, 40);
        assert_eq!(out.get_pixel(10, 20)[0], 40, "the dark half is left alone");
        assert!(out.get_pixel(90, 20)[0] > 220, "the bright half is brightened: {}", out.get_pixel(90, 20)[0]);
        // and a colour mask can darken just the reds
        let tiles: RgbImage = ImageBuffer::from_fn(40, 10, |x, _| if x < 20 { Rgb([200, 40, 40]) } else { Rgb([40, 200, 40]) });
        let dim = LocalAdjust { exposure: -1.0, ..Default::default() };
        let out = apply_masks(&tiles, &[mask(colour(0.0, 30.0, 0.3, 0.2), dim)], 0, 0, 40, 10);
        assert!(out.get_pixel(5, 5)[0] < 150 && out.get_pixel(35, 5)[1] == 200, "red darkened, green untouched");
    }

    #[test]
    fn the_overlay_shows_where_a_range_mask_applies() {
        let img = two_tone();
        let o = apply_overlay(&img, &mask(lum(0.6, 1.0, 0.0), LocalAdjust::default()), 0, 0, 100, 40);
        assert!(o.get_pixel(90, 20)[0] > o.get_pixel(90, 20)[1] + 30, "red wash on the bright side");
        assert_eq!(o.get_pixel(10, 20).0, [40, 40, 40]);
    }

    #[test]
    fn a_window_gets_the_same_weights_with_parts_and_ranges_as_the_whole() {
        let img: RgbImage = ImageBuffer::from_fn(300, 200, |x, y| {
            let n = ((x * 31 + y * 17) % 29) as f32;
            Rgb([(40.0 + x as f32 * 0.6 + n) as u8, (60.0 + y as f32 * 0.5 + n) as u8, (100.0 + n * 2.0) as u8])
        });
        let mut m = mask(Shape::Radial { cx: 0.5, cy: 0.5, rx: 0.4, ry: 0.3, angle: 20.0, feather: 0.6 }, LocalAdjust::default());
        m.parts = vec![
            Part { op: Op::Intersect, shape: lum(0.3, 0.8, 0.5) },
            Part { op: Op::Subtract, shape: Shape::Brush { strokes: vec![Stroke { size: 0.2, feather: 0.5, flow: 1.0, points: vec![[0.2, 0.3], [0.8, 0.6]], ..Default::default() }] } },
            Part { op: Op::Add, shape: colour(10.0, 40.0, 0.2, 0.5) },
        ];
        let whole = weights_on(&m, &img);
        let window = image::imageops::crop_imm(&img, 90, 50, 120, 90).to_image();
        let part = mask_weights_with(&m, 90, 50, 120, 90, 300, 200, Some(&window));
        for y in 0..90u32 {
            for x in 0..120u32 {
                let (a, b) = (at(&part, 120, x, y), at(&whole, 300, 90 + x, 50 + y));
                assert!((a - b).abs() < 1e-4, "at {x},{y}: {a} vs {b}");
            }
        }
    }

    #[test]
    fn parts_and_range_shapes_are_cleaned_capped_and_survive_json() {
        let mut m = mask(lum(0.9, 0.2, 7.0), LocalAdjust::default()); // low above high, smooth far too big
        m.parts = (0..10).map(|i| Part { op: if i % 2 == 0 { Op::Add } else { Op::Subtract }, shape: colour(1e9, -4.0, f32::NAN, 9.0) }).collect();
        let s = &sanitize_masks(&[m.clone()])[0];
        assert!(matches!(s.shape, Shape::Luminance { lo, hi, smooth } if lo == 0.2 && hi == 0.9 && smooth == 1.0), "{:?}", s.shape);
        assert_eq!(s.parts.len(), MAX_PARTS);
        assert!(matches!(s.parts[0].shape, Shape::Colour { hue, range, sat, smooth } if hue == 360.0 && range == 1.0 && sat == 0.2 && smooth == 1.0), "{:?}", s.parts[0].shape);
        let json = serde_json::to_string(&Mask { parts: vec![Part { op: Op::Intersect, shape: colour(120.0, 30.0, 0.2, 0.5) }], ..mask(lum(0.1, 0.9, 0.3), LocalAdjust::default()) }).unwrap();
        assert!(json.contains("\"type\":\"luminance\"") && json.contains("\"op\":\"intersect\"") && json.contains("\"type\":\"colour\""), "{json}");
        let back: Mask = serde_json::from_str(&json).unwrap();
        assert_eq!(back.parts.len(), 1);
        assert_eq!(back.parts[0].op, Op::Intersect);
        // a mask saved before parts existed still loads, with none
        let old: Mask = serde_json::from_str(r#"{"id":"a","shape":{"type":"radial","cx":0.5,"cy":0.5,"rx":0.2,"ry":0.2,"angle":0,"feather":0.5}}"#).unwrap();
        assert!(old.parts.is_empty());
    }

    #[test]
    fn masks_are_cleaned_capped_and_survive_json() {
        let bad = Mask {
            id: "x".repeat(200),
            name: "  lots   of   space ".into(),
            visible: true,
            invert: false,
            parts: Vec::new(),
            shape: Shape::Radial { cx: f32::NAN, cy: 9.0, rx: -3.0, ry: 99.0, angle: 1e9, feather: 7.0 },
            adjust: LocalAdjust { exposure: 99.0, noise: -5.0, ..Default::default() },
        };
        let s = sanitize_masks(&[bad.clone()]);
        assert_eq!(s[0].id.len(), 64);
        assert_eq!(s[0].name, "lots of space");
        assert_eq!(s[0].adjust.exposure, 5.0);
        assert_eq!(s[0].adjust.noise, 0.0);
        let Shape::Radial { cx, cy, rx, ry, angle, feather } = s[0].shape else { panic!("shape changed") };
        assert_eq!((cx, cy, rx, ry, angle, feather), (0.5, 2.0, 0.005, 2.0, 180.0, 1.0));
        // duplicates and empty ids go, and the count is capped
        let many: Vec<Mask> = (0..30).map(|i| Mask { id: format!("m{}", i % 15), ..bad.clone() }).collect();
        assert_eq!(sanitize_masks(&many).len(), MAX_MASKS);
        assert!(sanitize_masks(&[Mask { id: String::new(), ..bad.clone() }]).is_empty());
        // too many strokes and points are cut
        let big = Mask { shape: Shape::Brush { strokes: (0..500).map(|_| Stroke { points: vec![[0.5, 0.5]; 100], ..Default::default() }).collect() }, ..bad };
        let Shape::Brush { strokes } = &sanitize_masks(&[big])[0].shape else { panic!() };
        assert!(strokes.len() <= MAX_STROKES && strokes.iter().map(|s| s.points.len()).sum::<usize>() <= MAX_STROKE_POINTS);
        // json: the shape is tagged, camelCase, and missing fields default
        let json = serde_json::to_string(&mask(linear(0.1, 0.2, 0.3, 0.4, 0.5), BRIGHTER)).unwrap();
        assert!(json.contains("\"type\":\"linear\"") && json.contains("\"x1\":0.1"), "{json}");
        let back: Mask = serde_json::from_str(&json).unwrap();
        assert_eq!(back, mask(linear(0.1, 0.2, 0.3, 0.4, 0.5), BRIGHTER));
        let minimal: Mask = serde_json::from_str(r#"{"id":"a","shape":{"type":"brush","strokes":[]}}"#).unwrap();
        assert!(minimal.visible && !minimal.invert && minimal.adjust.is_zero());
    }
}
