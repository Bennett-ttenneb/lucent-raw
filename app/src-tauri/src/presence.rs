//! The Presence sliders under Basic: **Texture**, **Clarity** and **Dehaze**.
//!
//! * **Texture** works on the finest detail (a few pixels across): positive brings out skin pores, bark and fabric; negative
//!   smooths them while keeping strong edges.
//! * **Clarity** works on medium detail (tens of pixels across): positive adds punch to the midtones, negative gives a soft glow.
//! * **Dehaze** takes out (positive) or puts in (negative) the milky veil of haze. Positive uses the dark-channel method: in a
//!   clear scene almost every small patch has some channel near black, so how far from black the darkest channel of a patch is
//!   tells how much haze lies over it; that is divided out, using an estimate of the colour of the haze (the airlight).
//!
//! Sizes are for a 2048 pixel wide picture and are scaled with the real size, so the preview and a full-size export look alike.
//! The airlight is worked out from the whole picture, so a piece cut out for the 100% view agrees with the whole.

use crate::develop::{blur_plane, par_bands};
use image::RgbImage;

/// Do any of the three do anything?
pub fn any(texture: f32, clarity: f32, dehaze: f32) -> bool {
    texture.abs() > 1e-4 || clarity.abs() > 1e-4 || dehaze.abs() > 1e-4
}

/// How far (in pixels of a 2048 wide picture) these look beyond a piece they are asked to draw.
pub fn reach(clarity: f32, dehaze: f32) -> f32 {
    if clarity.abs() > 1e-4 || dehaze.abs() > 1e-4 {
        48.0
    } else {
        8.0
    }
}

/// The slow-changing parts (the haze map, and the wide blur behind Clarity) are worked out on blocks this many pixels across and
/// scaled back up, which is many times quicker and looks the same, since those parts are smooth anyway. It follows the picture's
/// size, so a small preview and a big export see the same picture. 1 means full size.
pub fn grid(scale: f32) -> usize {
    ((scale * 3.2).round() as usize).clamp(1, 8)
}

/// The smallest value in each block of f x f pixels.
fn min_pool(plane: &[f32], w: usize, h: usize, f: usize) -> (Vec<f32>, usize, usize) {
    if f <= 1 {
        return (plane.to_vec(), w, h);
    }
    let (lw, lh) = (w.div_ceil(f), h.div_ceil(f));
    let mut out = vec![0.0f32; lw * lh];
    par_bands(&mut out, lw, |row0, band| {
        for (j, row) in band.chunks_mut(lw).enumerate() {
            let (y0, y1) = ((row0 + j) * f, ((row0 + j) * f + f).min(h));
            for (lx, v) in row.iter_mut().enumerate() {
                let (x0, x1) = (lx * f, (lx * f + f).min(w));
                let mut m = f32::MAX;
                for y in y0..y1 {
                    for p in &plane[y * w + x0..y * w + x1] {
                        m = m.min(*p);
                    }
                }
                *v = m;
            }
        }
    });
    (out, lw, lh)
}

/// The average of each block of f x f pixels.
fn box_down(plane: &[f32], w: usize, h: usize, f: usize) -> (Vec<f32>, usize, usize) {
    if f <= 1 {
        return (plane.to_vec(), w, h);
    }
    let (lw, lh) = (w.div_ceil(f), h.div_ceil(f));
    let mut out = vec![0.0f32; lw * lh];
    par_bands(&mut out, lw, |row0, band| {
        for (j, row) in band.chunks_mut(lw).enumerate() {
            let (y0, y1) = ((row0 + j) * f, ((row0 + j) * f + f).min(h));
            for (lx, v) in row.iter_mut().enumerate() {
                let (x0, x1) = (lx * f, (lx * f + f).min(w));
                let mut sum = 0.0f32;
                for y in y0..y1 {
                    sum += plane[y * w + x0..y * w + x1].iter().sum::<f32>();
                }
                *v = sum / ((y1 - y0) * (x1 - x0)) as f32;
            }
        }
    });
    (out, lw, lh)
}

