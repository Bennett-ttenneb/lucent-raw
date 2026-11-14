//! Spot removal: copy a round patch from one place to another, either exactly (clone) or after
//! matching it to its new surroundings (heal), or fill the spot with what the filling model (inpaint.rs) paints there.
//!
//! Positions are fractions of the cropped picture, like masks. Spots are applied before tone and
//! colour, on the picture's own pixels. Sources are always read from the picture as it was before
//! any spot, so spots do not depend on each other, and the work for a window of the picture equals
//! the same window of the whole.

use image::{Rgb, RgbImage};
use serde::{Deserialize, Serialize};

use crate::develop::smoothstep;

pub const MAX_SPOTS: usize = 50;
/// Points around the patch where the heal compares the surroundings of the target and the source.
const BOUNDARY_POINTS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpotMode {
    Heal,
    Clone,
    /// Painted by the filling model from what is round the spot; the spot has no source.
    Fill,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spot {
    pub id: String,
    #[serde(default = "yes")]
    pub visible: bool,
    pub mode: SpotMode,
    /// Where the patch is painted (the spot to remove), and where it is copied from.
    pub x: f32,
    pub y: f32,
    pub sx: f32,
    pub sy: f32,
    /// Diameter, as a fraction of the picture's long edge.
    pub size: f32,
    /// 0 is a hard edge, 1 fades over the whole radius.
    #[serde(default)]
    pub feather: f32,
    #[serde(default = "one")]
    pub opacity: f32,
}

fn one() -> f32 {
    1.0
}

impl Spot {
    fn sanitized(&self) -> Spot {
        let f = |v: f32, lo: f32, hi: f32, d: f32| if v.is_finite() { v.clamp(lo, hi) } else { d };
        Spot {
            id: self.id.chars().take(64).collect(),
            visible: self.visible,
            mode: self.mode,
            x: f(self.x, -0.5, 1.5, 0.5),
            y: f(self.y, -0.5, 1.5, 0.5),
            sx: f(self.sx, -0.5, 1.5, 0.5),
            sy: f(self.sy, -0.5, 1.5, 0.5),
            size: f(self.size, 0.005, 0.3, 0.05),
            feather: f(self.feather, 0.0, 1.0, 0.5),
            opacity: f(self.opacity, 0.0, 1.0, 1.0),
        }
    }
}

/// At most MAX_SPOTS, unique non-empty ids, every value in range.
pub fn sanitize_spots(spots: &[Spot]) -> Vec<Spot> {
    let mut seen = std::collections::HashSet::new();
    spots.iter().map(Spot::sanitized).filter(|s| !s.id.is_empty() && seen.insert(s.id.clone())).take(MAX_SPOTS).collect()
}

fn px(img: &RgbImage, x: i64, y: i64) -> [f32; 3] {
    let p = img.get_pixel(x.clamp(0, img.width() as i64 - 1) as u32, y.clamp(0, img.height() as i64 - 1) as u32);
    [p[0] as f32, p[1] as f32, p[2] as f32]
}

/// The average colour of a small square patch around a point (clamped to the picture).
fn patch_mean(img: &RgbImage, cx: f32, cy: f32, half: i64) -> [f32; 3] {
    let (mut sum, mut n) = ([0.0f32; 3], 0.0f32);
    for dy in -half..=half {
        for dx in -half..=half {
            let p = px(img, cx.round() as i64 + dx, cy.round() as i64 + dy);
            for k in 0..3 {
                sum[k] += p[k];
            }
            n += 1.0;
        }
    }
    [sum[0] / n, sum[1] / n, sum[2] / n]
}

/// Paint the spots into `window`, which is the part of the whole picture that starts at (ox, oy). `src` is the
/// whole picture (fw by fh) as it was before any spot. For a whole-picture render the window is a copy of `src`.
pub fn apply_spots_window(window: &mut RgbImage, ox: u32, oy: u32, src: &RgbImage, spots: &[Spot]) {
    let (fw, fh) = (src.width() as f32, src.height() as f32);
    let long = fw.max(fh);
    let (ww, wh) = (window.width() as i64, window.height() as i64);
    for spot in spots.iter().filter(|s| s.visible && s.opacity > 0.0) {
        let (tx, ty) = (spot.x * fw, spot.y * fh);
        let r = (spot.size * long / 2.0).max(1.0);
        // the part of the patch that lands inside this window
        let x0 = ((tx - r).floor() as i64).max(ox as i64);
        let x1 = ((tx + r).ceil() as i64).min(ox as i64 + ww - 1);
        let y0 = ((ty - r).floor() as i64).max(oy as i64);
        let y1 = ((ty + r).ceil() as i64).min(oy as i64 + wh - 1);
        if x0 > x1 || y0 > y1 {
            continue;
        }
        let (dx, dy) = (((spot.sx - spot.x) * fw).round() as i64, ((spot.sy - spot.y) * fh).round() as i64);
        // fill: the painting for this spot (made once and remembered); if the model cannot run, the spot is left as it is
        let fill = if spot.mode == SpotMode::Fill {
            match crate::inpaint::fill_cached(src, tx, ty, r) {
                Ok(f) => Some(f),
                Err(_) => continue,
            }
        } else {
            None
        };
        // heal: how the surroundings of the target differ from those of the source, all the way round the patch
        let mut offsets = [[0.0f32; 3]; BOUNDARY_POINTS];
        let mut edge = [(0.0f32, 0.0f32); BOUNDARY_POINTS];
        if spot.mode == SpotMode::Heal {
            let half = ((r * 0.15).round() as i64).max(1);
            for (i, (off, e)) in offsets.iter_mut().zip(edge.iter_mut()).enumerate() {
                let a = i as f32 / BOUNDARY_POINTS as f32 * std::f32::consts::TAU;
                let (ux, uy) = (a.cos(), a.sin());
                let (out_x, out_y) = (tx + ux * r * 1.15, ty + uy * r * 1.15);
                let (t, s) = (patch_mean(src, out_x, out_y, half), patch_mean(src, out_x + dx as f32, out_y + dy as f32, half));
                *off = [t[0] - s[0], t[1] - s[1], t[2] - s[2]];
                *e = (tx + ux * r, ty + uy * r);
            }
        }
        let inner = r * (1.0 - spot.feather);
        for gy in y0..=y1 {
            for gx in x0..=x1 {
                let (ddx, ddy) = (gx as f32 + 0.5 - tx, gy as f32 + 0.5 - ty);
                let d = (ddx * ddx + ddy * ddy).sqrt();
                if d >= r {
                    continue;
                }
                let weight = (1.0 - smoothstep(inner, r, d)) * spot.opacity;
                let mut value = match &fill {
                    Some(f) => {
                        let (fx, fy) = (gx - f.origin.0, gy - f.origin.1);
                        if fx >= 0 && fy >= 0 && (fx as u32) < f.picture.width() && (fy as u32) < f.picture.height() {
                            let p = f.picture.get_pixel(fx as u32, fy as u32);
                            [p[0] as f32, p[1] as f32, p[2] as f32]
                        } else {
                            px(src, gx, gy)
                        }
                    }
                    None => px(src, gx + dx, gy + dy),
                };
                if spot.mode == SpotMode::Heal {
                    // blend the boundary differences inward, nearer points counting more: a seamless edge, a smooth inside
                    let (mut acc, mut total) = ([0.0f32; 3], 0.0f32);
                    for (off, e) in offsets.iter().zip(&edge) {
                        let w = 1.0 / ((gx as f32 + 0.5 - e.0).powi(2) + (gy as f32 + 0.5 - e.1).powi(2) + 1.0);
                        for k in 0..3 {
                            acc[k] += off[k] * w;
                        }
                        total += w;
                    }
                    for k in 0..3 {
                        value[k] += acc[k] / total;
                    }
                }
                let (lx, ly) = ((gx - ox as i64) as u32, (gy - oy as i64) as u32);
                let cur = window.get_pixel(lx, ly);
                let mut out = [0u8; 3];
                for k in 0..3 {
                    out[k] = (cur[k] as f32 + (value[k].clamp(0.0, 255.0) - cur[k] as f32) * weight + 0.5).clamp(0.0, 255.0) as u8;
                }
                window.put_pixel(lx, ly, Rgb(out));
            }
        }
    }
}

/// Is there any spot that would change the picture? (Lets callers skip a copy of a big picture.)
pub fn any_visible(spots: &[Spot]) -> bool {
    spots.iter().any(|s| s.visible && s.opacity > 0.0)
}

/// Apply every spot to a whole picture.
pub fn apply_spots(img: &RgbImage, spots: &[Spot]) -> RgbImage {
    let mut out = img.clone();
    apply_spots_window(&mut out, 0, 0, img, spots);
    out
}

/// A good place to copy from for a spot at (x, y) of the given size (fractions of the picture): the nearby
/// patch whose surroundings look most like the surroundings of the spot, and which is itself plain.
pub fn suggest_source(img: &RgbImage, x: f32, y: f32, size: f32) -> (f32, f32) {
    let (fw, fh) = (img.width() as f32, img.height() as f32);
    let long = fw.max(fh);
    let r = (size * long / 2.0).max(1.0);
    let (tx, ty) = (x * fw, y * fh);
    let ring = |cx: f32, cy: f32| -> Vec<[f32; 3]> {
        (0..24)
            .map(|i| {
                let a = i as f32 / 24.0 * std::f32::consts::TAU;
                px(img, (cx + a.cos() * r * 1.3).round() as i64, (cy + a.sin() * r * 1.3).round() as i64)
            })
            .collect()
    };
    let target = ring(tx, ty);
    let mut best: Option<(f32, f32, f32)> = None; // score, x, y
    for dir in 0..16 {
        let a = dir as f32 / 16.0 * std::f32::consts::TAU;
        for mult in [2.6f32, 4.0, 6.0] {
            let (cx, cy) = (tx + a.cos() * r * mult, ty + a.sin() * r * mult);
            // the whole patch and its surroundings must be inside the picture
            if cx - r * 1.4 < 0.0 || cy - r * 1.4 < 0.0 || cx + r * 1.4 >= fw || cy + r * 1.4 >= fh {
                continue;
            }
            let candidate = ring(cx, cy);
            let ring_diff: f32 = target.iter().zip(&candidate).map(|(t, c)| (0..3).map(|k| (t[k] - c[k]).powi(2)).sum::<f32>()).sum::<f32>() / 24.0;
            // the patch itself should be plain: variance of its centre area
            let centre = (-2..=2).flat_map(|j| (-2..=2).map(move |i| (i, j))).map(|(i, j)| px(img, (cx + i as f32 * r * 0.4).round() as i64, (cy + j as f32 * r * 0.4).round() as i64)).collect::<Vec<_>>();
            let mean = centre.iter().fold([0.0f32; 3], |m, p| [m[0] + p[0], m[1] + p[1], m[2] + p[2]]).map(|v| v / centre.len() as f32);
            let variance = centre.iter().map(|p| (0..3).map(|k| (p[k] - mean[k]).powi(2)).sum::<f32>()).sum::<f32>() / centre.len() as f32;
            let score = ring_diff + variance * 0.5 + mult * 4.0; // a little preference for nearby
            if best.map_or(true, |b| score < b.0) {
                best = Some((score, cx, cy));
            }
        }
    }
    match best {
        Some((_, cx, cy)) => (cx / fw, cy / fh),
        // a picture too small for any candidate: just beside the spot
        None => (((tx + r * 3.0).min(fw - 1.0)) / fw, ty / fh),
    }
}

/// A speck found by `find_dust`: where it is and how big (fractions of the picture), and how strongly it stands out.
#[derive(Debug, Clone, PartialEq)]
pub struct Dust {
    pub x: f32,
    pub y: f32,
    pub size: f32,
    pub strength: f32,
}

/// Dust and sensor specks: small, compact dark patches that are darker than their surroundings, on a part of the picture that is otherwise
/// smooth (a speck on a textured area cannot be told from the texture). Returns the strongest, at most `MAX_SPOTS`.
pub fn find_dust(img: &RgbImage) -> Vec<Dust> {
    let (w, h) = (img.width() as usize, img.height() as usize);
    if w < 40 || h < 40 {
        return vec![];
    }
    let long = w.max(h) as f32;
    let grey: Vec<f32> = img.pixels().map(|p| 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32).collect();
    // the local average (a box of a few times the biggest speck), by an integral image
    let k = ((long / 120.0) as usize).clamp(6, 40);
    let mut integral = vec![0f64; (w + 1) * (h + 1)];
    for y in 0..h {
        let mut row = 0f64;
        for x in 0..w {
            row += grey[y * w + x] as f64;
            integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
        }
    }
    let local_mean = |x: usize, y: usize| -> f32 {
        let (x0, y0, x1, y1) = (x.saturating_sub(k), y.saturating_sub(k), (x + k + 1).min(w), (y + k + 1).min(h));
        let sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
        (sum / ((x1 - x0) * (y1 - y0)) as f64) as f32
    };
    let diff: Vec<f32> = (0..w * h).map(|i| local_mean(i % w, i / w) - grey[i]).collect();
    // how much a pixel must be darker than its surroundings: well above the usual noise in the picture
    let mut sample: Vec<f32> = diff.iter().step_by(7).map(|d| d.abs()).collect();
    sample.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let noise = sample[sample.len() / 2] * 1.4826;
    let threshold = (noise * 5.0).max(14.0);
    let max_diameter = (long * 0.012).max(6.0);
    let mut seen = vec![false; w * h];
    let mut out: Vec<Dust> = vec![];
    let mut stack: Vec<usize> = vec![];
    for start in 0..w * h {
        if seen[start] || diff[start] < threshold {
            continue;
        }
        // one connected patch of dark pixels
        let (mut minx, mut maxx, mut miny, mut maxy) = (usize::MAX, 0usize, usize::MAX, 0usize);
        let (mut n, mut sum, mut sx, mut sy) = (0usize, 0f32, 0f64, 0f64);
        stack.push(start);
        seen[start] = true;
        let mut too_big = false;
        while let Some(i) = stack.pop() {
            let (x, y) = (i % w, i / w);
            n += 1;
            sum += diff[i];
            sx += x as f64;
            sy += y as f64;
            minx = minx.min(x);
            maxx = maxx.max(x);
            miny = miny.min(y);
            maxy = maxy.max(y);
            if (maxx - minx) as f32 > max_diameter * 1.5 || (maxy - miny) as f32 > max_diameter * 1.5 {
                too_big = true;
            }
            if too_big {
                continue; // keep marking it seen, but stop collecting
            }
            for (nx, ny) in [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)] {
                if nx < w && ny < h && !seen[ny * w + nx] && diff[ny * w + nx] >= threshold * 0.6 {
                    seen[ny * w + nx] = true;
                    stack.push(ny * w + nx);
                }
            }
        }
        let (bw, bh) = ((maxx - minx + 1) as f32, (maxy - miny + 1) as f32);
        let on_border = minx == 0 || miny == 0 || maxx + 1 == w || maxy + 1 == h; // a patch cut by the picture edge is vignetting or a frame edge, not dust
        if too_big || on_border || n < 5 || bw.max(bh) > max_diameter || bw.max(bh) / bw.min(bh) > 2.4 || (n as f32) / (bw * bh) < 0.4 {
            continue;
        }
        let (cx, cy) = ((sx / n as f64) as f32, (sy / n as f64) as f32);
        // the ring just outside the speck must be plain: if it is busy, this is texture, not dust
        let ring_r = bw.max(bh) * 1.6 + 3.0;
        let (mut ring_sum, mut ring_sq, mut ring_n, mut ring_lighter) = (0f32, 0f32, 0f32, 0f32);
        let speck_grey = grey[cy as usize * w + cx as usize];
        for a in 0..16 {
            let t = a as f32 / 16.0 * std::f32::consts::TAU;
            let (rx, ry) = ((cx + t.cos() * ring_r).round() as i64, (cy + t.sin() * ring_r).round() as i64);
            if rx < 0 || ry < 0 || rx >= w as i64 || ry >= h as i64 {
                continue;
            }
            let v = grey[ry as usize * w + rx as usize];
            ring_sum += v;
            ring_sq += v * v;
            if v > speck_grey + threshold * 0.5 {
                ring_lighter += 1.0;
            }
            ring_n += 1.0;
        }
        if ring_n < 8.0 {
            continue;
        }
        // dust is darker than everything around it; a letter or a hair has dark neighbours on some side
        if ring_lighter < ring_n * 0.9 {
            continue;
        }
        let ring_sd = (ring_sq / ring_n - (ring_sum / ring_n).powi(2)).max(0.0).sqrt();
        let strength = sum / n as f32;
        if ring_sd > (strength * 0.3).max(noise * 2.0) {
            continue;
        }
        out.push(Dust { x: (cx + 0.5) / w as f32, y: (cy + 0.5) / h as f32, size: ((bw.max(bh) * 2.2 + 4.0) / long).clamp(0.006, 0.06), strength: strength * (n as f32).sqrt() });
    }
    out.sort_by(|a, b| b.strength.partial_cmp(&a.strength).unwrap());
    out.truncate(MAX_SPOTS);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::ImageBuffer;

    #[test]
    fn small_dark_specks_on_a_smooth_sky_are_found_and_texture_and_edges_are_not() {
        // a sky that gets lighter downwards, with a textured band and a hard edge, and five specks
        let (w, h) = (1000u32, 600u32);
        let mut img = RgbImage::from_fn(w, h, |x, y| {
            let sky = 90.0 + 80.0 * (y as f32 / h as f32);
            let texture = if (250..340).contains(&y) { 25.0 * ((x * 7 + y * 13) % 11) as f32 / 11.0 - 12.0 } else { 0.0 };
            let edge = if x > 750 { -50.0 } else { 0.0 };
            let v = (sky + texture + edge).clamp(0.0, 255.0) as u8;
            Rgb([v, v, (v as f32 * 0.9) as u8])
        });
        let specks = [(100u32, 60u32, 4i32), (330, 110, 3), (540, 450, 5), (200, 540, 3), (870, 50, 4)];
        for (cx, cy, r) in specks {
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx * dx + dy * dy <= r * r {
                        let p = img.get_pixel_mut((cx as i32 + dx) as u32, (cy as i32 + dy) as u32);
                        for k in 0..3 {
                            p[k] = (p[k] as f32 * 0.55) as u8;
                        }
                    }
                }
            }
        }
        let found = find_dust(&img);
        assert_eq!(found.len(), 5, "{found:?}");
        for (cx, cy, _) in specks {
            assert!(found.iter().any(|d| (d.x * w as f32 - cx as f32).abs() < 3.0 && (d.y * h as f32 - cy as f32).abs() < 3.0), "speck at {cx},{cy} found in {found:?}");
        }
        // a clean picture has none, and a tiny one is left alone
        let clean = RgbImage::from_fn(w, h, |_, y| Rgb([(90.0 + 80.0 * y as f32 / h as f32) as u8; 3]));
        assert!(find_dust(&clean).is_empty());
        assert!(find_dust(&RgbImage::new(10, 10)).is_empty());
    }

    fn spot(mode: SpotMode, x: f32, y: f32, sx: f32, sy: f32, size: f32) -> Spot {
        Spot { id: "s".into(), visible: true, mode, x, y, sx, sy, size, feather: 0.0, opacity: 1.0 }
    }
    fn flat(w: u32, h: u32, v: u8) -> RgbImage {
        ImageBuffer::from_pixel(w, h, Rgb([v; 3]))
    }
    fn mean_in(img: &RgbImage, cx: f32, cy: f32, r: f32) -> f32 {
        let (mut sum, mut n) = (0.0, 0.0);
        for y in 0..img.height() {
            for x in 0..img.width() {
                if ((x as f32 + 0.5 - cx).powi(2) + (y as f32 + 0.5 - cy).powi(2)).sqrt() < r {
                    sum += img.get_pixel(x, y)[0] as f32;
                    n += 1.0;
                }
            }
        }
        sum / n
    }

    #[test]
    fn clone_copies_the_source_exactly_and_only_inside_the_circle() {
        // a gradient so every pixel is different
        let img: RgbImage = ImageBuffer::from_fn(200, 100, |x, y| Rgb([(x as f32 * 1.2) as u8, (y * 2) as u8, 77]));
        let out = apply_spots(&img, &[spot(SpotMode::Clone, 0.25, 0.5, 0.75, 0.5, 0.1)]); // radius 10 px at (50,50), source (150,50)
        assert_eq!(out.get_pixel(50, 50).0, img.get_pixel(150, 50).0, "the centre is the source's centre");
        assert_eq!(out.get_pixel(55, 47).0, img.get_pixel(155, 47).0);
        assert_eq!(out.get_pixel(65, 50).0, img.get_pixel(65, 50).0, "outside the circle nothing changes");
        assert_eq!(out.get_pixel(150, 50).0, img.get_pixel(150, 50).0, "the source itself is untouched");
    }

    #[test]
    fn heal_removes_a_speck_on_a_plain_background() {
        let mut img = flat(200, 200, 120);
        for y in 95..105 {
            for x in 95..105 {
                img.put_pixel(x, y, Rgb([15, 15, 15])); // dust
            }
        }
        let out = apply_spots(&img, &[spot(SpotMode::Heal, 0.5, 0.5, 0.75, 0.5, 0.12)]);
        assert!((out.get_pixel(100, 100)[0] as i32 - 120).abs() <= 3, "the speck is gone: {}", out.get_pixel(100, 100)[0]);
        assert!((out.get_pixel(97, 103)[0] as i32 - 120).abs() <= 3);
    }

    #[test]
    fn heal_matches_the_surroundings_but_clone_does_not() {
        // left half 100, right half 140; a dark speck on the left, a clean source on the right
        let mut img: RgbImage = ImageBuffer::from_fn(240, 120, |x, _| Rgb([if x < 120 { 100 } else { 140 }; 3]));
        for y in 56..64 {
            for x in 56..64 {
                img.put_pixel(x, y, Rgb([20; 3]));
            }
        }
        let healed = apply_spots(&img, &[spot(SpotMode::Heal, 60.0 / 240.0, 0.5, 180.0 / 240.0, 0.5, 0.1)]);
        let cloned = apply_spots(&img, &[spot(SpotMode::Clone, 60.0 / 240.0, 0.5, 180.0 / 240.0, 0.5, 0.1)]);
        assert!((mean_in(&healed, 60.0, 60.0, 8.0) - 100.0).abs() < 6.0, "healed to the left side's brightness: {}", mean_in(&healed, 60.0, 60.0, 8.0));
        assert!((mean_in(&cloned, 60.0, 60.0, 8.0) - 140.0).abs() < 1.0, "a clone brings the right side's brightness with it");
    }

    #[test]
    fn heal_follows_a_slope_across_the_patch() {
        // brightness rises left to right everywhere; a patch healed from a flat-lit place must still ramp, with no jump at the edge
        let img: RgbImage = ImageBuffer::from_fn(300, 100, |x, _| Rgb([(40.0 + x as f32 * 0.5) as u8; 3]));
        let out = apply_spots(&img, &[spot(SpotMode::Heal, 0.3, 0.5, 0.8, 0.5, 0.12)]);
        let row: Vec<i32> = (60..120).map(|x| out.get_pixel(x, 50)[0] as i32).collect();
        let worst_step = row.windows(2).map(|w| (w[1] - w[0]).abs()).max().unwrap();
        assert!(worst_step <= 4, "no seam on the way across: {row:?}");
    }

    #[test]
    fn opacity_and_feather_blend_and_hidden_or_zero_spots_do_nothing() {
        let mut img = flat(200, 100, 100);
        for y in 0..100 {
            for x in 100..200 {
                img.put_pixel(x, y, Rgb([200; 3]));
            }
        }
        let base = spot(SpotMode::Clone, 0.25, 0.5, 0.75, 0.5, 0.2); // radius 20
        let half = apply_spots(&img, &[Spot { opacity: 0.5, ..base.clone() }]);
        assert!((half.get_pixel(50, 50)[0] as i32 - 150).abs() <= 1, "half way: {}", half.get_pixel(50, 50)[0]);
        let soft = apply_spots(&img, &[Spot { feather: 1.0, ..base.clone() }]);
        let (centre, rim) = (soft.get_pixel(50, 50)[0], soft.get_pixel(50 + 16, 50)[0]);
        assert!(centre > 190 && rim > 100 && rim < centre, "soft edge: centre {centre}, near the rim {rim}");
        assert_eq!(apply_spots(&img, &[Spot { visible: false, ..base.clone() }]), img);
        assert_eq!(apply_spots(&img, &[Spot { opacity: 0.0, ..base }]), img);
        assert_eq!(apply_spots(&img, &[]), img);
    }

    #[test]
    fn a_spot_at_the_edge_or_with_a_source_off_the_picture_does_not_break() {
        let img = flat(100, 80, 90);
        for s in [spot(SpotMode::Heal, 0.0, 0.0, 0.5, 0.5, 0.2), spot(SpotMode::Heal, 1.0, 1.0, 0.9, 0.9, 0.3), spot(SpotMode::Clone, 0.5, 0.5, 5.0, -5.0, 0.2), spot(SpotMode::Heal, -0.4, 0.5, 0.5, 0.5, 0.1)] {
            let out = apply_spots(&img, &[s.sanitized()]);
            assert_eq!((out.width(), out.height()), (100, 80));
        }
    }

    #[test]
    fn a_window_gets_the_same_pixels_as_the_same_part_of_the_whole() {
        let img: RgbImage = ImageBuffer::from_fn(300, 200, |x, y| {
            let n = ((x * 31 + y * 17) % 23) as f32;
            Rgb([(60.0 + x as f32 * 0.3 + n) as u8, (80.0 + y as f32 * 0.2 + n) as u8, (100.0 + n) as u8])
        });
        let spots = vec![
            spot(SpotMode::Heal, 0.3, 0.4, 0.7, 0.6, 0.12),
            spot(SpotMode::Clone, 0.55, 0.5, 0.2, 0.2, 0.09),
            Spot { id: "t".into(), ..spot(SpotMode::Heal, 0.62, 0.55, 0.1, 0.8, 0.15) },
        ];
        let whole = apply_spots(&img, &spots);
        for (x, y, w, h) in [(60u32, 40u32, 120u32, 80u32), (150, 80, 100, 100), (0, 0, 90, 90)] {
            let mut window = image::imageops::crop_imm(&img, x, y, w, h).to_image();
            apply_spots_window(&mut window, x, y, &img, &spots);
            assert_eq!(window, image::imageops::crop_imm(&whole, x, y, w, h).to_image(), "window {x},{y}");
        }
    }

    #[test]
    fn the_suggested_source_looks_like_the_surroundings_and_stays_inside() {
        // left third dark and plain, the rest bright and plain: a spot in the dark part should borrow from the dark part
        let img: RgbImage = ImageBuffer::from_fn(600, 300, |x, _| Rgb([if x < 250 { 50 } else { 210 }; 3]));
        let (sx, sy) = suggest_source(&img, 0.2, 0.5, 0.04);
        assert!(sx * 600.0 < 250.0, "borrowed from the dark side: {sx}");
        assert!((0.0..=1.0).contains(&sx) && (0.0..=1.0).contains(&sy));
        // it avoids a busy patch when a plain one is as near
        let busy: RgbImage = ImageBuffer::from_fn(600, 300, |x, y| if (180..240).contains(&x) && (120..180).contains(&y) { Rgb([if (x + y) % 2 == 0 { 0 } else { 255 }; 3]) } else { Rgb([100; 3]) });
        let (bx, by) = suggest_source(&busy, 0.2, 0.5, 0.05);
        assert!(!((180.0..240.0).contains(&(bx * 600.0)) && (120.0..180.0).contains(&(by * 300.0))), "not the busy patch");
        // a picture too small for any candidate still gives an answer
        let tiny = flat(20, 20, 128);
        let (tx, ty) = suggest_source(&tiny, 0.5, 0.5, 0.2);
        assert!(tx.is_finite() && ty.is_finite());
    }

    #[test]
    fn spots_are_cleaned_capped_and_survive_json() {
        let bad = Spot { id: "x".repeat(200), visible: true, mode: SpotMode::Heal, x: f32::NAN, y: 9.0, sx: -9.0, sy: 0.3, size: 5.0, feather: -1.0, opacity: 7.0 };
        let s = &sanitize_spots(&[bad.clone()])[0];
        assert_eq!((s.id.len(), s.x, s.y, s.sx, s.size, s.feather, s.opacity), (64, 0.5, 1.5, -0.5, 0.3, 0.0, 1.0));
        let many: Vec<Spot> = (0..80).map(|i| Spot { id: format!("s{}", i % 70), ..bad.clone() }).collect();
        assert_eq!(sanitize_spots(&many).len(), MAX_SPOTS);
        assert!(sanitize_spots(&[Spot { id: String::new(), ..bad.clone() }]).is_empty());
        let json = serde_json::to_string(&spot(SpotMode::Clone, 0.1, 0.2, 0.3, 0.4, 0.05)).unwrap();
        assert!(json.contains("\"mode\":\"clone\"") && json.contains("\"sx\":0.3"), "{json}");
        let back: Spot = serde_json::from_str(&json).unwrap();
        assert_eq!(back, spot(SpotMode::Clone, 0.1, 0.2, 0.3, 0.4, 0.05));
        let minimal: Spot = serde_json::from_str(r#"{"id":"a","mode":"heal","x":0.1,"y":0.2,"sx":0.3,"sy":0.4,"size":0.05}"#).unwrap();
        assert!(minimal.visible && minimal.opacity == 1.0 && minimal.feather == 0.0);
    }

    // ---- fill (the filling model) ----

    /// A smooth picture with a loud red blotch in it.
    fn blotched() -> (RgbImage, RgbImage) {
        let clean = RgbImage::from_fn(300, 200, |x, y| Rgb([(80 + x / 3) as u8, (100 + y / 3) as u8, 150]));
        let mut bad = clean.clone();
        for (x, y, p) in bad.enumerate_pixels_mut() {
            if ((x as f32 - 150.0).powi(2) + (y as f32 - 100.0).powi(2)).sqrt() < 24.0 {
                *p = Rgb([230, 20, 20]);
            }
        }
        (clean, bad)
    }

    #[test]
    fn a_fill_spot_replaces_the_blotch_with_what_belongs_there_and_leaves_the_rest_alone() {
        let (clean, bad) = blotched();
        // size is the diameter as a share of the long edge: 56 px of 300
        let fill = Spot { id: "f".into(), visible: true, mode: SpotMode::Fill, x: 0.5, y: 0.5, sx: 0.5, sy: 0.5, size: 56.0 / 300.0, feather: 0.2, opacity: 1.0 };
        let out = apply_spots(&bad, &[fill]);
        let err = |img: &RgbImage| -> f64 {
            let mut s = 0.0;
            let mut n = 0.0;
            for (x, y, p) in img.enumerate_pixels() {
                if ((x as f32 - 150.0).powi(2) + (y as f32 - 100.0).powi(2)).sqrt() < 20.0 {
                    let q = clean.get_pixel(x, y);
                    s += (0..3).map(|c| (p[c] as f64 - q[c] as f64).abs()).sum::<f64>() / 3.0;
                    n += 1.0;
                }
            }
            s / n
        };
        assert!(err(&out) < err(&bad) / 4.0 && err(&out) < 25.0, "before {:.1}, after {:.1}", err(&bad), err(&out));
        // nothing outside the spot is touched
        for (x, y, p) in out.enumerate_pixels() {
            if ((x as f32 - 150.0).powi(2) + (y as f32 - 100.0).powi(2)).sqrt() > 29.0 {
                assert_eq!(p, bad.get_pixel(x, y), "({x}, {y})");
            }
        }
    }

    #[test]
    fn a_fill_spot_in_a_window_gives_the_same_pixels_as_the_same_part_of_the_whole_and_zero_opacity_does_nothing() {
        let (_, bad) = blotched();
        let fill = Spot { id: "f".into(), visible: true, mode: SpotMode::Fill, x: 0.5, y: 0.5, sx: 0.5, sy: 0.5, size: 56.0 / 300.0, feather: 0.2, opacity: 1.0 };
        let whole = apply_spots(&bad, &[fill.clone()]);
        let mut window = image::imageops::crop_imm(&bad, 120, 70, 60, 60).to_image();
        apply_spots_window(&mut window, 120, 70, &bad, &[fill.clone()]);
        assert_eq!(window, image::imageops::crop_imm(&whole, 120, 70, 60, 60).to_image());
        let none = Spot { opacity: 0.0, ..fill };
        assert_eq!(apply_spots(&bad, &[none]), bad);
    }

    #[test]
    fn the_fill_mode_is_written_as_fill_and_older_recipes_still_load() {
        let s: Spot = serde_json::from_str(r#"{"id":"a","mode":"fill","x":0.1,"y":0.2,"sx":0.1,"sy":0.2,"size":0.05}"#).unwrap();
        assert_eq!(s.mode, SpotMode::Fill);
        assert!(serde_json::to_string(&s).unwrap().contains("\"mode\":\"fill\""));
        assert!(serde_json::from_str::<Spot>(r#"{"id":"a","mode":"magic","x":0.1,"y":0.2,"sx":0.1,"sy":0.2,"size":0.05}"#).is_err());
    }
}
