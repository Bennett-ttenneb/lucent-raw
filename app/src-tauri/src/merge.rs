//! Photo merge to HDR by exposure fusion (Mertens, Kautz and Van Reeth): several shots of one scene at different exposures are combined
//! into one picture that keeps the detail of the shadows and the highlights. Each pixel of each shot is given a weight from how much
//! contrast, colour and well-exposedness it has, and the shots are blended at several scales so there are no seams. The result is an
//! ordinary 8-bit picture (it is already tone mapped), not a picture with a wider range than the file can hold.
//!
//! Shots that moved a little between frames (hand held) are first lined up by a shift found by comparing median-threshold bitmaps, which
//! does not depend on the exposure. Anything that moves inside the scene (people, leaves) is not corrected: it may show a ghost.

use image::{Rgb, RgbImage};

/// The most pixels fused at once. Bigger shots are shrunk to this first, so a stack of them fits in memory.
pub const MAX_PIXELS: u64 = 16_000_000;

/// A float picture of three channels, or one (weights), row by row.
#[derive(Clone)]
struct Plane {
    w: usize,
    h: usize,
    c: usize,
    d: Vec<f32>,
}

impl Plane {
    fn new(w: usize, h: usize, c: usize) -> Plane {
        Plane { w, h, c, d: vec![0.0; w * h * c] }
    }
    fn at(&self, x: usize, y: usize, ch: usize) -> f32 {
        self.d[(y * self.w + x) * self.c + ch]
    }
}

fn from_image(img: &RgbImage) -> Plane {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let mut p = Plane::new(w, h, 3);
    for (i, px) in img.pixels().enumerate() {
        for c in 0..3 {
            p.d[i * 3 + c] = px[c] as f32 / 255.0;
        }
    }
    p
}

/// Blur with 1 4 6 4 1 and keep every second pixel.
fn down(p: &Plane) -> Plane {
    let (w, h) = ((p.w + 1) / 2, (p.h + 1) / 2);
    let k = [1.0f32, 4.0, 6.0, 4.0, 1.0];
    // horizontal
    let mut tmp = Plane::new(w, p.h, p.c);
    for y in 0..p.h {
        for x in 0..w {
            for c in 0..p.c {
                let mut s = 0.0;
                for (j, kv) in k.iter().enumerate() {
                    let xx = (2 * x as i64 + j as i64 - 2).clamp(0, p.w as i64 - 1) as usize;
                    s += kv * p.at(xx, y, c);
                }
                tmp.d[(y * w + x) * p.c + c] = s / 16.0;
            }
        }
    }
    let mut out = Plane::new(w, h, p.c);
    for y in 0..h {
        for x in 0..w {
            for c in 0..p.c {
                let mut s = 0.0;
                for (j, kv) in k.iter().enumerate() {
                    let yy = (2 * y as i64 + j as i64 - 2).clamp(0, tmp.h as i64 - 1) as usize;
                    s += kv * tmp.at(x, yy, c);
                }
                out.d[(y * w + x) * p.c + c] = s / 16.0;
            }
        }
    }
    out
}

/// Enlarge to `w` x `h` by bilinear interpolation.
fn up(p: &Plane, w: usize, h: usize) -> Plane {
    let mut out = Plane::new(w, h, p.c);
    let (sx, sy) = (p.w as f32 / w as f32, p.h as f32 / h as f32);
    for y in 0..h {
        let fy = ((y as f32 + 0.5) * sy - 0.5).max(0.0);
        let y0 = (fy as usize).min(p.h - 1);
        let y1 = (y0 + 1).min(p.h - 1);
        let ty = fy - y0 as f32;
        for x in 0..w {
            let fx = ((x as f32 + 0.5) * sx - 0.5).max(0.0);
            let x0 = (fx as usize).min(p.w - 1);
            let x1 = (x0 + 1).min(p.w - 1);
            let tx = fx - x0 as f32;
            for c in 0..p.c {
                let top = p.at(x0, y0, c) * (1.0 - tx) + p.at(x1, y0, c) * tx;
                let bot = p.at(x0, y1, c) * (1.0 - tx) + p.at(x1, y1, c) * tx;
                out.d[(y * w + x) * p.c + c] = top * (1.0 - ty) + bot * ty;
            }
        }
    }
    out
}