/// A small plane made big again (smoothly, not in steps).
fn upsample(low: &[f32], lw: usize, lh: usize, f: usize, w: usize, h: usize) -> Vec<f32> {
    if f <= 1 {
        return low.to_vec();
    }
    let mut out = vec![0.0f32; w * h];
    par_bands(&mut out, w, |row0, band| {
        for (j, row) in band.chunks_mut(w).enumerate() {
            let fy = (((row0 + j) as f32 + 0.5) / f as f32 - 0.5).clamp(0.0, (lh - 1) as f32);
            let (y0, ty) = (fy.floor() as usize, fy - fy.floor());
            let y1 = (y0 + 1).min(lh - 1);
            for (x, v) in row.iter_mut().enumerate() {
                let fx = ((x as f32 + 0.5) / f as f32 - 0.5).clamp(0.0, (lw - 1) as f32);
                let (x0, tx) = (fx.floor() as usize, fx - fx.floor());
                let x1 = (x0 + 1).min(lw - 1);
                let top = low[y0 * lw + x0] * (1.0 - tx) + low[y0 * lw + x1] * tx;
                let bottom = low[y1 * lw + x0] * (1.0 - tx) + low[y1 * lw + x1] * tx;
                *v = top * (1.0 - ty) + bottom * ty;
            }
        }
    });
    out
}

fn luma(p: &[u8]) -> f32 {
    0.2126 * p[0] as f32 / 255.0 + 0.7152 * p[1] as f32 / 255.0 + 0.0722 * p[2] as f32 / 255.0
}

/// The colour of the haze: the average of the haziest tenth of a percent of the picture (the places where even the darkest
/// colour channel is bright), kept within a sensible range. Looks at a sample of the picture, so it is quick on a big one.
pub fn estimate_airlight(img: &RgbImage) -> [f32; 3] {
    let (w, h) = (img.width() as usize, img.height() as usize);
    if w == 0 || h == 0 {
        return [0.85; 3];
    }
    let step = (w.max(h) / 384).max(1);
    let raw = img.as_raw();
    let mut samples: Vec<(f32, [f32; 3])> = Vec::with_capacity((w / step + 1) * (h / step + 1));
    let mut y = 0;
    while y < h {
        let mut x = 0;
        while x < w {
            let i = (y * w + x) * 3;
            let c = [raw[i] as f32 / 255.0, raw[i + 1] as f32 / 255.0, raw[i + 2] as f32 / 255.0];
            samples.push((c[0].min(c[1]).min(c[2]), c));
            x += step;
        }
        y += step;
    }
    samples.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let top = (samples.len() / 1000).max(3).min(samples.len());
    let mut sum = [0.0f32; 3];
    for (_, c) in &samples[..top] {
        for k in 0..3 {
            sum[k] += c[k];
        }
    }
    [0, 1, 2].map(|k| (sum[k] / top as f32).clamp(0.55, 0.98))
}

/// Smallest value in a square window of radius `r` round each pixel (two passes, rows then columns).
fn min_filter(plane: &[f32], w: usize, h: usize, r: usize) -> Vec<f32> {
    let mut tmp = vec![0.0f32; plane.len()];
    par_bands(&mut tmp, w, |row0, band| {
        for (j, row) in band.chunks_mut(w).enumerate() {
            let src = &plane[(row0 + j) * w..(row0 + j + 1) * w];
            for (x, v) in row.iter_mut().enumerate() {
                let lo = x.saturating_sub(r);
                let hi = (x + r + 1).min(w);
                *v = src[lo..hi].iter().fold(f32::MAX, |a, b| a.min(*b));
            }
        }
    });
    let mut out = vec![0.0f32; plane.len()];
    par_bands(&mut out, w, |row0, band| {
        for (j, row) in band.chunks_mut(w).enumerate() {
            let y = row0 + j;
            let (lo, hi) = (y.saturating_sub(r), (y + r + 1).min(h));
            for (x, v) in row.iter_mut().enumerate() {
                let mut m = f32::MAX;
                for yy in lo..hi {
                    m = m.min(tmp[yy * w + x]);
                }
                *v = m;
            }
        }
    });
    out
}

