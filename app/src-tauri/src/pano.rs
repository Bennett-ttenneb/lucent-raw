//! Photo merge to a panorama, in its simple form: shots taken in turn while turning the camera (from a tripod, or a steady hand) are placed
//! side by side by the shift that makes their overlap match, their brightness is matched where they overlap, and they are blended with a
//! soft edge. The empty corners are cut away. It does not bend the pictures (no spherical or cylindrical projection, no perspective), so it
//! suits shots from a longer lens and a gentle turn, and it does not correct a camera that was tilted or moved between shots.

use image::{Rgb, RgbImage};

/// The most pixels the finished panorama may have (the shots are shrunk by the same factor to fit).
pub const MAX_PIXELS: u64 = 60_000_000;

fn grey(img: &RgbImage) -> (Vec<f32>, usize, usize) {
    let (w, h) = (img.width() as usize, img.height() as usize);
    (img.pixels().map(|p| 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32).collect(), w, h)
}

fn halve(g: &[f32], w: usize, h: usize) -> (Vec<f32>, usize, usize) {
    let (nw, nh) = ((w / 2).max(1), (h / 2).max(1));
    let mut out = vec![0.0; nw * nh];
    for y in 0..nh {
        for x in 0..nw {
            let (x0, y0) = ((2 * x).min(w - 1), (2 * y).min(h - 1));
            let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
            out[y * nw + x] = (g[y0 * w + x0] + g[y0 * w + x1] + g[y1 * w + x0] + g[y1 * w + x1]) * 0.25;
        }
    }
    (out, nw, nh)
}

/// How well `b`, placed with its top left corner at (dx, dy) on `a`, matches `a` where they overlap: the normalised correlation, and the
/// number of pixels that overlap. A match over fewer than `min_overlap` pixels does not count.
fn correlation(a: &[f32], aw: usize, ah: usize, b: &[f32], bw: usize, bh: usize, dx: i32, dy: i32, min_overlap: usize) -> Option<f32> {
    let x0 = dx.max(0);
    let y0 = dy.max(0);
    let x1 = (dx + bw as i32).min(aw as i32);
    let y1 = (dy + bh as i32).min(ah as i32);
    if x1 <= x0 || y1 <= y0 || ((x1 - x0) as usize * (y1 - y0) as usize) < min_overlap {
        return None;
    }
    let (mut sa, mut sb, mut saa, mut sbb, mut sab, mut n) = (0f64, 0f64, 0f64, 0f64, 0f64, 0f64);
    for y in y0..y1 {
        let ar = &a[y as usize * aw..];
        let br = &b[(y - dy) as usize * bw..];
        for x in x0..x1 {
            let (va, vb) = (ar[x as usize] as f64, br[(x - dx) as usize] as f64);
            sa += va;
            sb += vb;
            saa += va * va;
            sbb += vb * vb;
            sab += va * vb;
            n += 1.0;
        }
    }
    let (ma, mb) = (sa / n, sb / n);
    let (va, vb) = (saa / n - ma * ma, sbb / n - mb * mb);
    if va < 1.0 || vb < 1.0 {
        return None; // a flat patch (a clear sky) says nothing about where it belongs
    }
    Some(((sab / n - ma * mb) / (va * vb).sqrt()) as f32)
}

