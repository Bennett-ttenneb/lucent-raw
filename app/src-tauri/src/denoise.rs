//! AI denoise. The model is TreeNet "Denoise Super Light" from the RawForge project (MIT licence), built into the program and run by tract. It
//! was trained on real camera noise and works on linear Rec.2020 colour in tiles of 256 pixels, told roughly how noisy the photo is (its ISO).
//! The program's pictures are 8-bit sRGB, so each picture is taken to linear Rec.2020, denoised tile by tile (the tiles overlap and are blended,
//! so there are no seams) and brought back. The model file was made to take a fixed 256 x 256 tile in 32-bit numbers (the original is 16-bit
//! and has a size that varies, which tract cannot optimise).

use image::RgbImage;
use std::sync::{Arc, OnceLock};
use tract_onnx::prelude::*;

pub const MODEL: &[u8] = include_bytes!("../resources/treenet-denoise-256.onnx");
const TILE: usize = 256;
const STRIDE: usize = 192;
const FEATHER: usize = 32;

type Runner = Arc<TypedRunnableModel>;

fn runner() -> Result<Runner, String> {
    static CELL: OnceLock<Result<Runner, String>> = OnceLock::new();
    CELL.get_or_init(|| {
        let load = || -> TractResult<Runner> {
            let m = tract_onnx::onnx().model_for_read(&mut std::io::Cursor::new(MODEL))?.into_typed()?.into_optimized()?.into_runnable()?;
            Ok(m)
        };
        load().map_err(|e| format!("The denoise model could not be loaded: {e}"))
    })
    .clone()
}

fn srgb_to_linear(v: f32) -> f32 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

fn linear_to_srgb(v: f32) -> f32 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

const TO_2020: [[f32; 3]; 3] = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]];
const FROM_2020: [[f32; 3]; 3] = [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]];

fn mul(m: &[[f32; 3]; 3], c: [f32; 3]) -> [f32; 3] {
    [m[0][0] * c[0] + m[0][1] * c[1] + m[0][2] * c[2], m[1][0] * c[0] + m[1][1] * c[1] + m[1][2] * c[2], m[2][0] * c[0] + m[2][1] * c[1] + m[2][2] * c[2]]
}

/// The picture as three planes of linear Rec.2020 light.
fn to_planes(img: &RgbImage) -> Vec<Vec<f32>> {
    let lut: Vec<f32> = (0..256).map(|v| srgb_to_linear(v as f32 / 255.0)).collect();
    let n = (img.width() * img.height()) as usize;
    let mut planes = vec![vec![0f32; n]; 3];
    for (i, p) in img.pixels().enumerate() {
        let c = mul(&TO_2020, [lut[p[0] as usize], lut[p[1] as usize], lut[p[2] as usize]]);
        for k in 0..3 {
            planes[k][i] = c[k];
        }
    }
    planes
}

fn reflect(i: isize, n: usize) -> usize {
    let n = n as isize;
    let mut i = i;
    if n == 1 {
        return 0;
    }
    while i < 0 || i >= n {
        i = if i < 0 { -i } else { 2 * (n - 1) - i };
    }
    i as usize
}

/// Positions along one side where tiles start: every STRIDE, the last one flush with the end.
fn starts(len: usize) -> Vec<isize> {
    if len <= TILE {
        return vec![0];
    }
    let mut v: Vec<isize> = (0..).map(|i| (i * STRIDE) as isize).take_while(|s| (*s as usize) + TILE < len).collect();
    v.push((len - TILE) as isize);
    v
}