/// Take haze out (`amount` above 0, up to 100) or put it in (below 0). `air` is the colour of the haze, from
/// `estimate_airlight`; `scale` is the picture's size against 2048 pixels.
pub fn apply_dehaze(img: &RgbImage, amount: f32, air: [f32; 3], scale: f32) -> RgbImage {
    if amount.abs() < 1e-4 || img.width() == 0 || img.height() == 0 {
        return img.clone();
    }
    let (w, h) = (img.width() as usize, img.height() as usize);
    let src = img.as_raw();
    let mut out = vec![0u8; src.len()];
    if amount < 0.0 {
        // a veil of the haze colour over everything
        let k = (-amount / 100.0).min(1.0) * 0.55;
        par_bands(&mut out, w * 3, |row0, band| {
            for (j, px) in band.iter_mut().enumerate() {
                let i = row0 * w * 3 + j;
                let a = air[i % 3];
                *px = ((src[i] as f32 / 255.0 * (1.0 - k) + a * k).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
        });
        return RgbImage::from_raw(w as u32, h as u32, out).expect("same size");
    }
    let s = (amount / 100.0).min(1.0);
    // how hazy each patch is: the darkest channel (against the haze colour) of the darkest pixel nearby
    let k = [1.0 / (255.0 * air[0]), 1.0 / (255.0 * air[1]), 1.0 / (255.0 * air[2])];
    let mut m = vec![0.0f32; w * h];
    par_bands(&mut m, w, |row0, band| {
        for (j, v) in band.iter_mut().enumerate() {
            let px = &src[(row0 * w + j) * 3..(row0 * w + j) * 3 + 3];
            *v = (px[0] as f32 * k[0]).min(px[1] as f32 * k[1]).min(px[2] as f32 * k[2]).min(1.0);
        }
    });
    // the haze map changes slowly, so it is worked out on blocks and scaled back up
    let f = grid(scale);
    let (m_low, lw, lh) = min_pool(&m, w, h, f);
    // a window about 10 pixels (of a 2048 wide picture) across, counted in blocks
    let radius = ((((10.0 * scale + 1.0) / f as f32 - 1.0) / 2.0).round() as usize).clamp(1, 48);
    let dark = min_filter(&m_low, lw, lh, radius);
    // the share of light that is the scene's own (the rest is haze); softened so it does not follow every edge
    let omega = 0.92 * s;
    let t0: Vec<f32> = dark.iter().map(|d| 1.0 - omega * d).collect();
    let t_low = blur_plane(&t0, lw, lh, (2.5 * scale / f as f32).max(0.8));
    let t = upsample(&t_low, lw, lh, f, w, h);
    par_bands(&mut out, w * 3, |row0, band| {
        for (r, row) in band.chunks_mut(w * 3).enumerate() {
            let y = row0 + r;
            for (x, px) in row.chunks_exact_mut(3).enumerate() {
                let inv = 1.0 / t[y * w + x].max(0.22);
                let i = (y * w + x) * 3;
                for c in 0..3 {
                    px[c] = (((src[i + c] as f32 * (1.0 / 255.0) - air[c]) * inv + air[c]).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                }
            }
        }
    });
    RgbImage::from_raw(w as u32, h as u32, out).expect("same size")
}

/// A blur for small sizes: two passes of a short Gaussian row, no turning of the picture on its side (quicker than the general
/// blur, which is made for big radii). For sigma up to about 2.5.
fn small_blur(plane: &[f32], w: usize, h: usize, sigma: f32) -> Vec<f32> {
    let r = ((sigma * 2.5).ceil() as usize).clamp(1, 7);
    let mut kern: Vec<f32> = (0..=2 * r).map(|i| (-(((i as f32 - r as f32) / sigma).powi(2)) / 2.0).exp()).collect();
    let total: f32 = kern.iter().sum();
    kern.iter_mut().for_each(|k| *k /= total);
    let mut tmp = vec![0.0f32; plane.len()];
    par_bands(&mut tmp, w, |row0, band| {
        for (j, row) in band.chunks_mut(w).enumerate() {
            let src = &plane[(row0 + j) * w..(row0 + j + 1) * w];
            for (x, v) in row.iter_mut().enumerate() {
                let mut acc = 0.0f32;
                for (i, k) in kern.iter().enumerate() {
                    acc += k * src[(x + i).saturating_sub(r).min(w - 1)];
                }
                *v = acc;
            }
        }
    });
    let mut out = vec![0.0f32; plane.len()];
    par_bands(&mut out, w, |row0, band| {
        for (j, row) in band.chunks_mut(w).enumerate() {
            let y = row0 + j;
            row.iter_mut().for_each(|v| *v = 0.0);
            for (i, k) in kern.iter().enumerate() {
                let yy = (y + i).saturating_sub(r).min(h - 1);
                let src = &tmp[yy * w..(yy + 1) * w];
                for (v, s) in row.iter_mut().zip(src) {
                    *v += k * s;
                }
            }
        }
    });
    out
}

/// Texture (fine detail) and Clarity (medium detail), both on brightness only, so colours are not shifted.
pub fn apply_clarity_texture(img: &RgbImage, clarity: f32, texture: f32, scale: f32) -> RgbImage {
    if (clarity.abs() < 1e-4 && texture.abs() < 1e-4) || img.width() == 0 || img.height() == 0 {
        return img.clone();
    }
    let (w, h) = (img.width() as usize, img.height() as usize);
    let src = img.as_raw();
    let n = w * h;
    let mut y = vec![0.0f32; n];
    par_bands(&mut y, w, |row0, band| {
        for (j, v) in band.iter_mut().enumerate() {
            *v = luma(&src[(row0 * w + j) * 3..]);
        }
    });
    // the wide blur behind Clarity is smooth, so it is worked out on blocks and scaled back up
    let f = grid(scale);
    let soft_c = (clarity.abs() >= 1e-4).then(|| {
        let (low, lw, lh) = box_down(&y, w, h, f);
        let blurred = blur_plane(&low, lw, lh, (14.0 * scale / f as f32).max(1.0));
        upsample(&blurred, lw, lh, f, w, h)
    });
    let soft_t = (texture.abs() >= 1e-4).then(|| {
        let sigma = (1.8 * scale).max(0.8);
        if sigma <= 2.5 {
            small_blur(&y, w, h, sigma)
        } else {
            blur_plane(&y, w, h, sigma)
        }
    });
    let (kc, kt) = (clarity / 100.0 * 0.8, texture / 100.0);
    let mut out = vec![0u8; src.len()];
    par_bands(&mut out, w * 3, |row0, band| {
        for (j, px) in band.chunks_mut(3).enumerate() {
            let idx = row0 * w + j;
            let yv = y[idx];
            // detail in the middle of the range is changed most; the very dark and very bright are left more alone
            let mid = 0.35 + 0.65 * 4.0 * yv * (1.0 - yv);
            let mut delta = 0.0f32;
            if let Some(s) = &soft_c {
                delta += (yv - s[idx]) * kc * mid;
            }
            if let Some(s) = &soft_t {
                let d = yv - s[idx];
                if kt >= 0.0 {
                    delta += d * kt * 1.1 * (0.4 + 0.6 * mid);
                } else {
                    // smoothing keeps strong edges: only small differences are taken out
                    let keep = 1.0 / (1.0 + (d.abs() / 0.04).powi(2));
                    delta += d * kt * keep;
                }
            }
            let i = idx * 3;
            for k in 0..3 {
                px[k] = ((src[i + k] as f32 / 255.0 + delta).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
        }
    });
    RgbImage::from_raw(w as u32, h as u32, out).expect("same size")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn std_dev(img: &RgbImage) -> f32 {
        let v: Vec<f32> = img.pixels().map(|p| luma(&p.0)).collect();
        let m = v.iter().sum::<f32>() / v.len() as f32;
        (v.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / v.len() as f32).sqrt()
    }
    fn mean(img: &RgbImage) -> f32 {
        img.pixels().map(|p| luma(&p.0)).sum::<f32>() / (img.width() * img.height()) as f32
    }
    /// a soft scene of blobs and a fine pattern, so there is detail at every size
    fn scene(w: u32, h: u32) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| {
            let (fx, fy) = (x as f32, y as f32);
            let blob = 0.5 + 0.28 * (fx / 31.0).sin() * (fy / 23.0).cos();
            let fine = 0.04 * ((fx * 1.3).sin() * (fy * 1.1).cos());
            let v = (blob + fine).clamp(0.0, 1.0);
            Rgb([((v * 0.95) * 255.0) as u8, (v * 255.0) as u8, ((v * 1.05).min(1.0) * 255.0) as u8])
        })
    }
    fn flat(v: u8) -> RgbImage {
        RgbImage::from_pixel(64, 48, Rgb([v, v, v]))
    }

    #[test]
    fn at_zero_nothing_changes_and_a_flat_picture_stays_flat() {
        let img = scene(96, 64);
        assert_eq!(apply_clarity_texture(&img, 0.0, 0.0, 1.0), img);
        assert_eq!(apply_dehaze(&img, 0.0, [0.8; 3], 1.0), img);
        assert!(!any(0.0, 0.0, 0.0) && any(0.0, 0.0, 5.0));
        for v in [0u8, 90, 255] {
            let f = flat(v);
            assert_eq!(apply_clarity_texture(&f, 100.0, 100.0, 1.0), f, "no detail to bring out in {v}");
            assert_eq!(apply_clarity_texture(&f, -100.0, -100.0, 1.0), f);
        }
    }

    #[test]
    fn texture_brings_out_fine_detail_when_positive_and_smooths_it_when_negative_but_keeps_a_strong_edge() {
        let img = scene(160, 96);
        let before = std_dev(&img);
        let up = std_dev(&apply_clarity_texture(&img, 0.0, 100.0, 1.0));
        let down = std_dev(&apply_clarity_texture(&img, 0.0, -100.0, 1.0));
        assert!(up > before * 1.02 && down < before, "{down} < {before} < {up}");
        // a hard edge with a little noise on each side: smoothing takes the noise out and keeps the edge
        let edge = RgbImage::from_fn(120, 40, |x, y| {
            let base = if x < 60 { 60.0 } else { 190.0 };
            let noise = if (x + y) % 2 == 0 { 4.0 } else { -4.0 };
            Rgb([(base + noise) as u8; 3])
        });
        let s = apply_clarity_texture(&edge, 0.0, -100.0, 1.0);
        let step = s.get_pixel(70, 20)[0] as i32 - s.get_pixel(50, 20)[0] as i32;
        assert!(step > 110, "the edge survives: {step}");
        let wiggle = (s.get_pixel(20, 20)[0] as i32 - s.get_pixel(21, 20)[0] as i32).abs();
        assert!(wiggle <= 3, "the noise beside it is smoothed: {wiggle}");
    }

    #[test]
    fn clarity_adds_midtone_punch_when_positive_and_softens_when_negative_and_spares_black_and_white() {
        let img = scene(200, 120);
        let before = std_dev(&img);
        let up = std_dev(&apply_clarity_texture(&img, 100.0, 0.0, 1.0));
        let down = std_dev(&apply_clarity_texture(&img, -100.0, 0.0, 1.0));
        assert!(up > before * 1.05 && down < before * 0.98, "{down} < {before} < {up}");
        // detail that sits in pure black or pure white barely moves
        let dark = RgbImage::from_fn(80, 80, |x, y| Rgb([if (x / 4 + y / 4) % 2 == 0 { 0 } else { 12 }; 3]));
        let moved = apply_clarity_texture(&dark, 100.0, 0.0, 1.0);
        let diff: i32 = dark.pixels().zip(moved.pixels()).map(|(a, b)| (a[0] as i32 - b[0] as i32).abs()).max().unwrap();
        assert!(diff <= 6, "{diff}");
        // never leaves the range
        for a in [-100.0, 100.0] {
            let o = apply_clarity_texture(&img, a, a, 1.0);
            assert_eq!(o.dimensions(), img.dimensions());
        }
    }

    #[test]
    fn dehaze_takes_a_veil_off_and_putting_haze_in_lifts_and_flattens() {
        let clear = scene(160, 100);
        // a hazy version of the same scene: each colour pulled toward a light grey-blue
        let air = [0.80f32, 0.83, 0.88];
        let t = 0.55;
        let hazy = RgbImage::from_fn(160, 100, |x, y| {
            let p = clear.get_pixel(x, y).0;
            Rgb([0, 1, 2].map(|k| ((p[k] as f32 / 255.0 * t + air[k] * (1.0 - t)) * 255.0) as u8))
        });
        let a = estimate_airlight(&hazy);
        assert!((a[2] - 0.88).abs() < 0.12 && a[2] >= a[0], "the haze colour is found: {a:?}");
        let cleared = apply_dehaze(&hazy, 100.0, a, 1.0);
        assert!(std_dev(&cleared) > std_dev(&hazy) * 1.25, "{} vs {}", std_dev(&cleared), std_dev(&hazy));
        assert!(mean(&cleared) < mean(&hazy), "the veil of light is taken off");
        // more is stronger
        assert!(std_dev(&apply_dehaze(&hazy, 40.0, a, 1.0)) < std_dev(&cleared));
        // negative: lighter and flatter
        let veiled = apply_dehaze(&clear, -100.0, a, 1.0);
        assert!(std_dev(&veiled) < std_dev(&clear) * 0.7 && mean(&veiled) > mean(&clear));
        // it never produces something outside the range or of another size
        assert_eq!(cleared.dimensions(), hazy.dimensions());
    }

    #[test]
    fn the_haze_colour_estimate_is_kept_in_a_sensible_range_and_survives_odd_pictures() {
        for v in [0u8, 128, 255] {
            let a = estimate_airlight(&flat(v));
            assert!(a.iter().all(|c| (0.55..=0.98).contains(c)), "{a:?}");
        }
        assert_eq!(estimate_airlight(&RgbImage::new(0, 0)), [0.85; 3]);
        assert_eq!(apply_dehaze(&RgbImage::new(0, 0), 50.0, [0.8; 3], 1.0).dimensions(), (0, 0));
        let tiny = RgbImage::from_pixel(1, 1, Rgb([10, 20, 30]));
        assert_eq!(apply_dehaze(&tiny, 100.0, [0.8; 3], 1.0).dimensions(), (1, 1));
        assert_eq!(apply_clarity_texture(&tiny, 100.0, 100.0, 1.0).dimensions(), (1, 1));
    }

    #[test]
    fn the_sizes_scale_with_the_picture_so_a_small_preview_looks_like_the_big_one() {
        // the same scene at half the size, with half the scale, changes by about the same amount
        let big = scene(320, 200);
        let small = image::imageops::resize(&big, 160, 100, image::imageops::FilterType::Triangle);
        let gain = |img: &RgbImage, scale: f32| std_dev(&apply_clarity_texture(img, 100.0, 0.0, scale)) / std_dev(img);
        let (g_big, g_small) = (gain(&big, 320.0 / 2048.0), gain(&small, 160.0 / 2048.0));
        assert!((g_big - g_small).abs() < 0.08, "{g_big} against {g_small}");
    }

    #[test]
    fn min_filter_finds_the_smallest_value_nearby() {
        let mut p = vec![1.0f32; 7 * 7];
        p[3 * 7 + 3] = 0.2;
        let m = min_filter(&p, 7, 7, 1);
        assert_eq!(m[3 * 7 + 3], 0.2);
        assert_eq!(m[2 * 7 + 2], 0.2, "a neighbour sees it");
        assert_eq!(m[0], 1.0, "a far corner does not");
        assert_eq!(min_filter(&p, 7, 7, 3)[0], 0.2, "a bigger window reaches it");
    }

    /// Not run by default: how long each takes on a picture the size of the live preview and of a full export.
    #[test]
    #[ignore]
    fn how_long_they_take() {
        let best = |f: &dyn Fn()| (0..5).map(|_| { let t = std::time::Instant::now(); f(); t.elapsed() }).min().unwrap();
        for (w, h) in [(800u32, 533u32), (1100, 733), (3000, 2000), (6000, 4000)] {
            let img = scene(w, h);
            let scale = w.max(h) as f32 / 2048.0;
            let a = estimate_airlight(&img);
            let ta = best(&|| { let _ = estimate_airlight(&img); });
            let td = best(&|| { let _ = apply_dehaze(&img, 60.0, a, scale); });
            let tc = best(&|| { let _ = apply_clarity_texture(&img, 50.0, 0.0, scale); });
            let tt = best(&|| { let _ = apply_clarity_texture(&img, 0.0, 50.0, scale); });
            println!("{w}x{h}: airlight {ta:?}, dehaze {td:?}, clarity {tc:?}, texture {tt:?}");
        }
    }

    #[test]
    fn the_small_blur_keeps_brightness_matches_the_general_blur_and_handles_tiny_pictures() {
        let (w, h) = (40usize, 30usize);
        let flat = vec![0.42f32; w * h];
        assert!(small_blur(&flat, w, h, 1.2).iter().all(|v| (v - 0.42).abs() < 1e-5), "a flat plane stays flat, edges included");
        let mut dot = vec![0.0f32; w * h];
        dot[15 * w + 20] = 1.0;
        let b = small_blur(&dot, w, h, 1.2);
        assert!((b.iter().sum::<f32>() - 1.0).abs() < 1e-4, "no light is lost or made");
        assert!(b[15 * w + 20] > b[15 * w + 22] && b[15 * w + 22] > 0.0, "it is a soft bump");
        let plane: Vec<f32> = (0..w * h).map(|i| (((i % w) as f32 / 5.0).sin() * ((i / w) as f32 / 4.0).cos() + 1.0) / 2.0).collect();
        let (a, g) = (small_blur(&plane, w, h, 1.5), blur_plane(&plane, w, h, 1.5));
        let worst = a.iter().zip(&g).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
        assert!(worst < 0.03, "close to the general blur: {worst}");
        assert!((small_blur(&[0.5], 1, 1, 1.0)[0] - 0.5).abs() < 1e-5);
        assert_eq!(small_blur(&[0.2, 0.8], 2, 1, 1.0).len(), 2);
    }
}