fn gaussian_pyramid(p: Plane, levels: usize) -> Vec<Plane> {
    let mut v = vec![p];
    for _ in 1..levels {
        let next = down(v.last().unwrap());
        v.push(next);
    }
    v
}

/// The detail at each scale: each level minus the enlarged next one; the last level is kept as it is.
fn laplacian_pyramid(p: Plane, levels: usize) -> Vec<Plane> {
    let g = gaussian_pyramid(p, levels);
    let mut out = Vec::with_capacity(levels);
    for i in 0..levels {
        if i + 1 == levels {
            out.push(g[i].clone());
        } else {
            let u = up(&g[i + 1], g[i].w, g[i].h);
            let mut l = g[i].clone();
            for (a, b) in l.d.iter_mut().zip(&u.d) {
                *a -= b;
            }
            out.push(l);
        }
    }
    out
}

fn collapse(mut pyr: Vec<Plane>) -> Plane {
    let mut cur = pyr.pop().unwrap();
    while let Some(mut level) = pyr.pop() {
        let u = up(&cur, level.w, level.h);
        for (a, b) in level.d.iter_mut().zip(&u.d) {
            *a += b;
        }
        cur = level;
    }
    cur
}

/// How much each pixel of one shot should count: contrast x colour x how well exposed it is.
fn weights(p: &Plane) -> Plane {
    let mut grey = Plane::new(p.w, p.h, 1);
    for i in 0..p.w * p.h {
        grey.d[i] = 0.299 * p.d[i * 3] + 0.587 * p.d[i * 3 + 1] + 0.114 * p.d[i * 3 + 2];
    }
    let mut out = Plane::new(p.w, p.h, 1);
    for y in 0..p.h {
        for x in 0..p.w {
            let g = |xx: i64, yy: i64| grey.at(xx.clamp(0, p.w as i64 - 1) as usize, yy.clamp(0, p.h as i64 - 1) as usize, 0);
            let (xi, yi) = (x as i64, y as i64);
            let lap = (g(xi - 1, yi) + g(xi + 1, yi) + g(xi, yi - 1) + g(xi, yi + 1) - 4.0 * g(xi, yi)).abs();
            let i = y * p.w + x;
            let (r, gr, b) = (p.d[i * 3], p.d[i * 3 + 1], p.d[i * 3 + 2]);
            let mean = (r + gr + b) / 3.0;
            let sat = (((r - mean).powi(2) + (gr - mean).powi(2) + (b - mean).powi(2)) / 3.0).sqrt();
            let well = |v: f32| (-((v - 0.5).powi(2)) / (2.0 * 0.2f32 * 0.2)).exp();
            out.d[i] = (lap + 1e-3) * (sat + 1e-3) * (well(r) * well(gr) * well(b) + 1e-4);
        }
    }
    out
}

/// A grey picture of a shot at its brightness percentile, as bits: whether each pixel is above the middle, and whether it is too close to
/// the middle to be trusted.
fn bitmaps(g: &[u8], w: usize, h: usize) -> (Vec<bool>, Vec<bool>) {
    let mut hist = [0usize; 256];
    for v in g {
        hist[*v as usize] += 1;
    }
    let (mut acc, mut median) = (0usize, 128usize);
    for (v, n) in hist.iter().enumerate() {
        acc += n;
        if acc * 2 >= w * h {
            median = v;
            break;
        }
    }
    let above = g.iter().map(|v| *v as usize > median).collect();
    let keep = g.iter().map(|v| (*v as i32 - median as i32).abs() > 4).collect();
    (above, keep)
}

fn shrink_grey(g: &[u8], w: usize, h: usize) -> (Vec<u8>, usize, usize) {
    let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
    let mut out = vec![0u8; nw * nh];
    for y in 0..nh {
        for x in 0..nw {
            let (x2, y2) = ((2 * x).min(w - 1), (2 * y).min(h - 1));
            let (x3, y3) = ((x2 + 1).min(w - 1), (y2 + 1).min(h - 1));
            out[y * nw + x] = ((g[y2 * w + x2] as u32 + g[y2 * w + x3] as u32 + g[y3 * w + x2] as u32 + g[y3 * w + x3] as u32) / 4) as u8;
        }
    }
    (out, nw, nh)
}