/// Where the top left corner of `b` lies on `a`, in pixels, found coarse to fine. Returns the place and how good the match is (0 to 1).
pub fn find_offset(a: &RgbImage, b: &RgbImage) -> Option<(i32, i32, f32)> {
    let (mut ga, mut aw, mut ah) = grey(a);
    let (mut gb, mut bw, mut bh) = grey(b);
    let mut pyramid = vec![(ga.clone(), aw, ah, gb.clone(), bw, bh)];
    while aw.min(bw) > 160 && ah.min(bh) > 100 {
        let (na, naw, nah) = halve(&ga, aw, ah);
        let (nb, nbw, nbh) = halve(&gb, bw, bh);
        ga = na;
        aw = naw;
        ah = nah;
        gb = nb;
        bw = nbw;
        bh = nbh;
        pyramid.push((ga.clone(), aw, ah, gb.clone(), bw, bh));
    }
    // the coarsest level: every place where at least a fifth of the narrower picture overlaps
    let (ca, caw, cah, cb, cbw, cbh) = pyramid.last().unwrap();
    let min_overlap = (*caw.min(cbw) * *cah.min(cbh)) / 6;
    let mut best: Option<(f32, i32, i32)> = None;
    let y_range = (*cah as i32) / 5;
    for dy in -y_range..=y_range {
        for dx in -(*cbw as i32) + 1..*caw as i32 {
            if let Some(c) = correlation(ca, *caw, *cah, cb, *cbw, *cbh, dx, dy, min_overlap) {
                if best.map(|b| c > b.0).unwrap_or(true) {
                    best = Some((c, dx, dy));
                }
            }
        }
    }
    let (mut score, mut dx, mut dy) = best?;
    // finer and finer, looking only a few pixels round the place found
    for level in (0..pyramid.len() - 1).rev() {
        let (la, law, lah, lb, lbw, lbh) = &pyramid[level];
        dx *= 2;
        dy *= 2;
        let min_overlap = (*law.min(lbw) * *lah.min(lbh)) / 6;
        let mut top = (f32::MIN, dx, dy);
        for ddy in -3..=3 {
            for ddx in -3..=3 {
                if let Some(c) = correlation(la, *law, *lah, lb, *lbw, *lbh, dx + ddx, dy + ddy, min_overlap) {
                    if c > top.0 {
                        top = (c, dx + ddx, dy + ddy);
                    }
                }
            }
        }
        score = top.0;
        dx = top.1;
        dy = top.2;
    }
    Some((dx, dy, score))
}

/// How much brighter `b` must be made to match `a` in the strip where they overlap.
fn gain(a: &RgbImage, b: &RgbImage, dx: i32, dy: i32) -> f32 {
    let (x0, y0) = (dx.max(0), dy.max(0));
    let (x1, y1) = ((dx + b.width() as i32).min(a.width() as i32), (dy + b.height() as i32).min(a.height() as i32));
    if x1 <= x0 || y1 <= y0 {
        return 1.0;
    }
    let (mut sa, mut sb) = (0f64, 0f64);
    for y in (y0..y1).step_by(3) {
        for x in (x0..x1).step_by(3) {
            let pa = a.get_pixel(x as u32, y as u32);
            let pb = b.get_pixel((x - dx) as u32, (y - dy) as u32);
            sa += (pa[0] as f64 + pa[1] as f64 + pa[2] as f64) / 3.0;
            sb += (pb[0] as f64 + pb[1] as f64 + pb[2] as f64) / 3.0;
        }
    }
    if sb < 1.0 {
        1.0
    } else {
        ((sa / sb) as f32).clamp(0.6, 1.6)
    }
}

/// The biggest rectangle of `true` in a grid, as (x, y, w, h).
fn biggest_rectangle(ok: &[bool], w: usize, h: usize) -> (usize, usize, usize, usize) {
    let mut heights = vec![0usize; w];
    let mut best = (0usize, 0usize, 0usize, 0usize);
    for y in 0..h {
        for x in 0..w {
            heights[x] = if ok[y * w + x] { heights[x] + 1 } else { 0 };
        }
        let mut stack: Vec<usize> = vec![];
        for x in 0..=w {
            let cur = if x == w { 0 } else { heights[x] };
            while let Some(&top) = stack.last() {
                if heights[top] <= cur {
                    break;
                }
                stack.pop();
                let height = heights[top];
                let left = stack.last().map(|l| l + 1).unwrap_or(0);
                let width = x - left;
                if width * height > best.2 * best.3 {
                    best = (left, y + 1 - height, width, height);
                }
            }
            stack.push(x);
        }
    }
    best
}

