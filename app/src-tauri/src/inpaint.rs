//! Filling a round hole in a picture with what plausibly belongs there, for the Fill mode of spot removal (a person, a sign or a
//! bin in the background).
//!
//! The model is MI-GAN (Picsart AI Research, MIT; the 512 x 512 generator), built into the program and run by tract. It sees a
//! 512 x 512 view of the neighbourhood of the hole with the hole blanked out and paints the blank. The answer for one hole is
//! worked out once and remembered, so dragging a slider does not run the model again.

use crate::develop::smoothstep;
use image::{Rgb, RgbImage};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use tract_onnx::prelude::*;

pub const MODEL: &[u8] = include_bytes!("../resources/migan-512-generator.onnx");

const SIDE: usize = 512;
/// The view is this many times the hole's radius on each side of its middle (so the hole is a quarter of the view's area).
const REACH: f32 = 2.0;
/// The smallest view, in pixels of the picture; a tiny hole still has this much around it to learn from.
const MIN_VIEW: f32 = 160.0;
/// The hole is made a little bigger than the spot, so that the edge of the thing being removed is inside it.
const GROW: f32 = 1.06;

type Model = TypedRunnableModel;

fn model() -> Result<&'static Arc<Model>, String> {
    static CACHE: OnceLock<Result<Arc<Model>, String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let load = || -> TractResult<Arc<Model>> {
                let m = tract_onnx::onnx().model_for_read(&mut std::io::Cursor::new(MODEL))?.with_input_fact(0, f32::fact([1, 4, SIDE, SIDE]).into())?;
                Ok(m.into_optimized()?.into_runnable()?)
            };
            load().map_err(|e| format!("the filling model could not be loaded: {e}"))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// Run the generator on a 4 x 512 x 512 input and give back its 3 x 512 x 512 answer.