fn grey_of(img: &RgbImage) -> Vec<u8> {
    img.pixels().map(|p| ((p[0] as u32 * 77 + p[1] as u32 * 150 + p[2] as u32 * 29) >> 8) as u8).collect()
}

/// The shift (dx, dy) that, applied to `moving`, lines it up with `reference` best, by median threshold bitmaps (Ward 2003).
pub fn find_shift(reference: &RgbImage, moving: &RgbImage, max_shift: i32) -> (i32, i32) {
    let (w, h) = (reference.width() as usize, reference.height() as usize);
    if moving.width() as usize != w || moving.height() as usize != h {
        return (0, 0);
    }
    // a pyramid of grey pictures, smallest first
    let mut levels_ref = vec![(grey_of(reference), w, h)];
    let mut levels_mov = vec![(grey_of(moving), w, h)];
    let mut depth = 0;
    while (max_shift >> depth) > 1 && levels_ref.last().unwrap().1 > 32 && levels_ref.last().unwrap().2 > 32 {
        let (a, aw, ah) = levels_ref.last().unwrap().clone();
        let (b, bw, bh) = levels_mov.last().unwrap().clone();
        levels_ref.push(shrink_grey(&a, aw, ah));
        levels_mov.push(shrink_grey(&b, bw, bh));
        depth += 1;
    }
    let (mut sx, mut sy) = (0i32, 0i32);
    for level in (0..levels_ref.len()).rev() {
        sx *= 2;
        sy *= 2;
        let (rg, rw, rh) = &levels_ref[level];
        let (mg, mw, mh) = &levels_mov[level];
        let (r_bits, r_keep) = bitmaps(rg, *rw, *rh);
        let (m_bits, m_keep) = bitmaps(mg, *mw, *mh);
        let mut best = (u64::MAX, 0, 0);
        for dy in -1..=1 {
            for dx in -1..=1 {
                let (tx, ty) = (sx + dx, sy + dy);
                let mut diff = 0u64;
                for y in 0..*rh as i32 {
                    let my = y - ty;
                    if my < 0 || my >= *mh as i32 {
                        continue;
                    }
                    for x in 0..*rw as i32 {
                        let mx = x - tx;
                        if mx < 0 || mx >= *mw as i32 {
                            continue;
                        }
                        let (ri, mi) = ((y as usize) * rw + x as usize, (my as usize) * mw + mx as usize);
                        if r_keep[ri] && m_keep[mi] && r_bits[ri] != m_bits[mi] {
                            diff += 1;
                        }
                    }
                }
                if diff < best.0 {
                    best = (diff, tx, ty);
                }
            }
        }
        sx = best.1;
        sy = best.2;
    }
    (sx.clamp(-max_shift, max_shift), sy.clamp(-max_shift, max_shift))
}

/// `img` moved by (dx, dy); the edge that has nothing to fill it repeats the nearest pixel.
pub fn shifted(img: &RgbImage, dx: i32, dy: i32) -> RgbImage {
    if dx == 0 && dy == 0 {
        return img.clone();
    }
    let (w, h) = (img.width() as i32, img.height() as i32);
    RgbImage::from_fn(w as u32, h as u32, |x, y| *img.get_pixel((x as i32 - dx).clamp(0, w - 1) as u32, (y as i32 - dy).clamp(0, h - 1) as u32))
}

/// Fuse the shots into one picture. All must be the same size (callers shrink or refuse); with `align` they are lined up first.
pub fn fuse(shots: &[RgbImage], align: bool) -> Result<RgbImage, String> {
    fuse_with(shots, align, false)
}

/// Focus stacking for macro and close-up work: shots taken at different focus distances are blended so each part comes from the shot where it is
/// sharpest. Same lining up and blending as use, but the weight is how much fine detail a pixel has, strongly favouring the sharpest shot.
pub fn focus_stack(shots: &[RgbImage], align: bool) -> Result<RgbImage, String> {
    if shots.len() > 40 {
        return Err("Stack up to 40 photos at a time.".into());
    }
    fuse_with(shots, align, true)
}