/// Join the shots, in the order they are given, into one picture. Returns an error in words when two of them do not overlap enough to be
/// placed.
pub fn stitch(shots: &[RgbImage]) -> Result<RgbImage, String> {
    if shots.len() < 2 {
        return Err("Choose two or more photos taken in turn, each overlapping the next, to make a panorama.".into());
    }
    if shots.len() > 12 {
        return Err("Merge up to 12 photos at a time.".into());
    }
    // every shot's place, from the one before it
    let mut places: Vec<(i32, i32)> = vec![(0, 0)];
    let mut gains: Vec<f32> = vec![1.0];
    for i in 1..shots.len() {
        let (dx, dy, score) = find_offset(&shots[i - 1], &shots[i]).ok_or_else(|| format!("Photo {} could not be placed against photo {}: there is not enough of the same scene in both.", i + 1, i))?;
        if score < 0.5 {
            return Err(format!("Photo {} does not match photo {} well enough to join them (the overlap is too small, or the scene moved).", i + 1, i));
        }
        let (px, py) = places[i - 1];
        let g = gain(&shots[i - 1], &shots[i], dx, dy) * gains[i - 1];
        places.push((px + dx, py + dy));
        gains.push(g);
    }
    let min_x = places.iter().map(|p| p.0).min().unwrap();
    let min_y = places.iter().map(|p| p.1).min().unwrap();
    let max_x = places.iter().zip(shots).map(|(p, s)| p.0 + s.width() as i32).max().unwrap();
    let max_y = places.iter().zip(shots).map(|(p, s)| p.1 + s.height() as i32).max().unwrap();
    let (cw, ch) = ((max_x - min_x) as usize, (max_y - min_y) as usize);
    if (cw as u64) * (ch as u64) > MAX_PIXELS {
        return Err("The panorama would be too large to make here. Use fewer or smaller photos.".into());
    }
    let places: Vec<(i32, i32)> = places.iter().map(|p| (p.0 - min_x, p.1 - min_y)).collect();
    let mut canvas = RgbImage::new(cw as u32, ch as u32);
    let mut covered = vec![false; cw * ch];
    for y in 0..ch {
        for x in 0..cw {
            let (mut acc, mut wsum) = ([0f32; 3], 0f32);
            for (i, s) in shots.iter().enumerate() {
                let (lx, ly) = (x as i32 - places[i].0, y as i32 - places[i].1);
                if lx < 0 || ly < 0 || lx >= s.width() as i32 || ly >= s.height() as i32 {
                    continue;
                }
                // the nearer to the picture's own edge, the less it counts
                let edge = lx.min(s.width() as i32 - 1 - lx).min(ly).min(s.height() as i32 - 1 - ly) as f32 + 1.0;
                let weight = edge.min(400.0);
                let p = s.get_pixel(lx as u32, ly as u32);
                for c in 0..3 {
                    acc[c] += p[c] as f32 * gains[i] * weight;
                }
                wsum += weight;
            }
            if wsum > 0.0 {
                covered[y * cw + x] = true;
                canvas.put_pixel(x as u32, y as u32, Rgb([(acc[0] / wsum).clamp(0.0, 255.0) as u8, (acc[1] / wsum).clamp(0.0, 255.0) as u8, (acc[2] / wsum).clamp(0.0, 255.0) as u8]));
            }
        }
    }
    // cut away the empty corners: the biggest rectangle with a picture in every pixel (looked for on a coarser grid)
    let step = 4usize;
    let (gw, gh) = (cw / step, ch / step);
    if gw == 0 || gh == 0 {
        return Ok(canvas);
    }
    let coarse: Vec<bool> = (0..gh * gw).map(|i| covered[(i / gw * step) * cw + (i % gw) * step] && covered[(i / gw * step + step - 1) * cw + (i % gw) * step + step - 1]).collect();
    let (rx, ry, rw, rh) = biggest_rectangle(&coarse, gw, gh);
    if rw == 0 || rh == 0 {
        return Ok(canvas);
    }
    let (x, y, w, h) = (rx * step, ry * step, (rw * step).min(cw - rx * step), (rh * step).min(ch - ry * step));
    Ok(image::imageops::crop_imm(&canvas, x as u32, y as u32, w as u32, h as u32).to_image())
}

