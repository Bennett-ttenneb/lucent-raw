//! Portrait retouching: skin, teeth and eyes.
//!
//! The person marks a face, two eyes and a mouth with ellipses; nothing here finds a face by itself. Each
//! effect is limited twice: by the soft edge of the ellipse it belongs to, and by a test of the pixel's own
//! colour (skin tones for the skin, bright and plain for teeth and the whites of the eyes), so a rough ellipse
//! does not smooth the hair or whiten the lips.
//!
//! Positions are fractions of the cropped picture (`cx`, `cy`) and of its long edge (`rx`, `ry`). Blur sizes are
//! given for a 2048 px picture and scale with the real size. Everything a pixel needs from outside its own
//! neighbourhood (the reference skin colour) is read from the whole picture at fixed places, so a window of
//! the picture gets what the same window of the whole would.

use image::RgbImage;
use serde::{Deserialize, Serialize};

use crate::develop::{blur_plane, par_bands, rgb_to_hsl, smoothstep};

/// Whether the face parser finds the skin, eyes and mouth. Off in unit tests, which draw faces the parser would not call faces.
pub static USE_PARSER: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(!cfg!(test));

/// How far (in 2048 px picture pixels) the effects look around a pixel: the blemish pass blurs twice (3 sigma of 12 px,
/// then 3 sigma of 10 px), with some to spare.
pub const REACH: f32 = 200.0;