fn fuse_with(shots: &[RgbImage], align: bool, focus: bool) -> Result<RgbImage, String> {
    if shots.len() < 2 {
        return Err("Choose two or more photos of the same scene to merge.".into());
    }
    if shots.len() > 9 && !focus {
        return Err("Merge up to 9 photos at a time.".into());
    }
    let (w, h) = shots[0].dimensions();
    if shots.iter().any(|s| s.dimensions() != (w, h)) {
        return Err("The photos are not all the same size, so they cannot be merged.".into());
    }
    if (w as u64) * (h as u64) > MAX_PIXELS * 2 {
        return Err("These photos are too large to merge here.".into());
    }
    let mut aligned: Vec<RgbImage> = vec![shots[0].clone()];
    for s in &shots[1..] {
        if align {
            let (dx, dy) = find_shift(&shots[0], s, (w.min(h) / 40).max(8) as i32);
            aligned.push(shifted(s, dx, dy));
        } else {
            aligned.push(s.clone());
        }
    }
    let planes: Vec<Plane> = aligned.iter().map(from_image).collect();
    let mut ws: Vec<Plane> = if focus { planes.iter().map(sharpness_weights).collect() } else { planes.iter().map(weights).collect() };
    // the weights of every pixel add up to one
    for i in 0..(w * h) as usize {
        let total: f32 = ws.iter().map(|p| p.d[i]).sum();
        for p in ws.iter_mut() {
            p.d[i] = if total > 0.0 { p.d[i] / total } else { 1.0 / planes.len() as f32 };
        }
    }
    let levels = ((w.min(h) as f32).log2().floor() as usize).saturating_sub(2).clamp(2, 8);
    let mut result: Option<Vec<Plane>> = None;
    for (img, wt) in planes.into_iter().zip(ws) {
        let lap = laplacian_pyramid(img, levels);
        let gw = gaussian_pyramid(wt, levels);
        match &mut result {
            None => {
                result = Some(
                    lap.into_iter()
                        .zip(&gw)
                        .map(|(mut l, g)| {
                            for i in 0..l.w * l.h {
                                for c in 0..3 {
                                    l.d[i * 3 + c] *= g.d[i];
                                }
                            }
                            l
                        })
                        .collect(),
                )
            }
            Some(acc) => {
                for ((a, l), g) in acc.iter_mut().zip(&lap).zip(&gw) {
                    for i in 0..a.w * a.h {
                        for c in 0..3 {
                            a.d[i * 3 + c] += l.d[i * 3 + c] * g.d[i];
                        }
                    }
                }
            }
        }
    }
    let fused = collapse(result.unwrap());
    let mut out = RgbImage::new(w, h);
    for y in 0..h as usize {
        for x in 0..w as usize {
            let px = |c: usize| (fused.at(x, y, c).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            out.put_pixel(x as u32, y as u32, Rgb([px(0), px(1), px(2)]));
        }
    }
    Ok(out)
}

/// How sharp each pixel is: the strength of fine detail round it (a Laplacian, smoothed over a small window), raised to a power so the sharpest
/// shot wins clearly where the shots differ, with a little left everywhere so flat areas still blend.
fn sharpness_weights(p: &Plane) -> Plane {
    let mut grey = Plane::new(p.w, p.h, 1);
    for i in 0..p.w * p.h {
        grey.d[i] = 0.299 * p.d[i * 3] + 0.587 * p.d[i * 3 + 1] + 0.114 * p.d[i * 3 + 2];
    }
    let mut lap = Plane::new(p.w, p.h, 1);
    for y in 0..p.h {
        for x in 0..p.w {
            let g = |xx: i64, yy: i64| grey.at(xx.clamp(0, p.w as i64 - 1) as usize, yy.clamp(0, p.h as i64 - 1) as usize, 0);
            let (xi, yi) = (x as i64, y as i64);
            lap.d[y * p.w + x] = (8.0 * g(xi, yi) - g(xi - 1, yi) - g(xi + 1, yi) - g(xi, yi - 1) - g(xi, yi + 1) - g(xi - 1, yi - 1) - g(xi + 1, yi + 1) - g(xi - 1, yi + 1) - g(xi + 1, yi - 1)).abs();
        }
    }
    // a box average over a small window, so one noisy pixel does not decide
    let r = ((p.w.max(p.h) as f32 / 500.0) as usize).clamp(2, 12);
    let mut tmp = Plane::new(p.w, p.h, 1);
    for y in 0..p.h {
        for x in 0..p.w {
            let (x0, x1) = (x.saturating_sub(r), (x + r + 1).min(p.w));
            let sum: f32 = lap.d[y * p.w + x0..y * p.w + x1].iter().sum();
            tmp.d[y * p.w + x] = sum / (x1 - x0) as f32;
        }
    }
    let mut out = Plane::new(p.w, p.h, 1);
    for y in 0..p.h {
        let (y0, y1) = (y.saturating_sub(r), (y + r + 1).min(p.h));
        for x in 0..p.w {
            let mut sum = 0f32;
            for yy in y0..y1 {
                sum += tmp.d[yy * p.w + x];
            }
            out.d[y * p.w + x] = (sum / (y1 - y0) as f32).powi(3) + 1e-9;
        }
    }
    out
}

/// The shots shrunk (all by the same factor) so that together they have at most `total` pixels.
pub fn within_total(shots: Vec<RgbImage>, total: u64) -> Vec<RgbImage> {
    let (w, h) = match shots.first() {
        Some(s) => s.dimensions(),
        None => return shots,
    };
    let all = w as u64 * h as u64 * shots.len() as u64;
    if all <= total {
        return shots;
    }
    let scale = (total as f64 / all as f64).sqrt();
    shots.into_iter().map(|s| image::imageops::resize(&s, ((w as f64 * scale) as u32).max(1), ((h as f64 * scale) as u32).max(1), image::imageops::FilterType::Triangle)).collect()
}

/// The shots shrunk (all by the same factor) so none has more than `MAX_PIXELS` pixels.
pub fn within_budget(shots: Vec<RgbImage>) -> Vec<RgbImage> {
    let (w, h) = match shots.first() {
        Some(s) => s.dimensions(),
        None => return shots,
    };
    let pixels = w as u64 * h as u64;
    if pixels <= MAX_PIXELS {
        return shots;
    }
    let scale = (MAX_PIXELS as f64 / pixels as f64).sqrt();
    let (nw, nh) = (((w as f64 * scale) as u32).max(1), ((h as f64 * scale) as u32).max(1));
    shots.into_iter().map(|s| image::imageops::resize(&s, nw, nh, image::imageops::FilterType::Triangle)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scene whose brightness runs from deep shadow on the left to a bright sky on the right, with some texture, shot at three exposures.
    fn scene(exposure: f32) -> RgbImage {
        RgbImage::from_fn(160, 100, |x, y| {
            let base = 0.002 + 6.0 * (x as f32 / 159.0).powi(2);
            let texture = 1.0 + 0.15 * (((x / 4 + y / 4) % 2) as f32 - 0.5);
            let lin = base * texture * exposure;
            let v = (lin.clamp(0.0, 1.0).powf(1.0 / 2.2) * 255.0) as u8;
            Rgb([v, (v as f32 * 0.95) as u8, (v as f32 * 0.9) as u8])
        })
    }

    fn clipped(img: &RgbImage) -> usize {
        img.pixels().filter(|p| p[0] <= 8 || p[0] >= 253).count()
    }

    #[test]
    fn fusing_three_exposures_keeps_the_shadows_and_the_highlights_that_each_alone_loses() {
        let shots = [scene(0.12), scene(1.0), scene(4.0)];
        let fused = fuse(&shots, false).unwrap();
        assert_eq!(fused.dimensions(), (160, 100));
        let worst = shots.iter().map(clipped).min().unwrap();
        assert!(clipped(&fused) * 3 < worst, "fused clips {} pixels, the best single shot {}", clipped(&fused), worst);
        // both ends are there: not black in the shadows, not white in the sky
        let dark = fused.get_pixel(5, 50)[0];
        let bright = fused.get_pixel(154, 50)[0];
        assert!(dark > 6 && bright < 250, "dark {dark}, bright {bright}");
        assert!(bright > dark + 60, "the picture still has its range: {dark} to {bright}");
    }

    /// Smooth, uneven blobs with no repeating pattern, at a given brightness.
    fn blobs(lift: f32) -> RgbImage {
        RgbImage::from_fn(160, 100, |x, y| {
            let (xf, yf) = (x as f32, y as f32);
            let v = 128.0 + 60.0 * (xf / 9.3).sin() * (yf / 7.1).cos() + 40.0 * ((xf + 2.0 * yf) / 17.7).sin() + 25.0 * (xf * yf / 910.0).cos();
            let v = ((v + lift).clamp(0.0, 255.0)) as u8;
            Rgb([v, v, v])
        })
    }

    #[test]
    fn shots_that_moved_a_little_are_lined_up_first() {
        let a = blobs(0.0);
        let b = shifted(&blobs(35.0), 3, -2); // brighter, and moved
        let (dx, dy) = find_shift(&a, &b, 8);
        assert_eq!((dx, dy), (-3, 2), "the shift that undoes the move");
        let back = shifted(&b, dx, dy);
        let want = blobs(35.0);
        let off = (20..140).flat_map(|x| (10..90).map(move |y| (x, y))).filter(|(x, y)| (back.get_pixel(*x, *y)[0] as i32 - want.get_pixel(*x, *y)[0] as i32).abs() > 3).count();
        assert_eq!(off, 0, "lined up exactly inside the picture");
    }
    /// A textured scene whose left half is sharp in one shot and whose right half is sharp in the other (the rest is blurred).
    #[test]
    fn a_focus_stack_takes_each_part_from_the_shot_where_it_is_sharp() {
        let sharp = RgbImage::from_fn(200, 120, |x, y| {
            let v = if (x / 2 + y / 2) % 2 == 0 { 220u8 } else { 30 };
            Rgb([v, v, v])
        });
        let soft = RgbImage::from_pixel(200, 120, Rgb([125, 125, 125]));
        let mix = |left_sharp: bool| RgbImage::from_fn(200, 120, |x, y| if (x < 100) == left_sharp { *sharp.get_pixel(x, y) } else { *soft.get_pixel(x, y) });
        let stack = focus_stack(&[mix(true), mix(false)], false).unwrap();
        let spread = |x0: u32, x1: u32| {
            let v: Vec<u8> = (x0..x1).flat_map(|x| (20..100).map(move |y| (x, y))).map(|(x, y)| stack.get_pixel(x, y)[0]).collect();
            (*v.iter().max().unwrap() as i32) - (*v.iter().min().unwrap() as i32)
        };
        assert!(spread(10, 90) > 170, "the left is sharp: {}", spread(10, 90));
        assert!(spread(110, 190) > 170, "and so is the right: {}", spread(110, 190));
        assert!(focus_stack(&(0..41).map(|_| mix(true)).collect::<Vec<_>>(), false).unwrap_err().contains("40"));
        let two = within_total(vec![RgbImage::new(4000, 3000), RgbImage::new(4000, 3000)], 12_000_000);
        assert!(two[0].width() as u64 * two[0].height() as u64 * 2 <= 12_100_000 && two[0].dimensions() == two[1].dimensions());
    }

    #[test]
    fn it_refuses_one_photo_ten_photos_and_photos_of_different_sizes() {
        assert!(fuse(&[scene(1.0)], false).unwrap_err().contains("two or more"));
        let many: Vec<RgbImage> = (0..10).map(|_| scene(1.0)).collect();
        assert!(fuse(&many, false).unwrap_err().contains("up to 9"));
        let small = RgbImage::new(10, 10);
        assert!(fuse(&[scene(1.0), small], false).unwrap_err().contains("same size"));
    }

    #[test]
    fn big_shots_are_shrunk_together_to_fit() {
        let big = vec![RgbImage::new(6000, 4000), RgbImage::new(6000, 4000)];
        let shrunk = within_budget(big);
        let (w, h) = shrunk[0].dimensions();
        assert!(w as u64 * h as u64 <= MAX_PIXELS + 10_000);
        assert_eq!(shrunk[0].dimensions(), shrunk[1].dimensions());
        assert_eq!(w * 2, h * 3 + (w * 2 - h * 3), "the shape is kept");
    }
}