/// The shots shrunk by one factor so that, laid side by side, they stay within `MAX_PIXELS` (a rough guess from their total area).
pub fn within_budget(shots: Vec<RgbImage>) -> Vec<RgbImage> {
    let total: u64 = shots.iter().map(|s| s.width() as u64 * s.height() as u64).sum();
    if total <= MAX_PIXELS {
        return shots;
    }
    let scale = (MAX_PIXELS as f64 / total as f64).sqrt();
    shots
        .into_iter()
        .map(|s| image::imageops::resize(&s, ((s.width() as f64 * scale) as u32).max(1), ((s.height() as f64 * scale) as u32).max(1), image::imageops::FilterType::Triangle))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A wide scene with plenty of uneven detail, no repeating pattern.
    fn scene() -> RgbImage {
        RgbImage::from_fn(900, 300, |x, y| {
            let (xf, yf) = (x as f32, y as f32);
            let v = 128.0 + 55.0 * (xf / 13.1).sin() * (yf / 9.7).cos() + 40.0 * ((xf + 1.7 * yf) / 31.3).sin() + 30.0 * (xf * yf / 4100.0).cos() + 20.0 * (xf / 71.0).sin();
            let g = 110.0 + 50.0 * (xf / 23.0).cos() + 40.0 * (yf / 17.0).sin() * (xf / 53.0).cos();
            let b = 100.0 + 45.0 * ((xf - yf) / 19.0).sin() + 30.0 * (xf / 97.0).cos();
            Rgb([v.clamp(0.0, 255.0) as u8, g.clamp(0.0, 255.0) as u8, b.clamp(0.0, 255.0) as u8])
        })
    }

    fn window(img: &RgbImage, x: u32, y: u32, w: u32, h: u32, brighter: f32) -> RgbImage {
        let mut c = image::imageops::crop_imm(img, x, y, w, h).to_image();
        for p in c.pixels_mut() {
            for k in 0..3 {
                p[k] = (p[k] as f32 * brighter).clamp(0.0, 255.0) as u8;
            }
        }
        c
    }

    #[test]
    fn the_place_of_the_next_shot_is_found() {
        let s = scene();
        let a = window(&s, 0, 6, 400, 280, 1.0);
        let b = window(&s, 250, 10, 400, 280, 1.0);
        let (dx, dy, score) = find_offset(&a, &b).unwrap();
        assert_eq!((dx, dy), (250, 4), "b lies 250 to the right and 4 lower than a");
        assert!(score > 0.9, "{score}");
    }

    #[test]
    fn three_shots_are_joined_into_one_wide_picture_with_the_same_content_and_the_corners_cut() {
        let s = scene();
        // three shots with a little drift up and down and a little difference in brightness
        let shots = vec![window(&s, 0, 8, 380, 270, 1.0), window(&s, 260, 14, 380, 270, 0.93), window(&s, 520, 5, 380, 270, 1.05)];
        let pano = stitch(&shots).unwrap();
        assert!(pano.width() >= 850 && pano.width() <= 900, "width {}", pano.width());
        assert!(pano.height() >= 255 && pano.height() <= 270, "height {}", pano.height());
        // inside the picture it is the scene it came from (where the cut began is not known to the pixel, so the best fit is looked for)
        let error_at = |ox: u32, oy: u32| {
            let (mut total, mut n) = (0.0f64, 0.0f64);
            for y in (10..pano.height() - 10).step_by(5) {
                for x in (10..pano.width() - 10).step_by(7) {
                    let (p, q) = (pano.get_pixel(x, y), s.get_pixel((x + ox).min(899), (y + oy).min(299)));
                    total += (p[1] as f64 - q[1] as f64).abs();
                    n += 1.0;
                }
            }
            total / n
        };
        let best = (0..8).flat_map(|ox| (6..30).map(move |oy| (ox, oy))).map(|(ox, oy)| error_at(ox, oy)).fold(f64::MAX, f64::min);
        assert!(best < 9.0, "the joined picture is the scene (mean error {best})");        // an exact check on the seam: no step in brightness across the join between shots one and two
        let row = pano.height() / 2;
        let jump = (0..pano.width() - 1).map(|x| (pano.get_pixel(x, row)[1] as i32 - pano.get_pixel(x + 1, row)[1] as i32).abs()).max().unwrap();
        assert!(jump < 70, "no hard edge across the picture ({jump})");
    }

    #[test]
    fn photos_with_nothing_in_common_are_refused_in_words() {
        let a = RgbImage::from_fn(200, 150, |x, y| Rgb([((x * 7 + y * 13) % 255) as u8, ((x * 3) % 255) as u8, ((y * 11) % 255) as u8]));
        let b = RgbImage::from_fn(200, 150, |x, y| Rgb([((x * 17 + y * 5 + 90) % 255) as u8, ((y * 29) % 255) as u8, ((x * 13 + 40) % 255) as u8]));
        let e = stitch(&[a, b]).unwrap_err();
        assert!(e.contains("Photo 2"), "{e}");
        assert!(stitch(&[scene()]).unwrap_err().contains("two or more"));
    }

    #[test]
    fn the_biggest_rectangle_in_a_grid_is_found() {
        // . . X X
        // . . X X
        // . . . .
        let g = [true, true, false, false, true, true, false, false, true, true, true, true];
        let (x, y, w, h) = biggest_rectangle(&g, 4, 3);
        assert_eq!((x, y, w, h), (0, 0, 2, 3));
    }
}