fn hundred() -> f32 {
    100.0
}
fn fifty() -> f32 {
    50.0
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ellipse {
    pub cx: f32,
    pub cy: f32,
    pub rx: f32,
    pub ry: f32,
}

impl Ellipse {
    fn sanitized(self) -> Ellipse {
        let f = |v: f32, lo: f32, hi: f32, d: f32| if v.is_finite() { v.clamp(lo, hi) } else { d };
        Ellipse { cx: f(self.cx, -0.5, 1.5, 0.5), cy: f(self.cy, -0.5, 1.5, 0.5), rx: f(self.rx, 0.004, 0.5, 0.05), ry: f(self.ry, 0.004, 0.5, 0.05) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Skin {
    /// How much of the skin work shows, 0 to 100.
    pub impact: f32,
    pub blemishes: f32,
    pub dark_circles: f32,
    /// How much the skin is smoothed, 0 to 100.
    pub even_amount: f32,
    /// How much fine texture is kept while smoothing, 0 to 100.
    pub even_texture: f32,
    /// Shape: -100 flattens, 100 adds light in the middle and shade at the edge of the face.
    pub contouring: f32,
    /// Frequency separation: how coarse the split is between the tone layer (colour and light) and the texture layer
    /// (pores, hair), 0 to 100.
    pub radius: f32,
    /// How much of the skin work reaches the neck, shoulders and arms, 0 to 100 (skin of the face's own colour below the chin).
    pub body: f32,
    /// Dodge and burn: how much the broad light and shade of the skin is evened (hollows lifted, bright patches eased), 0 to 100.
    pub tone: f32,
    /// How much shine (the oily highlights) is taken out of the skin, 0 to 100.
    pub shine: f32,
    /// How much blotches of colour (redness, patches) are evened towards the usual colour of the skin, 0 to 100.
    pub colour: f32,
    /// Skin highlights: how much the light on the high points of the face (forehead, nose, cheekbones) is brought out, 0 to 100.
    pub glow: f32,
    /// Skin texture: how much the fine grain of the skin (pores) is brought out, 0 to 100.
    pub crisp: f32,
}

impl Default for Skin {
    fn default() -> Self {
        Skin { impact: hundred(), blemishes: 0.0, dark_circles: 0.0, even_amount: 0.0, even_texture: fifty(), contouring: 0.0, radius: 40.0, body: 0.0, tone: 0.0, shine: 0.0, colour: 0.0, glow: 0.0, crisp: 0.0 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Teeth {
    /// -100 darker, 100 brighter.
    pub brightness: f32,
    /// 0 to 100: take the yellow out.
    pub desaturation: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EyeAdjust {
    /// -100 duller, 100 richer and brighter.
    pub iris: f32,
    /// -100 darker, 100 whiter and less red.
    pub sclera: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Eyes {
    pub both: EyeAdjust,
    pub left: EyeAdjust,
    pub right: EyeAdjust,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Portrait {
    pub face: Ellipse,
    pub left_eye: Ellipse,
    pub right_eye: Ellipse,
    pub mouth: Ellipse,
    pub skin: Skin,
    pub teeth: Teeth,
    pub eyes: Eyes,
    /// How the face is turned, in degrees, as far as the detector could tell (0 for a face marked by hand). `roll` tips every
    /// region of the face clockwise; `yaw` and `pitch` are only reported.
    pub roll: f32,
    pub yaw: f32,
    pub pitch: f32,
    /// Lips: -100 paler, 100 richer in colour and a little deeper. Needs the face parser to know where the lips are.
    pub lips: f32,
    /// Eyebrows: -100 lighter, 100 darker and fuller. Needs the face parser to know where the brows are.
    pub brows: f32,
}

impl Default for Portrait {
    fn default() -> Self {
        Portrait {
            face: Ellipse { cx: 0.5, cy: 0.45, rx: 0.12, ry: 0.16 },
            left_eye: Ellipse { cx: 0.455, cy: 0.4, rx: 0.025, ry: 0.012 },
            right_eye: Ellipse { cx: 0.545, cy: 0.4, rx: 0.025, ry: 0.012 },
            mouth: Ellipse { cx: 0.5, cy: 0.52, rx: 0.04, ry: 0.016 },
            skin: Skin::default(),
            teeth: Teeth::default(),
            eyes: Eyes::default(),
            roll: 0.0,
            yaw: 0.0,
            pitch: 0.0,
            lips: 0.0,
            brows: 0.0,
        }
    }
}

impl Portrait {
    pub fn sanitized(&self) -> Portrait {
        let c = |v: f32, lo: f32, hi: f32, d: f32| if v.is_finite() { v.clamp(lo, hi) } else { d };
        let eye = |e: EyeAdjust| EyeAdjust { iris: c(e.iris, -100.0, 100.0, 0.0), sclera: c(e.sclera, -100.0, 100.0, 0.0) };
        Portrait {
            face: self.face.sanitized(),
            left_eye: self.left_eye.sanitized(),
            right_eye: self.right_eye.sanitized(),
            mouth: self.mouth.sanitized(),
            skin: Skin {
                impact: c(self.skin.impact, 0.0, 100.0, 100.0),
                blemishes: c(self.skin.blemishes, 0.0, 100.0, 0.0),
                dark_circles: c(self.skin.dark_circles, 0.0, 100.0, 0.0),
                even_amount: c(self.skin.even_amount, 0.0, 100.0, 0.0),
                even_texture: c(self.skin.even_texture, 0.0, 100.0, 50.0),
                contouring: c(self.skin.contouring, -100.0, 100.0, 0.0),
                radius: c(self.skin.radius, 0.0, 100.0, 40.0),
                body: c(self.skin.body, 0.0, 100.0, 0.0),
                tone: c(self.skin.tone, 0.0, 100.0, 0.0),
                shine: c(self.skin.shine, 0.0, 100.0, 0.0),
                colour: c(self.skin.colour, 0.0, 100.0, 0.0),
                glow: c(self.skin.glow, 0.0, 100.0, 0.0),
                crisp: c(self.skin.crisp, 0.0, 100.0, 0.0),
            },
            teeth: Teeth { brightness: c(self.teeth.brightness, -100.0, 100.0, 0.0), desaturation: c(self.teeth.desaturation, 0.0, 100.0, 0.0) },
            eyes: Eyes { both: eye(self.eyes.both), left: eye(self.eyes.left), right: eye(self.eyes.right) },
            roll: c(self.roll, -180.0, 180.0, 0.0),
            yaw: c(self.yaw, -90.0, 90.0, 0.0),
            pitch: c(self.pitch, -90.0, 90.0, 0.0),
            lips: c(self.lips, -100.0, 100.0, 0.0),
            brows: c(self.brows, -100.0, 100.0, 0.0),
        }
    }

    fn skin_active(&self) -> bool {
        let s = &self.skin;
        s.impact > 0.0 && (s.blemishes > 0.0 || s.dark_circles > 0.0 || s.even_amount > 0.0 || s.contouring != 0.0 || s.tone > 0.0 || s.shine > 0.0 || s.colour > 0.0 || s.glow > 0.0 || s.crisp > 0.0)
    }
    fn features_active(&self) -> bool {
        self.lips != 0.0 || self.brows != 0.0
    }
    fn teeth_active(&self) -> bool {
        self.teeth.brightness != 0.0 || self.teeth.desaturation > 0.0
    }
    fn eye_values(&self, left: bool) -> EyeAdjust {
        let side = if left { self.eyes.left } else { self.eyes.right };
        EyeAdjust { iris: (self.eyes.both.iris + side.iris).clamp(-100.0, 100.0), sclera: (self.eyes.both.sclera + side.sclera).clamp(-100.0, 100.0) }
    }
    fn eyes_active(&self) -> bool {
        [true, false].iter().any(|l| {
            let e = self.eye_values(*l);
            e.iris != 0.0 || e.sclera != 0.0
        })
    }
    /// Does it change the picture at all? Marking the regions alone does not.
    pub fn is_active(&self) -> bool {
        self.skin_active() || self.teeth_active() || self.eyes_active() || self.features_active()
    }
}

/// How many faces one photo can carry.
pub const MAX_PORTRAITS: usize = 24;

/// Is there any retouching to do for these faces?
pub fn any(faces: &[Portrait]) -> bool {
    faces.iter().any(|p| p.is_active())
}

/// Retouch every face of a whole picture, one after the other.
pub fn apply_portraits(img: &RgbImage, faces: &[Portrait]) -> RgbImage {
    let mut out = img.clone();
    apply_portraits_window(&mut out, 0, 0, img, faces);
    out
}

/// Retouch every face of a window of the picture (see `apply_portrait_window`).
pub fn apply_portraits_window(window: &mut RgbImage, ox: u32, oy: u32, src: &RgbImage, faces: &[Portrait]) {
    for p in faces.iter().filter(|p| p.is_active()) {
        apply_portrait_window(window, ox, oy, src, p);
    }
}

/// A pixel's place in an ellipse: 0 in the middle, 1 on the edge.
struct Shape {
    cx: f32,
    cy: f32,
    rx: f32,
    ry: f32,
    /// The tilt of its own axes, in radians.
    ang: f32,
}
impl Shape {
    fn new(e: &Ellipse, fw: f32, fh: f32, roll_degrees: f32) -> Shape {
        Shape { cx: e.cx * fw, cy: e.cy * fh, rx: (e.rx * fw.max(fh)).max(1.0), ry: (e.ry * fw.max(fh)).max(1.0), ang: roll_degrees.to_radians() }
    }
    /// A point's place in the shape's own frame: along its x axis and along its y axis, in pixels from the middle.
    fn local(&self, x: f32, y: f32) -> (f32, f32) {
        let (dx, dy) = (x - self.cx, y - self.cy);
        let (c, s) = (self.ang.cos(), self.ang.sin());
        (dx * c + dy * s, -dx * s + dy * c)
    }
    fn dist(&self, x: f32, y: f32) -> f32 {
        let (px, py) = self.local(x, y);
        ((px / self.rx).powi(2) + (py / self.ry).powi(2)).sqrt()
    }
    /// 1 inside, fading to 0 between `from` and 1 times the radius.
    fn weight(&self, x: f32, y: f32, from: f32) -> f32 {
        1.0 - smoothstep(from, 1.0, self.dist(x, y))
    }
    /// The box that holds the ellipse stretched by `k`: (x0, y0, x1, y1), not yet clipped.
    fn bbox(&self, k: f32) -> (f32, f32, f32, f32) {
        let m = self.rx.max(self.ry) * k; // a tilted shape fits in the square of its longer radius
        (self.cx - m, self.cy - m, self.cx + m, self.cy + m)
    }
}

fn luma(c: [f32; 3]) -> f32 {
    0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
}

/// How much a colour looks like skin, 0 to 1: warm, not grey, not dark, not blown out.
fn skin_tone(c: [f32; 3]) -> f32 {
    let n = [c[0] / 255.0, c[1] / 255.0, c[2] / 255.0];
    let (h, s, l) = rgb_to_hsl(n);
    let h = if h > 180.0 { h - 360.0 } else { h }; // reds sit either side of 0
    let hue = smoothstep(-25.0, -5.0, h) * (1.0 - smoothstep(40.0, 60.0, h));
    let sat = smoothstep(0.08, 0.2, s) * (1.0 - smoothstep(0.75, 0.95, s));
    let lit = smoothstep(0.09, 0.15, l) * (1.0 - smoothstep(0.82, 0.92, l)); // deep skin is skin too
    hue * sat * lit
}

fn px(img: &RgbImage, x: i64, y: i64) -> [f32; 3] {
    let p = img.get_pixel(x.clamp(0, img.width() as i64 - 1) as u32, y.clamp(0, img.height() as i64 - 1) as u32);
    [p[0] as f32, p[1] as f32, p[2] as f32]
}

/// The usual skin colour inside the face, from fixed places in the whole picture, or None when there is none.
fn reference_skin(src: &RgbImage, face: &Shape) -> Option<[f32; 3]> {
    let mut found: Vec<(f32, [f32; 3])> = Vec::new();
    for iy in -4..=4 {
        for ix in -4..=4 {
            let (ux, uy) = (ix as f32 / 4.0 * 0.6, iy as f32 / 4.0 * 0.6);
            if ux * ux + uy * uy > 0.36 {
                continue;
            }
            let (x, y) = ((face.cx + ux * face.rx).round() as i64, (face.cy + uy * face.ry).round() as i64);
            // a small patch, so one speck of noise does not decide it
            let mut m = [0.0f32; 3];
            for dy in -1..=1 {
                for dx in -1..=1 {
                    let p = px(src, x + dx, y + dy);
                    (0..3).for_each(|k| m[k] += p[k] / 9.0);
                }
            }
            if skin_tone(m) > 0.5 {
                found.push((luma(m), m));
            }
        }
    }
    if found.len() < 4 {
        return None;
    }
    // the lighter 60 per cent: hollows and shade are the very thing being corrected, so they should not set the target
    found.sort_by(|a, b| b.0.total_cmp(&a.0));
    let top = &found[..(found.len() * 6).div_ceil(10)];
    let mut sum = [0.0f32; 3];
    for (_, c) in top {
        (0..3).for_each(|k| sum[k] += c[k] / top.len() as f32);
    }
    Some(sum)
}

/// Keep only the blobs of `raw` (touching pixels over 0.35) that are small and roundish: a pimple or a mole, not a nostril, a
/// line of lashes, a strand of hair, a string of beads or the shadow of a fold. `max_r` is the biggest radius a spot may have and
/// `min_area` the fewest pixels (anything smaller is a pore or noise).
fn small_blobs(raw: &[f32], w: usize, h: usize, max_r: f32, min_area: usize) -> Vec<f32> {
    let n = w * h;
    let mut label = vec![0u32; n];
    let mut good: Vec<bool> = vec![false]; // by label; 0 is "no blob"
    let mut stack: Vec<usize> = Vec::new();
    let max_area = (std::f32::consts::PI * max_r * max_r).max(12.0) as usize;
    let max_side = (2.4 * max_r).max(4.0) as usize;
    for start in 0..n {
        if raw[start] <= 0.35 || label[start] != 0 {
            continue;
        }
        let id = good.len() as u32;
        label[start] = id;
        stack.push(start);
        let (mut area, mut x0, mut x1, mut y0, mut y1) = (0usize, usize::MAX, 0usize, usize::MAX, 0usize);
        while let Some(i) = stack.pop() {
            area += 1;
            let (x, y) = (i % w, i / w);
            (x0, x1, y0, y1) = (x0.min(x), x1.max(x), y0.min(y), y1.max(y));
            let mut visit = |j: usize| {
                if raw[j] > 0.35 && label[j] == 0 {
                    label[j] = id;
                    stack.push(j);
                }
            };
            if x > 0 {
                visit(i - 1);
            }
            if x + 1 < w {
                visit(i + 1);
            }
            if y > 0 {
                visit(i - w);
            }
            if y + 1 < h {
                visit(i + w);
            }
        }
        let (bw, bh) = (x1 - x0 + 1, y1 - y0 + 1);
        let roundish = bw.max(bh) as f32 <= 2.2 * bw.min(bh) as f32 && area as f32 >= 0.45 * (bw * bh) as f32;
        let inside = x0 > 0 && y0 > 0 && x1 + 1 < w && y1 + 1 < h; // a blob cut by the edge of the work box cannot be judged
        good.push(area >= min_area && area <= max_area && bw.max(bh) <= max_side && roundish && inside);
    }
    (0..n).map(|i| if good[label[i] as usize] { raw[i] } else { 0.0 }).collect()
}

/// A plane of `w` x `h` values worked out one by one, on all cores.
fn par_fill(w: usize, h: usize, f: impl Fn(usize, usize) -> f32 + Sync) -> Vec<f32> {
    let mut out = vec![0f32; w * h];
    if w > 0 {
        par_bands(&mut out, w, |row0, band| {
            for (ry, row) in band.chunks_exact_mut(w).enumerate() {
                for (x, v) in row.iter_mut().enumerate() {
                    *v = f(x, row0 + ry);
                }
            }
        });
    }
    out
}

/// `plane` shrunk by `d` (each new pixel the average of a d x d block), and its new size.
fn shrink(plane: &[f32], w: usize, h: usize, d: usize) -> (Vec<f32>, usize, usize) {
    let (sw, sh) = (w.div_ceil(d), h.div_ceil(d));
    let out = par_fill(sw, sh, |sx, sy| {
        let (mut sum, mut n) = (0.0, 0.0);
        for y in sy * d..((sy + 1) * d).min(h) {
            for x in sx * d..((sx + 1) * d).min(w) {
                sum += plane[y * w + x];
                n += 1.0;
            }
        }
        sum / n
    });
    (out, sw, sh)
}

/// A shrunk plane (`sw` x `sh`, made by `shrink` with `d`) drawn back up to `w` x `h`, blended between the nearest spots.
fn grow(small: &[f32], sw: usize, sh: usize, w: usize, h: usize, d: usize) -> Vec<f32> {
    let k = 1.0 / d as f32;
    par_fill(w, h, |x, y| {
        let fy = ((y as f32 + 0.5) * k - 0.5).clamp(0.0, sh as f32 - 1.0);
        let (y0, ty) = (fy.floor() as usize, fy - fy.floor());
        let y1 = (y0 + 1).min(sh - 1);
        let fx = ((x as f32 + 0.5) * k - 0.5).clamp(0.0, sw as f32 - 1.0);
        let (x0, tx) = (fx.floor() as usize, fx - fx.floor());
        let x1 = (x0 + 1).min(sw - 1);
        let top = small[y0 * sw + x0] * (1.0 - tx) + small[y0 * sw + x1] * tx;
        let bot = small[y1 * sw + x0] * (1.0 - tx) + small[y1 * sw + x1] * tx;
        top * (1.0 - ty) + bot * ty
    })
}

/// A wide, soft blur done on a shrunk copy: for blurs of 8 px and more the result is the same to the eye and far quicker. The
/// shrink is by a power of two no bigger than `unit`, and the work box starts on a multiple of `unit` of the whole picture, so a
/// window of the picture is shrunk on the same grid as the whole and gives the same answer.
fn blur_fast_unit(plane: &[f32], w: usize, h: usize, sigma: f32, unit: usize) -> Vec<f32> {
    let want = ((sigma / 3.0).floor() as usize).clamp(1, 8).min(unit);
    let d = [8usize, 4, 2, 1].into_iter().find(|d| *d <= want).unwrap_or(1);
    if d < 2 || w < 16 || h < 16 {
        return blur_plane(plane, w, h, sigma);
    }
    let (small, sw, sh) = shrink(plane, w, h, d);
    grow(&blur_plane(&small, sw, sh, sigma / d as f32), sw, sh, w, h, d)
}

fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/// Retouch `window`, the part of the whole picture that starts at (ox, oy). `src` is the whole picture, read
/// only for the reference skin colour. For a whole-picture render the window is a copy of `src`.
pub fn apply_portrait_window(window: &mut RgbImage, ox: u32, oy: u32, src: &RgbImage, portrait: &Portrait) {
    let p = portrait.sanitized();
    if !p.is_active() {
        return;
    }
    let t0 = std::time::Instant::now();
    let tick = |what: &str| if std::env::var("LUCENT_TIME").is_ok() { eprintln!("    {what}: {:.2} s", t0.elapsed().as_secs_f32()) };
    let (fw, fh) = (src.width() as f32, src.height() as f32);
    let scale = fw.max(fh) / 2048.0;
    let (ww, wh) = (window.width() as i64, window.height() as i64);
    let (face, le, re, mouth) = (Shape::new(&p.face, fw, fh, p.roll), Shape::new(&p.left_eye, fw, fh, p.roll), Shape::new(&p.right_eye, fw, fh, p.roll), Shape::new(&p.mouth, fw, fh, p.roll));

    // which pixels are skin, eyes, mouth, hair: asked of the face parser once per face (it remembers), with the ellipses and colour tests as a fallback
    let parts = if USE_PARSER.load(std::sync::atomic::Ordering::Relaxed) && (p.skin_active() || p.teeth_active() || p.eyes_active() || p.features_active()) { crate::parsing::parse(src, face.cx, face.cy, face.rx.max(face.ry), p.roll.to_radians()).ok() } else { None };

    tick("parser");
    // the box that holds every region that has work to do, in picture pixels, clipped to the window
    let mut boxes = Vec::new();
    if p.skin_active() {
        boxes.push(face.bbox(1.15));
        if p.skin.body > 0.0 {
            // the neck, shoulders and arms: as far as nine face heights from the middle of the face
            let m = face.rx.max(face.ry) * 9.0;
            boxes.push((face.cx - m, face.cy - m, face.cx + m, face.cy + m));
        }
    }
    if p.teeth_active() {
        boxes.push(mouth.bbox(1.1));
    }
    if p.features_active() {
        boxes.push(face.bbox(1.15));
    }
    if p.eyes_active() {
        boxes.push(le.bbox(1.1));
        boxes.push(re.bbox(1.1));
    }
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for b in &boxes {
        (x0, y0, x1, y1) = (x0.min(b.0), y0.min(b.1), x1.max(b.2), y1.max(b.3));
    }
    let (wx0, wy0) = (ox as i64, oy as i64);
    let (ix0, iy0) = ((x0.floor() as i64).max(wx0), (y0.floor() as i64).max(wy0));
    let (ix1, iy1) = ((x1.ceil() as i64).min(wx0 + ww - 1), (y1.ceil() as i64).min(wy0 + wh - 1));
    if ix0 > ix1 || iy0 > iy1 {
        return;
    }
    // the blur needs to see past the work box
    let pad = ((REACH - 10.0) * scale).ceil() as i64;
    // the wide blurs run on shrunk copies: the work box starts on the shrink grid of the whole picture (see blur_fast_unit)
    let unit: usize = 8;
    let blur_fast = |plane: &[f32], w: usize, h: usize, sigma: f32| blur_fast_unit(plane, w, h, sigma, unit);
    let on_grid = |v: i64| v.div_euclid(unit as i64) * unit as i64;
    let (bx0, by0) = (on_grid(ix0 - pad).max(wx0), on_grid(iy0 - pad).max(wy0));
    let (bx1, by1) = ((ix1 + pad).min(wx0 + ww - 1), (iy1 + pad).min(wy0 + wh - 1));
    let (bw, bh) = ((bx1 - bx0 + 1) as usize, (by1 - by0 + 1) as usize);
    let at = |gx: i64, gy: i64| (((gy - by0) as usize) * bw + (gx - bx0) as usize, (gx - wx0) as u32, (gy - wy0) as u32);

    let need_blemish = p.skin_active() && p.skin.blemishes > 0.0;
    let planes: [Vec<f32>; 3] = {
        let mut pl = [vec![0.0f32; bw * bh], vec![0.0f32; bw * bh], vec![0.0f32; bw * bh]];
        for gy in by0..=by1 {
            for gx in bx0..=bx1 {
                let (i, lx, ly) = at(gx, gy);
                let c = window.get_pixel(lx, ly);
                (0..3).for_each(|k| pl[k][i] = c[k] as f32);
            }
        }
        pl
    };
    tick("planes");
    // Sizes follow the face, not the picture: the pores of a headshot are many pixels wide, those of a face in a group less than one.
    // No blur may see further than the margin a window of the picture is given.
    let rface = face.rx.max(face.ry);
    let cap = ((REACH - 10.0) * scale / 3.0).max(1.0);
    let s_fine = (rface / 70.0 * (0.5 + 1.25 * p.skin.radius / 100.0)).clamp(1.0, cap); // below this size: pores and grain
    let s_mid = (rface / 9.0).clamp(s_fine * 2.0, cap.max(s_fine * 2.0)); // up to this size: blotches and uneven patches
    let s_far = (rface / 3.5).clamp(s_mid * 1.5, cap.max(s_mid * 1.5)); // beyond: the light that models the face, which is kept
    let n = bw * bh;
    let lumas: Vec<f32> = par_fill(bw, bh, |x, y| luma([planes[0][y * bw + x], planes[1][y * bw + x], planes[2][y * bw + x]]));
    // where the skin is, per pixel of the work box: from the parser, or from the colour when there is no parser
    let skin_mask: Vec<f32> = par_fill(bw, bh, |x, y| match &parts {
        Some(pt) => {
            // a full cheek or jaw is often called neck by the parser: inside the face outline it is face
            let (px, py) = ((bx0 + x as i64) as f32 + 0.5, (by0 + y as i64) as f32 + 0.5);
            let jaw = pt.neck_at(px, py) * (1.0 - smoothstep(0.95, 1.2, face.dist(px, py)));
            let neck = pt.neck_at(px, py) * if p.skin.body > 0.0 { 1.0 } else { 0.0 };
            smoothstep(0.3, 0.7, pt.skin_at(px, py) + jaw.max(neck))
        }
        None => skin_tone([planes[0][y * bw + x], planes[1][y * bw + x], planes[2][y * bw + x]]),
    });
    // skin well inside its own edges and clear of lashes, brows, lips, hair and glasses: only there are spots healed and patches evened
    let core: Vec<f32> = if p.skin_active() {
        let inside = blur_fast(&skin_mask, bw, bh, (rface / 40.0).clamp(1.0, cap));
        let clear: Vec<f32> = match &parts {
            Some(pt) => {
                let others: Vec<f32> = par_fill(bw, bh, |x, y| pt.others_at((bx0 + x as i64) as f32 + 0.5, (by0 + y as i64) as f32 + 0.5));
                blur_fast(&others, bw, bh, (rface / 25.0).clamp(1.0, cap)).iter().map(|v| 1.0 - smoothstep(0.25, 0.5, *v)).collect() // a real part, not the parser's small doubts
            }
            None => vec![1.0; n],
        };
        // and the colour of skin: a bead, a strap or a tattoo the parser took for skin is left as it is
        par_fill(bw, bh, |x, y| {
            let i = y * bw + x;
            smoothstep(0.75, 0.95, inside[i]) * clear[i] * smoothstep(0.15, 0.45, skin_tone([planes[0][i], planes[1][i], planes[2][i]]))
        })
    } else {
        Vec::new()
    };
    tick("masks");
    // the skin's own colour and light round each pixel, with everything that is not skin left out of the average
    let dens: std::cell::RefCell<Vec<(f32, std::sync::Arc<Vec<f32>>)>> = std::cell::RefCell::new(Vec::new());
    let skin_blur = |values: &[f32], sigma: f32| -> Vec<f32> {
        // the blurred mask is the same for every plane blurred at one size
        let known = dens.borrow().iter().find(|(s, _)| *s == sigma).map(|(_, d)| d.clone());
        let den = known.unwrap_or_else(|| {
            let d = std::sync::Arc::new(blur_fast(&skin_mask, bw, bh, sigma));
            dens.borrow_mut().push((sigma, d.clone()));
            d
        });
        let w: Vec<f32> = par_fill(bw, bh, |x, y| values[y * bw + x] * skin_mask[y * bw + x]);
        let num = blur_fast(&w, bw, bh, sigma);
        par_fill(bw, bh, |x, y| {
            let i = y * bw + x;
            if den[i] > 0.05 { num[i] / den[i] } else { values[i] }
        })
    };
    // The light of the skin at three sizes. Retouching is done on the brightness alone, as a gain on the pixel, so its colour and its
    // grain stay its own: what lies between `fine` and `mid` is the blotchiness that Even skin takes out, between `mid` and `far` the
    // unevenness that Even tone eases (dodge and burn), and beyond `far` the modelling of the face, which nothing here touches.
    let s = &p.skin;
    let bands: Option<(Vec<f32>, Vec<f32>, Vec<f32>)> = if p.skin_active() && (s.even_amount > 0.0 || s.tone > 0.0 || s.shine > 0.0 || s.dark_circles > 0.0 || s.blemishes > 0.0 || s.glow > 0.0 || s.crisp > 0.0) {
        Some((skin_blur(&lumas, s_fine), skin_blur(&lumas, s_mid), skin_blur(&lumas, s_far)))
    } else {
        None
    };
    tick("bands");
    let evened: Option<[Vec<f32>; 3]> = if p.skin_active() && s.colour > 0.0 {
        let chroma = |c: usize| -> Vec<f32> { skin_blur(&(0..n).map(|i| planes[c][i] - lumas[i]).collect::<Vec<f32>>(), s_mid) };
        Some([chroma(0), chroma(1), chroma(2)])
    } else {
        None
    };
    // spotness per pixel, and the colour of the surroundings with the spots themselves left out (a blur weighted by "skin that is not a spot")
    let (spots, healed): (Option<Vec<f32>>, Option<[Vec<f32>; 3]>) = if need_blemish {
        // A spot (a pimple, a mole, a speck) is a small round patch that is lighter, darker or redder than the skin right round it,
        // and still the colour of skin. It is looked for against its near surroundings, so the shading of a cheek does not hide it.
        let s_bg = (rface / 40.0).clamp(2.0, cap.max(2.0));
        let spot_r = (rface / 32.0).max(2.5); // the biggest radius a spot may have: bigger patches are shading, and healing them smudges
        let min_area = (std::f32::consts::PI * (rface / 260.0).powi(2)).max(4.0) as usize; // smaller than this is a pore
        let calm = blur_plane(&lumas, bw, bh, (rface / 400.0).max(0.7)); // without the noise of single pixels
        let redness: Vec<f32> = par_fill(bw, bh, |x, y| planes[0][y * bw + x] - planes[1][y * bw + x]);
        let yellow: Vec<f32> = par_fill(bw, bh, |x, y| planes[1][y * bw + x] - planes[2][y * bw + x]);
        let (light_bg, red_bg, yellow_bg) = (skin_blur(&calm, s_bg), skin_blur(&redness, s_bg), skin_blur(&yellow, s_bg));
        let raw: Vec<f32> = par_fill(bw, bh, |x, y| {
            let i = y * bw + x;
            let off = (calm[i] - light_bg[i]).abs();
            let (red_off, yellow_off) = (redness[i] - red_bg[i], (yellow[i] - yellow_bg[i]).abs());
            let spot = smoothstep(8.0, 16.0, off).max(smoothstep(12.0, 26.0, red_off));
            // a lash, a bead, a frame or a catchlight is far from the skin in light or in colour: not a blemish
            spot * core[i] * (1.0 - smoothstep(60.0, 85.0, off)) * (1.0 - smoothstep(48.0, 72.0, red_off.abs())) * (1.0 - smoothstep(48.0, 72.0, yellow_off))
        });
        // small and roundish only: nostrils, folds, wrinkles, strands and strings are left alone
        let blobs = small_blobs(&raw, bw, bh, spot_r, min_area);
        if let Ok(out) = std::env::var("LUCENT_SPOTS_OUT") {
            // for looking at what the spot finder sees: red is every candidate, green the ones kept, blue the skin it may work on
            let shown = image::RgbImage::from_fn(bw as u32, bh as u32, |x, y| {
                let i = y as usize * bw + x as usize;
                image::Rgb([(raw[i] * 255.0) as u8, (blobs[i] * 255.0) as u8, (core[i] * 120.0) as u8])
            });
            let _ = shown.save(&out);
            let _ = std::fs::write(format!("{out}.txt"), format!("{bx0} {by0} rface {rface} s_bg {s_bg} spot_r {spot_r} min_area {min_area}"));
        }
        // the whole spot goes, with a soft edge a little wider than it
        let solid: Vec<f32> = blobs.iter().map(|b| if *b > 0.0 { 1.0 } else { 0.0 }).collect();
        let spots: Vec<f32> = blur_plane(&solid, bw, bh, (rface / 250.0).max(0.9)).iter().map(|v| if *v < 0.02 { 0.0 } else { (v * 3.0).min(1.0) }).collect();
        let keep: Vec<f32> = par_fill(bw, bh, |x, y| (1.0 - spots[y * bw + x]) * skin_mask[y * bw + x]);
        let den = blur_fast(&keep, bw, bh, s_bg);
        let weighted = |c: usize| -> Vec<f32> {
            let w: Vec<f32> = par_fill(bw, bh, |x, y| planes[c][y * bw + x] * keep[y * bw + x]);
            let num = blur_fast(&w, bw, bh, s_bg);
            (0..n).map(|i| if den[i] > 0.02 { num[i] / den[i] } else { planes[c][i] }).collect()
        };
        (Some(spots), Some([weighted(0), weighted(1), weighted(2)]))
    } else {
        (None, None)
    };
    tick("colour and spots");
    let reference = if p.skin_active() { reference_skin(src, &face) } else { None };

    let impact = p.skin.impact / 100.0;
    let body = p.skin.body / 100.0;
    // the hue and saturation of the face's skin: the neck and arms are the same colour in other light
    let reference_hs = reference.map(|c| {
        let (h, sat, _) = rgb_to_hsl([c[0] / 255.0, c[1] / 255.0, c[2] / 255.0]);
        (h, sat)
    });
    let eye_vals = [p.eye_values(true), p.eye_values(false)];
    let (iw, ih) = ((ix1 - ix0 + 1) as usize, (iy1 - iy0 + 1) as usize);
    let mut out = vec![0u8; iw * ih * 3];
    par_bands(&mut out, iw * 3, |row0, band| {
        for (ry, row) in band.chunks_exact_mut(iw * 3).enumerate() {
        let gy = iy0 + (row0 + ry) as i64;
        for cx in 0..iw {
            let gx = ix0 + cx as i64;
            let (i, _, _) = at(gx, gy);
            let (x, y) = (gx as f32 + 0.5, gy as f32 + 0.5);
            let orig = [planes[0][i], planes[1][i], planes[2][i]];
            let mut v = orig;
            let l0 = luma(orig);

            // ---- skin
            if p.skin_active() {
                let s = &p.skin;
                let fdist = face.dist(x, y);
                let region = (1.0 - smoothstep(0.7, 1.0, fdist))
                    * (1.0 - le.weight(x, y, 0.75))
                    * (1.0 - re.weight(x, y, 0.75))
                    * (1.0 - mouth.weight(x, y, 0.85));
                let mut on_skin = match &parts {
                    Some(pt) => smoothstep(0.3, 0.7, pt.skin_at(x, y) + pt.neck_at(x, y) * (1.0 - smoothstep(0.95, 1.2, fdist))) * (1.0 - smoothstep(1.1, 1.5, fdist)),
                    None => region * skin_tone(orig),
                };
                if body > 0.0 {
                    if let Some(pt) = &parts {
                        on_skin = on_skin.max(body * smoothstep(0.3, 0.7, pt.neck_at(x, y)));
                    }
                    // below the chin, in the face's own frame: the neck and shoulders, and the arms out to the sides
                    let (px, py) = face.local(x, y);
                    let (ax, ay) = (px.abs() / face.rx, py / face.ry);
                    let zone = smoothstep(0.75, 1.1, ay) * (1.0 - smoothstep(7.5, 9.0, ay)) * (1.0 - smoothstep(5.5, 7.0, ax));
                    if zone > 0.0 {
                        let like = match reference_hs {
                            Some((hr, sr)) => {
                                let (h, sat, _) = rgb_to_hsl([orig[0] / 255.0, orig[1] / 255.0, orig[2] / 255.0]);
                                let dh = ((h - hr + 540.0) % 360.0 - 180.0).abs();
                                skin_tone(orig) * (1.0 - smoothstep(14.0, 30.0, dh)) * (1.0 - smoothstep(0.35, 0.75, ((sat + 0.01) / (sr + 0.01)).ln().abs()))
                            }
                            None => skin_tone(orig),
                        };
                        on_skin = on_skin.max(body * zone * like * (1.0 - mouth.weight(x, y, 0.85)));
                    }
                }
                if on_skin > 0.0 {
                    let k = impact * on_skin;
                    let kc = k * core[i]; // evening and healing keep clear of the skin's edges and of lashes, brows, lips, hair and glasses
                    let mut grain = 0.0; // how much lighter or darker this pixel is than the skin right round it
                    if let Some((fine, mid, far)) = &bands {
                        grain = l0 - fine[i];
                        let mut l = l0;
                        let a = s.even_amount / 100.0;
                        if a > 0.0 {
                            // blotches are evened; the grain is turned down only as far as the Texture slider says
                            l -= (fine[i] - mid[i]) * 0.75 * a * kc;
                            l -= grain * (1.0 - s.even_texture / 100.0) * a * k;
                        }
                        if s.tone > 0.0 {
                            // dodge and burn: a hollow is lifted and a bright patch eased towards the light of the skin around it
                            l -= (mid[i] - far[i]) * 0.5 * s.tone / 100.0 * kc;
                        }
                        if s.shine > 0.0 {
                            // shine: a bright, colourless highlight is brought down towards the skin beside it
                            let (_, sat, _) = rgb_to_hsl([orig[0] / 255.0, orig[1] / 255.0, orig[2] / 255.0]);
                            let spec = smoothstep(10.0, 36.0, l0 - mid[i]) * (1.0 - smoothstep(0.3, 0.6, sat));
                            l -= (l0 - mid[i]) * 0.7 * s.shine / 100.0 * spec * k;
                        }
                        if s.glow > 0.0 {
                            // highlights: where the light already sits on the face (forehead, nose, cheekbones) it is brought out
                            l += (mid[i] - far[i]).max(0.0) * 0.9 * s.glow / 100.0 * kc;
                        }
                        if s.crisp > 0.0 {
                            // texture: the fine grain of the skin is brought out, but not a spot that is being healed
                            let spot = spots.as_ref().map_or(0.0, |sp| sp[i]);
                            l += grain.clamp(-40.0, 40.0) * 0.8 * s.crisp / 100.0 * kc * (1.0 - spot);
                        }
                        // dark circles: the hollow under each eye is lifted towards the usual lightness of the face
                        if let (Some(refc), true) = (reference, s.dark_circles > 0.0) {
                            for eye in [&le, &re] {
                                let (c, sn) = (eye.ang.cos(), eye.ang.sin());
                                let below = eye.ry * 2.2; // under the eye, along the face's own downward direction
                                let hollow = Shape { cx: eye.cx - sn * below, cy: eye.cy + c * below, rx: eye.rx * 1.3, ry: eye.ry * 1.9, ang: eye.ang };
                                let w = hollow.weight(x, y, 0.3);
                                let short = (luma(refc) * 0.95 - fine[i]).clamp(0.0, 60.0);
                                if w > 0.0 && short > 0.0 {
                                    l += short * 0.75 * s.dark_circles / 100.0 * w * kc;
                                }
                            }
                        }
                        let f = (l / l0.max(1.0)).clamp(0.6, 1.7);
                        (0..3).for_each(|c| v[c] *= f);
                    }
                    // blotches of colour move towards the usual colour of the skin, brightness untouched
                    if let Some(evened) = &evened {
                        let lv = luma(v);
                        (0..3).for_each(|c| v[c] += (evened[c][i] - (v[c] - lv)) * 0.6 * s.colour / 100.0 * kc);
                    }
                    if let (Some(spots), Some(healed)) = (&spots, &healed) {
                        if spots[i] > 0.0 {
                            // the colour of the skin around the spot, with the grain of the skin beside it laid on top, so the patch
                            // has pores like its surroundings and does not look smoothed over
                            let beside = {
                                let step = (rface / 6.0).max(4.0) as usize;
                                let x = i % bw;
                                // from clean skin only (to the right, or else to the left): the grain of a lash or a lip is not skin
                                let clean = |j: usize| core[j] > 0.9 && spots[j] == 0.0;
                                let j = [x + step < bw, x >= step].iter().zip([i + step, i.saturating_sub(step)]).find(|(ok, j)| **ok && clean(*j)).map(|(_, j)| j);
                                match (&bands, j) {
                                    (Some((fine, _, _)), Some(j)) => (lumas[j] - fine[j]).clamp(-12.0, 12.0),
                                    _ => 0.0,
                                }
                            };
                            let target = [healed[0][i] + beside, healed[1][i] + beside, healed[2][i] + beside];
                            v = lerp3(v, target, (s.blemishes / 100.0 * k * spots[i]).min(1.0));
                        }
                    }
                }
                // contouring: light in the middle of the face, shade round its edge (or the reverse)
                if p.skin.contouring != 0.0 {
                    let centre = 1.0 - smoothstep(0.0, 0.7, fdist);
                    let rim = smoothstep(0.55, 1.0, fdist) * (1.0 - smoothstep(1.0, 1.12, fdist));
                    let m = 1.0 + p.skin.contouring / 100.0 * impact * (0.10 * centre - 0.18 * rim);
                    (0..3).for_each(|c| v[c] *= m);
                }
            }

            // ---- teeth
            if p.teeth_active() {
                let mw = match &parts {
                    Some(pt) => smoothstep(0.3, 0.7, pt.mouth_at(x, y)),
                    None => mouth.weight(x, y, 0.3),
                };
                if mw > 0.0 {
                    let (hi, lo) = (orig[0].max(orig[1]).max(orig[2]), orig[0].min(orig[1]).min(orig[2]));
                    let (l, sv) = ((hi + lo) / 510.0, (hi - lo) / hi.max(1.0));
                    let red = (orig[0] - orig[1].max(orig[2])) / 255.0;
                    let tooth = smoothstep(0.35, 0.5, l) * (1.0 - smoothstep(0.3, 0.5, sv)) * (1.0 - smoothstep(0.12, 0.25, red));
                    let t = mw * tooth;
                    if t > 0.0 {
                        if p.teeth.desaturation > 0.0 {
                            let g = luma(v);
                            v = lerp3(v, [g, g, g], p.teeth.desaturation / 100.0 * 0.85 * t);
                        }
                        let b = p.teeth.brightness / 100.0;
                        if b > 0.0 {
                            (0..3).for_each(|c| v[c] = (v[c] * (1.0 + b * 0.3 * t)).min(v[c].max(238.0)));
                        } else if b < 0.0 {
                            (0..3).for_each(|c| v[c] *= 1.0 + b * 0.35 * t);
                        }
                    }
                }
            }

            // ---- eyes
            if p.eyes_active() {
                for (eye, vals) in [&le, &re].into_iter().zip(eye_vals) {
                    // the eye is where the parser says there is eye, near this eye's own marking; a closed eye has none
                    let ew = match &parts {
                        Some(pt) => smoothstep(0.25, 0.6, pt.eyes_at(x, y)) * (1.0 - smoothstep(1.3, 2.2, eye.dist(x, y))),
                        None => eye.weight(x, y, 0.7),
                    };
                    if ew <= 0.0 || (vals.iris == 0.0 && vals.sclera == 0.0) {
                        continue;
                    }
                    let n = [orig[0] / 255.0, orig[1] / 255.0, orig[2] / 255.0];
                    let (_, s, l) = rgb_to_hsl(n);
                    let white = smoothstep(0.45, 0.6, l) * (1.0 - smoothstep(0.25, 0.45, s));
                    let pupil = 1.0 - smoothstep(0.08, 0.16, l);
                    let iris = (1.0 - white) * (1.0 - pupil) * ew * ew * (1.0 - skin_tone(orig) * 0.5);
                    let white = white * ew;
                    let sc = vals.sclera / 100.0;
                    if sc > 0.0 {
                        let g = luma(v);
                        let redness = smoothstep(0.02, 0.15, (v[0] - v[1].max(v[2])) / 255.0);
                        v = lerp3(v, [g, g, g], 0.5 * sc * redness * white);
                        v = lerp3(v, [245.0; 3], 0.3 * sc * white);
                    } else if sc < 0.0 {
                        (0..3).for_each(|c| v[c] *= 1.0 + sc * 0.35 * white);
                    }
                    let ir = vals.iris / 100.0;
                    if ir != 0.0 {
                        let g = luma(v);
                        (0..3).for_each(|c| v[c] = (v[c] + (v[c] - g) * 0.25 * ir * iris) * (1.0 + 0.1 * ir * iris));
                    }
                }
            }
            // ---- lips and brows, where the parser says they are
            if let (Some(pt), true) = (&parts, p.features_active()) {
                if p.lips != 0.0 {
                    let w = smoothstep(0.35, 0.7, pt.lips_at(x, y)) * p.lips / 100.0;
                    if w != 0.0 {
                        let g = luma(v);
                        (0..3).for_each(|c| v[c] = (g + (v[c] - g) * (1.0 + 0.5 * w)) * (1.0 - 0.06 * w));
                    }
                }
                if p.brows != 0.0 {
                    let w = smoothstep(0.35, 0.7, pt.brows_at(x, y)) * p.brows / 100.0;
                    if w != 0.0 {
                        (0..3).for_each(|c| v[c] *= 1.0 - 0.22 * w);
                    }
                }
            }
            (0..3).for_each(|c| row[cx * 3 + c] = (v[c] + 0.5).clamp(0.0, 255.0) as u8);
        }
        }
    });
    tick("pixels");
    for cy in 0..ih {
        for cx in 0..iw {
            let px = window.get_pixel_mut((ix0 + cx as i64 - wx0) as u32, (iy0 + cy as i64 - wy0) as u32);
            let o = (cy * iw + cx) * 3;
            px.0 = [out[o], out[o + 1], out[o + 2]];
        }
    }
}

/// Retouch a whole picture with one face.
#[cfg(test)]
pub fn apply_portrait(img: &RgbImage, portrait: &Portrait) -> RgbImage {
    let mut out = img.clone();
    apply_portrait_window(&mut out, 0, 0, img, portrait);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    const BG: [u8; 3] = [120, 120, 125];
    const SKIN: [f32; 3] = [205.0, 150.0, 125.0];
    const HOLLOW: [f32; 3] = [175.0, 122.0, 105.0];
    const HAIR: [u8; 3] = [30, 20, 15];
    const BLEMISH: [u8; 3] = [165, 90, 80];
    const SCLERA: [u8; 3] = [235, 225, 225];
    const IRIS: [u8; 3] = [70, 110, 150];
    const LIPS: [u8; 3] = [175, 70, 80];
    const TEETH: [u8; 3] = [225, 215, 185];

    // A 400 x 500 face. Long edge 500, so a radius of 0.22 is 110 px.
    const W: u32 = 400;
    const H: u32 = 500;

    fn noise(x: u32, y: u32) -> f32 {
        let mut h = x.wrapping_mul(374761393).wrapping_add(y.wrapping_mul(668265263));
        h = (h ^ (h >> 13)).wrapping_mul(1274126177);
        ((h ^ (h >> 16)) % 1000) as f32 / 1000.0 - 0.5
    }
    fn inside(x: u32, y: u32, cx: f32, cy: f32, rx: f32, ry: f32) -> bool {
        ((x as f32 + 0.5 - cx) / rx).powi(2) + ((y as f32 + 0.5 - cy) / ry).powi(2) < 1.0
    }
    fn face_pixel(x: u32, y: u32) -> [u8; 3] {
        let n = noise(x, y) * 24.0;
        let skin = |c: [f32; 3]| [(c[0] + n) as u8, (c[1] + n) as u8, (c[2] + n) as u8];
        // eyes
        for ex in [150.0, 250.0] {
            if inside(x, y, ex, 210.0, 30.0, 12.0) {
                if inside(x, y, ex, 210.0, 4.0, 4.0) {
                    return [15, 15, 15];
                }
                if inside(x, y, ex, 210.0, 10.0, 10.0) {
                    return IRIS;
                }
                return SCLERA;
            }
        }
        // mouth: teeth inside lips
        if inside(x, y, 200.0, 320.0, 40.0, 16.0) {
            return if inside(x, y, 200.0, 320.0, 26.0, 8.0) { TEETH } else { LIPS };
        }
        if inside(x, y, 230.0, 280.0, 3.0, 3.0) {
            return BLEMISH;
        }
        if (170..230).contains(&x) && (140..146).contains(&y) && inside(x, y, 200.0, 250.0, 110.0, 120.0) {
            return HAIR;
        }
        if inside(x, y, 200.0, 250.0, 110.0, 120.0) {
            // the hollows under the eyes
            for ex in [150.0, 250.0] {
                if inside(x, y, ex, 236.0, 39.0, 23.0) {
                    return skin(HOLLOW);
                }
            }
            return skin(SKIN);
        }
        BG
    }
    fn face() -> RgbImage {
        ImageBuffer::from_fn(W, H, |x, y| Rgb(face_pixel(x, y)))
    }
    fn marked() -> Portrait {
        Portrait {
            face: Ellipse { cx: 0.5, cy: 0.5, rx: 0.22, ry: 0.24 },
            left_eye: Ellipse { cx: 0.375, cy: 0.42, rx: 0.06, ry: 0.024 },
            right_eye: Ellipse { cx: 0.625, cy: 0.42, rx: 0.06, ry: 0.024 },
            mouth: Ellipse { cx: 0.5, cy: 0.64, rx: 0.08, ry: 0.032 },
            ..Default::default()
        }
    }
    fn with(f: impl FnOnce(&mut Portrait)) -> Portrait {
        let mut p = marked();
        f(&mut p);
        p
    }
    fn at(img: &RgbImage, x: u32, y: u32) -> [f32; 3] {
        let p = img.get_pixel(x, y);
        [p[0] as f32, p[1] as f32, p[2] as f32]
    }
    /// Mean and variance of the brightness in a box.
    fn stats(img: &RgbImage, x0: u32, y0: u32, x1: u32, y1: u32) -> (f32, f32) {
        let v: Vec<f32> = (y0..y1).flat_map(|y| (x0..x1).map(move |x| (x, y))).map(|(x, y)| luma(at(img, x, y))).collect();
        let m = v.iter().sum::<f32>() / v.len() as f32;
        (m, v.iter().map(|a| (a - m).powi(2)).sum::<f32>() / v.len() as f32)
    }
    fn changed(a: &RgbImage, b: &RgbImage, x: u32, y: u32) -> bool {
        a.get_pixel(x, y) != b.get_pixel(x, y)
    }

    #[test]
    fn marking_the_regions_alone_changes_nothing() {
        let img = face();
        assert!(!marked().is_active());
        assert_eq!(apply_portrait(&img, &marked()), img);
        // impact at 0 switches the skin work off even with the sliders up
        let off = with(|p| {
            p.skin.impact = 0.0;
            p.skin.even_amount = 100.0;
            p.skin.blemishes = 100.0;
        });
        assert!(!off.is_active());
        assert_eq!(apply_portrait(&img, &off), img);
    }

    #[test]
    fn even_skin_smooths_texture_but_leaves_eyes_mouth_hair_and_the_background_alone() {
        let img = face();
        let out = apply_portrait(&img, &with(|p| {
            p.skin.even_amount = 100.0;
            p.skin.even_texture = 0.0;
        }));
        let (m0, v0) = stats(&img, 170, 262, 200, 276);
        let (m1, v1) = stats(&out, 170, 262, 200, 276);
        assert!(v1 < v0 * 0.5, "smoother: variance {v0} to {v1}");
        assert!((m1 - m0).abs() < 4.0, "same overall tone: {m0} to {m1}");
        assert!(!changed(&img, &out, 5, 5), "background");
        assert!(!changed(&img, &out, 150, 210) && !changed(&img, &out, 125, 210), "eye: {:?} {:?} / {:?} {:?}", at(&img, 150, 210), at(&out, 150, 210), at(&img, 125, 210), at(&out, 125, 210));
        assert!(!changed(&img, &out, 200, 320) && !changed(&img, &out, 230, 320), "mouth");
        assert!((140..146).all(|y| (175..225).all(|x| !changed(&img, &out, x, y))), "hair inside the face ellipse");
    }

    #[test]
    fn body_skin_smooths_the_neck_of_the_faces_colour_and_leaves_a_shirt_alone() {
        let mut img = face();
        for y in 380..470 {
            for x in 160..240 {
                let n = noise(x, y) * 24.0;
                img.put_pixel(x, y, Rgb([(SKIN[0] * 0.8 + n) as u8, (SKIN[1] * 0.8 + n) as u8, (SKIN[2] * 0.8 + n) as u8])); // the neck, in shade
            }
            for x in 250..330 {
                let n = noise(x, y) * 24.0;
                img.put_pixel(x, y, Rgb([(IRIS[0] as f32 + n) as u8, (IRIS[1] as f32 + n) as u8, (IRIS[2] as f32 + n) as u8])); // a blue shirt
            }
        }
        let run = |body: f32| {
            apply_portrait(&img, &with(|p| {
                p.skin.even_amount = 100.0;
                p.skin.even_texture = 0.0;
                p.skin.body = body;
            }))
        };
        let (_, v0) = stats(&img, 175, 400, 225, 450);
        let (_, v1) = stats(&run(100.0), 175, 400, 225, 450);
        assert!(v1 < v0 * 0.5, "the neck is smoother: {v0} to {v1}");
        assert_eq!(run(100.0).get_pixel(290, 420), img.get_pixel(290, 420), "the shirt is not skin");
        assert_eq!(run(0.0).get_pixel(200, 420), img.get_pixel(200, 420), "with Body skin at 0 the neck is left as it was");
    }

    #[test]
    fn keeping_texture_keeps_more_of_it() {
        let img = face();
        let run = |texture: f32| {
            let out = apply_portrait(&img, &with(|p| {
                p.skin.even_amount = 100.0;
                p.skin.even_texture = texture;
            }));
            stats(&out, 170, 262, 200, 276).1
        };
        let (a, b, c) = (run(0.0), run(50.0), run(100.0));
        assert!(a < b && b < c, "more texture kept, more variance left: {a} {b} {c}");
    }

    #[test]
    fn blemishes_are_healed_from_their_surroundings_and_the_slider_scales_it() {
        let img = face();
        let skin_here = at(&img, 215, 280); // plain skin next to the blemish at (230, 280)
        let before = (at(&img, 230, 280)[1] - skin_here[1]).abs();
        let full = apply_portrait(&img, &with(|p| p.skin.blemishes = 100.0));
        let half = apply_portrait(&img, &with(|p| p.skin.blemishes = 50.0));
        let (f, h) = ((at(&full, 230, 280)[1] - skin_here[1]).abs(), (at(&half, 230, 280)[1] - skin_here[1]).abs());
        assert!(f < before * 0.4, "mostly gone: {before} to {f}");
        assert!(f < h && h < before, "in between at half: {f} < {h} < {before}");
    }

    #[test]
    fn dark_circles_lift_the_hollow_under_the_eye_towards_the_skin_colour() {
        let img = face();
        let out = apply_portrait(&img, &with(|p| p.skin.dark_circles = 100.0));
        let hollow = (150, 240); // inside the band under the left eye, below the eye ellipse
        assert!(luma(at(&out, hollow.0, hollow.1)) > luma(at(&img, hollow.0, hollow.1)) + 12.0, "lighter");
        assert!(!changed(&img, &out, 200, 400), "cheeks far from the eyes are not touched");
        assert!(!changed(&img, &out, 150, 210), "the eye itself is not touched");
    }

    #[test]
    fn contouring_adds_light_in_the_middle_and_shade_at_the_rim_and_negative_does_the_reverse() {
        let img = face();
        let pos = apply_portrait(&img, &with(|p| p.skin.contouring = 100.0));
        let neg = apply_portrait(&img, &with(|p| p.skin.contouring = -100.0));
        let (centre, rim) = ((200, 270), (200 + 100, 250)); // 100 px from the middle, near the 110 px edge
        assert!(luma(at(&pos, centre.0, centre.1)) > luma(at(&img, centre.0, centre.1)));
        assert!(luma(at(&pos, rim.0, rim.1)) < luma(at(&img, rim.0, rim.1)) - 6.0);
        assert!(luma(at(&neg, centre.0, centre.1)) < luma(at(&img, centre.0, centre.1)));
        assert!(luma(at(&neg, rim.0, rim.1)) > luma(at(&img, rim.0, rim.1)) + 6.0);
    }

    #[test]
    fn teeth_get_brighter_and_less_yellow_and_the_lips_stay_as_they_are() {
        let img = face();
        let bright = apply_portrait(&img, &with(|p| p.teeth.brightness = 100.0));
        let plain = apply_portrait(&img, &with(|p| p.teeth.desaturation = 100.0));
        let tooth = (200, 320);
        assert!(luma(at(&bright, tooth.0, tooth.1)) > luma(at(&img, tooth.0, tooth.1)) + 8.0);
        let yellow = |i: &RgbImage| at(i, tooth.0, tooth.1)[0] - at(i, tooth.0, tooth.1)[2];
        assert!(yellow(&plain) < yellow(&img) * 0.4, "yellow taken out: {} to {}", yellow(&img), yellow(&plain));
        let lip = (166, 320); // inside the mouth ellipse, outside the teeth
        assert_eq!(at(&bright, lip.0, lip.1), at(&img, lip.0, lip.1), "lips untouched");
        assert_eq!(at(&plain, lip.0, lip.1), at(&img, lip.0, lip.1));
        let dark = apply_portrait(&img, &with(|p| p.teeth.brightness = -100.0));
        assert!(luma(at(&dark, tooth.0, tooth.1)) < luma(at(&img, tooth.0, tooth.1)) - 8.0);
    }

    #[test]
    fn sclera_whitens_and_removes_red_iris_gets_richer_and_the_pupil_stays_dark() {
        let img = face();
        let out = apply_portrait(&img, &with(|p| {
            p.eyes.both.sclera = 100.0;
            p.eyes.both.iris = 100.0;
        }));
        let white = (128, 210); // left eye, on the white
        assert!(luma(at(&out, white.0, white.1)) > luma(at(&img, white.0, white.1)) + 4.0, "whiter");
        let tint = |i: &RgbImage| at(i, white.0, white.1)[0] - at(i, white.0, white.1)[2];
        assert!(tint(&out) < tint(&img), "less red");
        let iris = (141, 210);
        let sat = |c: [f32; 3]| c[2] - c[0];
        assert!(sat(at(&out, iris.0, iris.1)) > sat(at(&img, iris.0, iris.1)) + 10.0, "bluer, richer");
        let pupil = at(&out, 150, 210);
        assert!(pupil[0] < 40.0, "pupil still dark: {pupil:?}");
        let off = apply_portrait(&img, &with(|p| p.eyes.both.sclera = -100.0));
        assert!(luma(at(&off, white.0, white.1)) < luma(at(&img, white.0, white.1)) - 10.0, "negative darkens the whites");
    }

    #[test]
    fn left_and_right_can_differ_and_add_to_both() {
        let img = face();
        let left_only = apply_portrait(&img, &with(|p| p.eyes.left.sclera = 100.0));
        assert!(changed(&img, &left_only, 128, 210), "the left eye changed");
        assert!(!changed(&img, &left_only, 272, 210), "the right did not");
        let mixed = with(|p| {
            p.eyes.both.sclera = 80.0;
            p.eyes.right.sclera = -80.0; // cancels out on the right
        });
        let out = apply_portrait(&img, &mixed);
        assert!(changed(&img, &out, 128, 210));
        assert!(!changed(&img, &out, 272, 210), "80 - 80 = nothing");
    }

    #[test]
    fn skin_tone_tells_skin_from_grey_blue_hair_and_white() {
        assert!(skin_tone([205.0, 150.0, 125.0]) > 0.9);
        assert!(skin_tone([160.0, 110.0, 90.0]) > 0.9);
        assert!(skin_tone([120.0, 120.0, 125.0]) < 0.1, "grey");
        assert!(skin_tone([70.0, 110.0, 150.0]) < 0.1, "blue");
        assert!(skin_tone([30.0, 20.0, 15.0]) < 0.1, "dark hair");
        assert!(skin_tone([240.0, 240.0, 240.0]) < 0.1, "white");
    }

    #[test]
    fn a_window_with_a_margin_matches_the_same_part_of_the_whole() {
        let img = face();
        let p = with(|p| {
            p.skin.even_amount = 80.0;
            p.skin.blemishes = 60.0;
            p.skin.dark_circles = 50.0;
            p.skin.contouring = 40.0;
            p.teeth.brightness = 50.0;
            p.eyes.both.sclera = 50.0;
        });
        let whole = apply_portrait(&img, &p);
        let scale = H as f32 / 2048.0;
        let margin = ((REACH + 2.0) * scale).ceil() as u32;
        let (x, y, w, h) = (120u32, 150u32, 160u32, 140u32);
        let (x0, y0) = (x - margin, y - margin);
        let mut win = image::imageops::crop_imm(&img, x0, y0, w + 2 * margin, h + 2 * margin).to_image();
        apply_portrait_window(&mut win, x0, y0, &img, &p);
        let got = image::imageops::crop_imm(&win, margin, margin, w, h).to_image();
        let want = image::imageops::crop_imm(&whole, x, y, w, h).to_image();
        let worst = got.pixels().zip(want.pixels()).flat_map(|(a, b)| (0..3).map(move |k| (a[k] as i32 - b[k] as i32).abs())).max().unwrap();
        assert!(worst <= 1, "differs by {worst}");
    }

    #[test]
    fn a_face_off_the_picture_or_marked_where_there_is_no_skin_does_no_harm() {
        let img = face();
        let off = with(|p| {
            p.face = Ellipse { cx: 1.4, cy: 1.4, rx: 0.1, ry: 0.1 };
            p.skin.even_amount = 100.0;
        });
        assert_eq!(apply_portrait(&img, &off), img);
        let on_wall = with(|p| {
            p.face = Ellipse { cx: 0.05, cy: 0.05, rx: 0.04, ry: 0.04 };
            p.skin.even_amount = 100.0;
            p.skin.blemishes = 100.0;
        });
        let out = apply_portrait(&img, &on_wall);
        assert!(!changed(&img, &out, 20, 25), "a grey wall is not skin, so nothing is smoothed or healed (contouring is a shape effect and does not look at colour)");
    }

    #[test]
    fn bad_values_are_clamped_and_missing_ones_take_their_defaults() {
        let bad = Portrait {
            face: Ellipse { cx: f32::NAN, cy: 9.0, rx: -1.0, ry: 99.0 },
            skin: Skin { impact: 500.0, blemishes: -4.0, even_amount: f32::NAN, even_texture: 900.0, contouring: -900.0, ..Default::default() },
            teeth: Teeth { brightness: 400.0, desaturation: -5.0 },
            eyes: Eyes { both: EyeAdjust { iris: 999.0, sclera: -999.0 }, ..Default::default() },
            ..Default::default()
        }
        .sanitized();
        assert_eq!((bad.face.cx, bad.face.cy, bad.face.rx, bad.face.ry), (0.5, 1.5, 0.004, 0.5));
        assert_eq!((bad.skin.impact, bad.skin.blemishes, bad.skin.even_amount, bad.skin.even_texture, bad.skin.contouring), (100.0, 0.0, 0.0, 100.0, -100.0));
        assert_eq!((bad.teeth.brightness, bad.teeth.desaturation), (100.0, 0.0));
        assert_eq!((bad.eyes.both.iris, bad.eyes.both.sclera), (100.0, -100.0));
        let loaded: Portrait = serde_json::from_str(r#"{"skin":{"blemishes":30}}"#).unwrap();
        assert_eq!((loaded.skin.impact, loaded.skin.even_texture, loaded.skin.blemishes), (100.0, 50.0, 30.0));
        assert_eq!(loaded.face, Portrait::default().face, "regions not in the file get a standard layout");
    }
}