/// Denoise the picture. `iso` says how noisy it is (the model is told iso / 6400), `amount` is 0 to 1 (how much of the result is used).
/// `progress(done, total)` is told after each tile.
pub fn denoise(img: &RgbImage, iso: f32, amount: f32, progress: &(dyn Fn(usize, usize) + Sync)) -> Result<RgbImage, String> {
    let run = runner()?;
    let (w, h) = (img.width() as usize, img.height() as usize);
    if w < 8 || h < 8 {
        return Ok(img.clone());
    }
    let planes = to_planes(img);
    let cond = (iso.clamp(50.0, 65535.0) / 6400.0).min(10.0);
    let (xs, ys) = (starts(w), starts(h));
    let jobs: Vec<(isize, isize)> = ys.iter().flat_map(|y| xs.iter().map(move |x| (*x, *y))).collect();
    let total = jobs.len();
    let done = std::sync::atomic::AtomicUsize::new(0);
    let next = std::sync::atomic::AtomicUsize::new(0);
    let acc = std::sync::Mutex::new((vec![vec![0f32; w * h]; 3], vec![0f32; w * h]));
    let failure: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
    let threads = crate::perf::threads(true).max(1).min(total);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                let j = next.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if j >= total || failure.lock().map(|f| f.is_some()).unwrap_or(true) {
                    break;
                }
                let (x0, y0) = jobs[j];
                let mut input = vec![0f32; 3 * TILE * TILE];
                for c in 0..3 {
                    for ty in 0..TILE {
                        let sy = reflect(y0 + ty as isize, h);
                        for tx in 0..TILE {
                            input[c * TILE * TILE + ty * TILE + tx] = planes[c][sy * w + reflect(x0 + tx as isize, w)];
                        }
                    }
                }
                let result = (|| -> Result<Vec<f32>, String> {
                    let x = Tensor::from_shape(&[1, 3, TILE, TILE], &input).map_err(|e| e.to_string())?;
                    let c = tensor2(&[[cond]]);
                    let out = run.run(tvec!(x.into(), c.into())).map_err(|e| format!("The denoise model failed: {e}"))?;
                    Ok(out[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?.iter().copied().collect())
                })();
                match result {
                    Ok(out) => {
                        let mut g = acc.lock().unwrap();
                        for ty in 0..TILE {
                            let y = y0 + ty as isize;
                            if y < 0 || y >= h as isize {
                                continue;
                            }
                            // a tile counts less towards its edges, except where it is at the edge of the picture
                            let wy = (ty + 1).min(TILE - ty).min(FEATHER) as f32 / FEATHER as f32;
                            let wy = if (y0 <= 0 && ty < FEATHER) || (y0 as usize + TILE >= h && TILE - ty <= FEATHER) { 1.0 } else { wy };
                            for tx in 0..TILE {
                                let x = x0 + tx as isize;
                                if x < 0 || x >= w as isize {
                                    continue;
                                }
                                let wx = (tx + 1).min(TILE - tx).min(FEATHER) as f32 / FEATHER as f32;
                                let wx = if (x0 <= 0 && tx < FEATHER) || (x0 as usize + TILE >= w && TILE - tx <= FEATHER) { 1.0 } else { wx };
                                let i = y as usize * w + x as usize;
                                let wt = wx * wy;
                                for c in 0..3 {
                                    g.0[c][i] += out[c * TILE * TILE + ty * TILE + tx] * wt;
                                }
                                g.1[i] += wt;
                            }
                        }
                    }
                    Err(e) => {
                        if let Ok(mut f) = failure.lock() {
                            *f = Some(e);
                        }
                    }
                }
                let d = done.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                progress(d, total);
            });
        }
    });
    if let Some(e) = failure.into_inner().ok().flatten() {
        return Err(e);
    }
    let (sums, weights) = acc.into_inner().map_err(|_| "busy".to_string())?;
    let amount = amount.clamp(0.0, 1.0);
    let mut out = RgbImage::new(w as u32, h as u32);
    for (i, px) in img.pixels().enumerate() {
        let wt = weights[i].max(1e-6);
        let den = mul(&FROM_2020, [sums[0][i] / wt, sums[1][i] / wt, sums[2][i] / wt]);
        let mut rgb = [0u8; 3];
        for c in 0..3 {
            let denoised = linear_to_srgb(den[c]) * 255.0;
            rgb[c] = (px[c] as f32 * (1.0 - amount) + denoised * amount).round().clamp(0.0, 255.0) as u8;
        }
        out.put_pixel((i % w) as u32, (i / w) as u32, image::Rgb(rgb));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    /// A smooth picture, and the same with noise added (a repeatable pseudo-random sequence).
    fn pair() -> (RgbImage, RgbImage) {
        let clean = RgbImage::from_fn(300, 260, |x, y| Rgb([(60 + x / 3) as u8, (90 + y / 4) as u8, 120]));
        let mut seed = 12345u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            ((seed >> 16) as f32 / 65535.0 - 0.5) * 2.0
        };
        let noisy = RgbImage::from_fn(300, 260, |x, y| {
            let p = clean.get_pixel(x, y);
            Rgb([0, 1, 2].map(|c| (p[c] as f32 + rnd() * 18.0).clamp(0.0, 255.0) as u8))
        });
        (clean, noisy)
    }

    fn error(a: &RgbImage, b: &RgbImage) -> f64 {
        let mut s = 0.0;
        for (p, q) in a.pixels().zip(b.pixels()) {
            for c in 0..3 {
                s += (p[c] as f64 - q[c] as f64).powi(2);
            }
        }
        (s / (a.width() * a.height() * 3) as f64).sqrt()
    }

    #[test]
    fn denoising_a_noisy_picture_brings_it_nearer_the_clean_one_and_the_amount_blends() {
        let (clean, noisy) = pair();
        let ticks = std::sync::atomic::AtomicUsize::new(0);
        let out = denoise(&noisy, 1600.0, 1.0, &|_, _| {
            ticks.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
        .unwrap();
        assert_eq!(out.dimensions(), noisy.dimensions());
        assert!(ticks.load(std::sync::atomic::Ordering::SeqCst) >= 4, "more than one tile was done");
        let (before, after) = (error(&noisy, &clean), error(&out, &clean));
        assert!(after < before * 0.8, "noise {before:.1} became {after:.1}");
        // amount 0 is the picture as it was; half is in between
        assert_eq!(denoise(&noisy, 1600.0, 0.0, &|_, _| {}).unwrap(), noisy);
        let half = error(&denoise(&noisy, 1600.0, 0.5, &|_, _| {}).unwrap(), &clean);
        assert!(half < before && half > after - 0.5, "{before:.1} {half:.1} {after:.1}");
        // a picture smaller than a tile is still handled, and a tiny one is left alone
        let small = RgbImage::from_pixel(100, 90, Rgb([120, 100, 80]));
        assert_eq!(denoise(&small, 400.0, 1.0, &|_, _| {}).unwrap().dimensions(), (100, 90));
        assert_eq!(denoise(&RgbImage::new(4, 4), 400.0, 1.0, &|_, _| {}).unwrap().dimensions(), (4, 4));
    }
}