fn run_tensor(data: Vec<f32>) -> Result<Vec<f32>, String> {
    let input = Tensor::from_shape(&[1, 4, SIDE, SIDE], &data).map_err(|e| e.to_string())?;
    let out = model()?.run(tvec!(input.into())).map_err(|e| format!("filling stopped: {e}"))?;
    let view = out[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
    if view.len() != 3 * SIDE * SIDE {
        return Err(format!("the filling model gave an unexpected size ({} values)", view.len()));
    }
    Ok(view.iter().copied().collect())
}

/// The input: the picture with the hole blanked (-1 to 1), and a mask channel. `hole` is 1 inside the hole.
fn input_for(img: &RgbImage, hole: &[f32]) -> Vec<f32> {
    let mut data = vec![0f32; 4 * SIDE * SIDE];
    for (i, p) in img.pixels().enumerate() {
        let known = 1.0 - hole[i];
        data[i] = 0.5 - known;
        for c in 0..3 {
            data[(c + 1) * SIDE * SIDE + i] = (p[c] as f32 / 127.5 - 1.0) * known;
        }
    }
    data
}

/// The 512 x 512 picture the model painted, from its output.
fn picture_from(out: &[f32]) -> RgbImage {
    RgbImage::from_fn(SIDE as u32, SIDE as u32, |x, y| {
        let i = y as usize * SIDE + x as usize;
        let v = |c: usize| ((out[c * SIDE * SIDE + i] * 0.5 + 0.5).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        Rgb([v(0), v(1), v(2)])
    })
}

/// Fill the round hole at (cx, cy) of radius `r` (pixels of `img`, whose pixels inside the hole are ignored): the model's
/// painting of the neighbourhood, as a square picture of `side` pixels whose top left is at `origin` in `img`.
pub struct Filled {
    pub origin: (i64, i64),
    pub picture: RgbImage,
}

pub fn fill_circle(img: &RgbImage, cx: f32, cy: f32, r: f32) -> Result<Filled, String> {
    let view = (2.0 * REACH * r).max(MIN_VIEW);
    let side = view.round() as i64;
    // the view's top left: centred on the hole, slid back inside the picture when the picture is big enough to allow it
    let slide = |c: f32, len: u32| {
        let o = (c - view / 2.0).round() as i64;
        if len as i64 >= side {
            o.clamp(0, len as i64 - side)
        } else {
            o
        }
    };
    let origin = (slide(cx, img.width()), slide(cy, img.height()));
    let clamp_px = |x: i64, y: i64| img.get_pixel(x.clamp(0, img.width() as i64 - 1) as u32, y.clamp(0, img.height() as i64 - 1) as u32);
    let region = RgbImage::from_fn(side as u32, side as u32, |x, y| *clamp_px(origin.0 + x as i64, origin.1 + y as i64));
    let small = image::imageops::resize(&region, SIDE as u32, SIDE as u32, image::imageops::FilterType::Triangle);
    let k = SIDE as f32 / side as f32;
    let (hx, hy, hr) = ((cx - origin.0 as f32) * k, (cy - origin.1 as f32) * k, r * GROW * k);
    let hole: Vec<f32> = (0..SIDE * SIDE)
        .map(|i| {
            let (dx, dy) = ((i % SIDE) as f32 + 0.5 - hx, (i / SIDE) as f32 + 0.5 - hy);
            ((hr + 0.5 - (dx * dx + dy * dy).sqrt()).clamp(0.0, 1.0) > 0.0) as u8 as f32
        })
        .collect();
    let painted = picture_from(&run_tensor(input_for(&small, &hole))?);
    // outside the hole the picture is the real one; inside it, the painting
    let mixed = RgbImage::from_fn(SIDE as u32, SIDE as u32, |x, y| if hole[y as usize * SIDE + x as usize] > 0.0 { *painted.get_pixel(x, y) } else { *small.get_pixel(x, y) });
    let picture = image::imageops::resize(&mixed, side as u32, side as u32, image::imageops::FilterType::Lanczos3);
    Ok(Filled { origin, picture })
}

/// How the painting is blended into the picture: 1 at the middle of the hole, fading to 0 over the outer `feather` of the
/// radius (0 is a hard edge).
pub fn weight(d: f32, r: f32, feather: f32) -> f32 {
    1.0 - smoothstep(r * (1.0 - feather), r, d)
}

/// The paintings already made, so that a slider moving does not run the model again. A key says which hole, in which picture.
static CACHE: Mutex<Option<(Vec<u64>, HashMap<u64, Arc<Filled>>)>> = Mutex::new(None);
const CACHE_LIMIT: usize = 12;

fn hash_view(img: &RgbImage, cx: f32, cy: f32, r: f32) -> u64 {
    // FNV-1a over where and how big the hole is, the size of the picture, and a spread of the pixels in its view
    let mut h: u64 = 0xcbf29ce484222325;
    let mut put = |v: u64| {
        h ^= v;
        h = h.wrapping_mul(0x100000001b3);
    };
    put(cx.to_bits() as u64);
    put(cy.to_bits() as u64);
    put(r.to_bits() as u64);
    put(img.width() as u64);
    put(img.height() as u64);
    let reach = (REACH * r).max(MIN_VIEW / 2.0) + 2.0;
    let step = (reach / 24.0).max(1.0);
    let (x0, x1, y0, y1) = ((cx - reach).max(0.0), (cx + reach).min(img.width() as f32 - 1.0), (cy - reach).max(0.0), (cy + reach).min(img.height() as f32 - 1.0));
    let mut y = y0;
    while y <= y1 {
        let mut x = x0;
        while x <= x1 {
            let p = img.get_pixel(x as u32, y as u32);
            put(p[0] as u64 | (p[1] as u64) << 8 | (p[2] as u64) << 16);
            x += step;
        }
        y += step;
    }
    h
}

/// `fill_circle`, remembered.
pub fn fill_cached(img: &RgbImage, cx: f32, cy: f32, r: f32) -> Result<Arc<Filled>, String> {
    let key = hash_view(img, cx, cy, r);
    if let Ok(g) = CACHE.lock() {
        if let Some((_, map)) = g.as_ref() {
            if let Some(hit) = map.get(&key) {
                return Ok(hit.clone());
            }
        }
    }
    let made = Arc::new(fill_circle(img, cx, cy, r)?);
    if let Ok(mut g) = CACHE.lock() {
        let (order, map) = g.get_or_insert_with(|| (Vec::new(), HashMap::new()));
        if map.insert(key, made.clone()).is_none() {
            order.push(key);
        }
        while order.len() > CACHE_LIMIT {
            let old = order.remove(0);
            map.remove(&old);
        }
    }
    Ok(made)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A smooth picture with a texture that is the same in every place, so that what belongs in a hole can be told.
    fn truth(w: u32, h: u32) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| {
            let (fx, fy) = (x as f32 / w as f32, y as f32 / h as f32);
            let stripe = if (x / 12 + y / 12) % 2 == 0 { 14.0 } else { 0.0 };
            Rgb([(70.0 + 120.0 * fx + stripe) as u8, (90.0 + 80.0 * fy + stripe) as u8, (140.0 - 50.0 * fx + stripe) as u8])
        })
    }

    fn error_in_hole(img: &RgbImage, truth: &RgbImage, cx: f32, cy: f32, r: f32) -> f64 {
        let (mut sum, mut n) = (0f64, 0f64);
        for (x, y, p) in img.enumerate_pixels() {
            let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
            if (dx * dx + dy * dy).sqrt() < r * 0.9 {
                let q = truth.get_pixel(x, y);
                sum += (0..3).map(|c| (p[c] as f64 - q[c] as f64).abs()).sum::<f64>() / 3.0;
                n += 1.0;
            }
        }
        sum / n
    }

    /// Paint over the hole with something wrong (a loud red), fill it, and see how near the truth the filling comes.
    fn try_fill(w: u32, h: u32, cx: f32, cy: f32, r: f32) -> (f64, f64, RgbImage) {
        let real = truth(w, h);
        let mut spoiled = real.clone();
        for (x, y, p) in spoiled.enumerate_pixels_mut() {
            let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
            if (dx * dx + dy * dy).sqrt() < r {
                *p = Rgb([230, 20, 20]);
            }
        }
        let filled = fill_circle(&spoiled, cx, cy, r).unwrap();
        let mut out = spoiled.clone();
        for (x, y, p) in out.enumerate_pixels_mut() {
            let (dx, dy) = (x as f32 + 0.5 - cx, y as f32 + 0.5 - cy);
            if (dx * dx + dy * dy).sqrt() < r {
                let (fx, fy) = (x as i64 - filled.origin.0, y as i64 - filled.origin.1);
                if fx >= 0 && fy >= 0 && (fx as u32) < filled.picture.width() && (fy as u32) < filled.picture.height() {
                    *p = *filled.picture.get_pixel(fx as u32, fy as u32);
                }
            }
        }
        (error_in_hole(&spoiled, &real, cx, cy, r), error_in_hole(&out, &real, cx, cy, r), out)
    }

    #[test]
    fn a_loud_patch_is_replaced_by_something_much_nearer_the_surroundings() {
        let (before, after, _) = try_fill(400, 300, 200.0, 150.0, 40.0);
        assert!(after < before / 4.0 && after < 30.0, "error before {before:.1}, after {after:.1}");
    }

    #[test]
    fn it_works_for_a_hole_at_the_edge_of_the_picture_and_for_a_large_one() {
        let (b, a, _) = try_fill(400, 300, 20.0, 150.0, 30.0); // the hole runs off the left edge
        assert!(a < b / 3.0, "edge: before {b:.1}, after {a:.1}");
        let (b, a, _) = try_fill(900, 700, 450.0, 350.0, 150.0); // a big hole: the view is much bigger than 512
        assert!(a < b / 3.0, "large: before {b:.1}, after {a:.1}");
        let (b, a, _) = try_fill(120, 90, 60.0, 45.0, 12.0); // a small picture: the view is bigger than the picture
        assert!(a < b / 3.0, "small: before {b:.1}, after {a:.1}");
    }

    #[test]
    fn the_same_hole_gives_the_same_painting_and_the_cache_remembers_it() {
        let mut img = truth(300, 200);
        for (x, y, p) in img.enumerate_pixels_mut() {
            if ((x as f32 - 150.0).powi(2) + (y as f32 - 100.0).powi(2)).sqrt() < 20.0 {
                *p = Rgb([200, 30, 30]);
            }
        }
        let a = fill_cached(&img, 150.0, 100.0, 20.0).unwrap();
        let b = fill_cached(&img, 150.0, 100.0, 20.0).unwrap();
        assert!(Arc::ptr_eq(&a, &b), "the second time it is remembered");
        assert_eq!(a.picture, fill_circle(&img, 150.0, 100.0, 20.0).unwrap().picture, "and it is what a fresh run gives");
        // another size of hole, or a changed picture, is a different painting
        assert!(!Arc::ptr_eq(&a, &fill_cached(&img, 150.0, 100.0, 24.0).unwrap()));
        let mut other = img.clone();
        // a change that matters (the crop moved, a block of the picture is different), not one stray pixel
        for y in 55..70 {
            for x in 140..160 {
                other.put_pixel(x, y, Rgb([1, 2, 3]));
            }
        }
        assert!(!Arc::ptr_eq(&a, &fill_cached(&other, 150.0, 100.0, 20.0).unwrap()));
    }

    #[test]
    fn the_blend_is_full_in_the_middle_gone_at_the_rim_and_hard_with_no_feather() {
        assert_eq!(weight(0.0, 10.0, 0.5), 1.0);
        assert_eq!(weight(10.0, 10.0, 0.5), 0.0);
        let w = weight(8.0, 10.0, 0.5);
        assert!(w > 0.0 && w < 1.0);
        assert_eq!(weight(9.9, 10.0, 0.0), 1.0, "no feather: full to the rim");
    }
}
