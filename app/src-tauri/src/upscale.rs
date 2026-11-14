//! Making a picture bigger, for a photo that was cropped in too far.
//!
//! Two ways: "smooth" (a good resampling filter and a touch of sharpening) and "ai" (Real-ESRGAN `realesr-general-x4v3`,
//! BSD-3-Clause, built into the program and run on this machine by `tract`, like the face detector). The AI model makes the
//! picture four times as large and draws in fine detail that is likely to be there; it cannot know what was really there, so
//! it is an enlargement that looks sharp, not extra information.

use image::imageops::FilterType;
use image::{Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tract_onnx::prelude::*;

pub const MODEL: &[u8] = include_bytes!("../resources/realesr-general-x4v3.onnx");

/// What is done when the export asks for a longer side than the picture has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Enlarge {
    /// Nothing: the picture is only ever made smaller.
    #[default]
    None,
    Smooth,
    Ai,
}

/// Tiles: the model sees `IN` x `IN` pixels and its answer is trusted for the middle `CORE` x `CORE`; the rest is only context,
/// so that the seams between tiles cannot be seen.
const CORE: usize = 64;
const PAD: usize = 8;
const IN: usize = CORE + 2 * PAD;
const SCALE: usize = 4;
/// Largest picture the AI step will make, in pixels (a bigger target is reached by a smooth step after it).
const MAX_AI_PIXELS: u64 = 100_000_000;

type Model = TypedRunnableModel;

fn model() -> Result<&'static Arc<Model>, String> {
    static CACHE: OnceLock<Result<Arc<Model>, String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let load = || -> TractResult<Arc<Model>> {
                let m = tract_onnx::onnx().model_for_read(&mut std::io::Cursor::new(MODEL))?.with_input_fact(0, f32::fact([1, 3, IN, IN]).into())?;
                Ok(m.into_optimized()?.into_runnable()?)
            };
            load().map_err(|e| format!("the enlarging model could not be loaded: {e}"))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// Where the tiles of `len` pixels start, every `CORE` pixels.
pub fn tile_starts(len: u32) -> Vec<u32> {
    (0..len).step_by(CORE).collect()
}

/// The size a picture of `w` x `h` becomes when its longer side is made `long_edge`.
pub fn target_size(w: u32, h: u32, long_edge: u32) -> (u32, u32) {
    let cur = w.max(h).max(1);
    let k = long_edge as f64 / cur as f64;
    (((w as f64 * k).round() as u32).max(1), ((h as f64 * k).round() as u32).max(1))
}

/// A bigger picture by a good filter, with a light sharpening: the filter alone leaves it a little soft.
pub fn smooth(img: &RgbImage, tw: u32, th: u32) -> RgbImage {
    let big = image::imageops::resize(img, tw, th, FilterType::Lanczos3);
    let k = (tw as f32 / img.width().max(1) as f32).max(1.0);
    let sharp = image::imageops::unsharpen(&big, (0.5 + 0.35 * k).min(2.0), 0);
    // half of the sharpening: enough to bring the edges back, not enough to draw halos
    let mut out = big;
    for (o, s) in out.pixels_mut().zip(sharp.pixels()) {
        for c in 0..3 {
            o[c] = ((o[c] as u16 + s[c] as u16 + 1) / 2) as u8;
        }
    }
    out
}

/// The model's input for the tile whose middle starts at (x0, y0): IN x IN pixels, the edge pixels repeated beyond the picture.
fn tile_input(img: &RgbImage, x0: u32, y0: u32) -> Tensor {
    let (w, h) = (img.width() as i64, img.height() as i64);
    let mut data = vec![0f32; 3 * IN * IN];
    for ty in 0..IN {
        let sy = (y0 as i64 + ty as i64 - PAD as i64).clamp(0, h - 1) as u32;
        for tx in 0..IN {
            let sx = (x0 as i64 + tx as i64 - PAD as i64).clamp(0, w - 1) as u32;
            let p = img.get_pixel(sx, sy);
            let i = ty * IN + tx;
            data[i] = p[0] as f32 / 255.0;
            data[IN * IN + i] = p[1] as f32 / 255.0;
            data[2 * IN * IN + i] = p[2] as f32 / 255.0;
        }
    }
    Tensor::from_shape(&[1, 3, IN, IN], &data).expect("shape matches data")
}

/// The picture made four times as large by the model. `progress(done, total)` is called as tiles are finished (from several
/// threads at once).
pub fn ai_x4(img: &RgbImage, progress: &(dyn Fn(usize, usize) + Sync)) -> Result<RgbImage, String> {
    let model = model()?;
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return Err("There is no picture to enlarge.".into());
    }
    if (w as u64 * SCALE as u64) * (h as u64 * SCALE as u64) > MAX_AI_PIXELS * 2 {
        return Err("That picture is too large to enlarge with the AI step.".into());
    }
    let jobs: Vec<(u32, u32)> = tile_starts(h).into_iter().flat_map(|y| tile_starts(w).into_iter().map(move |x| (x, y))).collect();
    let total = jobs.len();
    let out = Mutex::new(RgbImage::new(w * SCALE as u32, h * SCALE as u32));
    let done = AtomicUsize::new(0);
    let threads = crate::perf::threads(false).min(total);
    let result: Result<Vec<()>, String> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                let (jobs, out, done) = (&jobs, &out, &done);
                s.spawn(move || -> Result<(), String> {
                    for &(x0, y0) in jobs.iter().skip(t).step_by(threads) {
                        let result = model.run(tvec!(tile_input(img, x0, y0).into())).map_err(|e| format!("enlarging stopped: {e}"))?;
                        let view = result[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
                        let shape = view.shape().to_vec();
                        if shape != [1, 3, IN * SCALE, IN * SCALE] {
                            return Err(format!("the enlarging model gave an unexpected shape {shape:?}"));
                        }
                        let (cw, ch) = ((CORE as u32).min(w - x0), (CORE as u32).min(h - y0));
                        let mut tile = RgbImage::new(cw * SCALE as u32, ch * SCALE as u32);
                        for y in 0..ch as usize * SCALE {
                            for x in 0..cw as usize * SCALE {
                                let (sy, sx) = (y + PAD * SCALE, x + PAD * SCALE);
                                let px = |c: usize| (view[[0, c, sy, sx]].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                                tile.put_pixel(x as u32, y as u32, Rgb([px(0), px(1), px(2)]));
                            }
                        }
                        {
                            let mut o = out.lock().map_err(|_| "enlarging stopped".to_string())?;
                            image::imageops::replace(&mut *o, &tile, (x0 as usize * SCALE) as i64, (y0 as usize * SCALE) as i64);
                        }
                        progress(done.fetch_add(1, Ordering::SeqCst) + 1, total);
                    }
                    Ok(())
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("enlarging stopped".to_string()))).collect()
    });
    result?;
    out.into_inner().map_err(|_| "enlarging stopped".to_string())
}

/// `img` with its longer side made `long_edge`, by the chosen method. A picture that is already that long or longer is
/// returned as it is (this never makes a picture smaller).
pub fn enlarge(img: RgbImage, long_edge: u32, method: Enlarge, progress: &(dyn Fn(usize, usize) + Sync)) -> Result<RgbImage, String> {
    let (w, h) = img.dimensions();
    if method == Enlarge::None || long_edge == 0 || long_edge <= w.max(h) {
        return Ok(img);
    }
    let (tw, th) = target_size(w, h, long_edge);
    match method {
        Enlarge::None => Ok(img),
        Enlarge::Smooth => Ok(smooth(&img, tw, th)),
        Enlarge::Ai => {
            // keep the model's answer within the size it can be trusted to make; the rest of the way is a smooth step
            let cap = (MAX_AI_PIXELS as f64 / (SCALE * SCALE) as f64 / (w as f64 * h as f64)).sqrt();
            let source = if cap < 1.0 { image::imageops::resize(&img, ((w as f64 * cap) as u32).max(1), ((h as f64 * cap) as u32).max(1), FilterType::Lanczos3) } else { img };
            let big = ai_x4(&source, progress)?;
            Ok(if big.dimensions() == (tw, th) {
                big
            } else if big.width() > tw {
                image::imageops::resize(&big, tw, th, FilterType::Lanczos3)
            } else {
                smooth(&big, tw, th)
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A soft diagonal gradient with a hard edge and a thin line: something an enlarger can get right or wrong.
    fn scene(w: u32, h: u32) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| {
            let g = (40 + (x * 120 / w.max(1))) as u8;
            if x == w / 2 || y == h / 3 {
                Rgb([250, 250, 250])
            } else if x > w * 3 / 4 {
                Rgb([200, 60, 40])
            } else {
                Rgb([g, g, (g as u32 / 2 + y * 40 / h.max(1)) as u8])
            }
        })
    }

    /// A smooth picture with soft edges, like most of a photograph: a gradient with a soft disc in it.
    fn soft_scene(w: u32, h: u32) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| {
            let (dx, dy) = (x as f32 / w as f32 - 0.5, y as f32 / h as f32 - 0.45);
            let disc = (1.0 - ((dx * dx + dy * dy).sqrt() * 5.0 - 1.0).clamp(0.0, 1.0)).clamp(0.0, 1.0);
            let g = 60.0 + 100.0 * x as f32 / w as f32;
            Rgb([(g + disc * 80.0) as u8, (g * 0.8 + disc * 60.0) as u8, (140.0 - g * 0.3 + disc * 20.0) as u8])
        })
    }

    fn mean_error(a: &RgbImage, b: &RgbImage) -> f64 {
        assert_eq!(a.dimensions(), b.dimensions());
        a.pixels().zip(b.pixels()).map(|(p, q)| (0..3).map(|c| (p[c] as f64 - q[c] as f64).abs()).sum::<f64>() / 3.0).sum::<f64>() / (a.width() * a.height()) as f64
    }

    #[test]
    fn the_target_keeps_the_shape_and_the_tiles_cover_the_picture() {
        assert_eq!(target_size(300, 200, 600), (600, 400));
        assert_eq!(target_size(200, 300, 900), (600, 900));
        assert_eq!(target_size(1, 1, 5), (5, 5));
        assert_eq!(tile_starts(64), [0]);
        assert_eq!(tile_starts(65), [0, 64]);
        assert_eq!(tile_starts(150), [0, 64, 128]);
        assert_eq!(tile_starts(0), Vec::<u32>::new());
    }

    #[test]
    fn it_never_makes_a_picture_smaller_and_does_nothing_when_off() {
        let img = scene(60, 40);
        let nope = |_: usize, _: usize| {};
        for method in [Enlarge::None, Enlarge::Smooth, Enlarge::Ai] {
            assert_eq!(enlarge(img.clone(), 30, method, &nope).unwrap(), img, "{method:?}: asked for less");
            assert_eq!(enlarge(img.clone(), 60, method, &nope).unwrap(), img, "{method:?}: asked for the same");
            assert_eq!(enlarge(img.clone(), 0, method, &nope).unwrap(), img, "{method:?}: zero means keep");
        }
        assert_eq!(enlarge(img.clone(), 600, Enlarge::None, &nope).unwrap(), img, "off is off");
    }

    #[test]
    fn smooth_reaches_the_size_asked_for_and_is_closer_to_the_truth_than_a_blocky_enlargement() {
        let truth = soft_scene(240, 160);
        let small = image::imageops::resize(&truth, 60, 40, FilterType::Triangle);
        let nope = |_: usize, _: usize| {};
        let up = enlarge(small.clone(), 240, Enlarge::Smooth, &nope).unwrap();
        assert_eq!(up.dimensions(), (240, 160));
        let blocky = image::imageops::resize(&small, 240, 160, FilterType::Nearest);
        assert!(mean_error(&up, &truth) < mean_error(&blocky, &truth), "smooth must beat nearest-neighbour");
        // a size that is not a whole multiple still comes out exactly right
        assert_eq!(enlarge(small, 100, Enlarge::Smooth, &nope).unwrap().dimensions(), (100, 67));
    }

    #[test]
    fn the_model_loads_and_makes_the_picture_four_times_as_large_with_the_content_in_place() {
        let truth = scene(128, 96);
        let small = image::imageops::resize(&truth, 64, 48, FilterType::Triangle);
        let calls = AtomicUsize::new(0);
        let count = |done: usize, total: usize| {
            assert!(done >= 1 && done <= total);
            calls.fetch_add(1, Ordering::SeqCst);
        };
        let big = ai_x4(&small, &count).unwrap();
        assert_eq!(big.dimensions(), (256, 192));
        assert_eq!(calls.load(Ordering::SeqCst), 1, "a picture of one tile reports one tile");
        // the same content: shrunk back, it is close to what went in (a wrong tile offset or colour order would not be)
        let back = image::imageops::resize(&big, 64, 48, FilterType::Triangle);
        assert!(mean_error(&back, &small) < 12.0, "the enlarged picture is not the same picture: error {}", mean_error(&back, &small));
    }

    #[test]
    fn tiles_join_without_a_seam_and_the_edges_of_a_picture_that_is_not_a_whole_number_of_tiles_are_filled() {
        // 200 x 130 needs 3 x 2 tiles, the last ones partial
        let truth = scene(200, 130);
        let nope = |_: usize, _: usize| {};
        let big = ai_x4(&truth, &nope).unwrap();
        assert_eq!(big.dimensions(), (800, 520));
        let back = image::imageops::resize(&big, 200, 130, FilterType::Triangle);
        assert!(mean_error(&back, &truth) < 12.0, "error {}", mean_error(&back, &truth));
        // no tile was left black: look at the last column and row of the enlarged picture
        let dark_rows = (0..big.height()).filter(|&y| big.get_pixel(big.width() - 1, y).0.iter().all(|&v| v < 5)).count();
        let dark_cols = (0..big.width()).filter(|&x| big.get_pixel(x, big.height() - 1).0.iter().all(|&v| v < 5)).count();
        assert_eq!((dark_rows, dark_cols), (0, 0), "an edge tile is missing");
        // a seam would show as a step in the smooth gradient at the tile border (x = 64 * 4)
        let seam = (0..big.height()).map(|y| (big.get_pixel(256, y)[0] as i32 - big.get_pixel(255, y)[0] as i32).abs()).sum::<i32>() as f64 / big.height() as f64;
        let usual = (0..big.height()).map(|y| (big.get_pixel(300, y)[0] as i32 - big.get_pixel(299, y)[0] as i32).abs()).sum::<i32>() as f64 / big.height() as f64;
        assert!(seam < usual + 3.0, "a visible seam: {seam} against {usual}");
    }

    #[test]
    fn ai_reaches_a_size_that_is_not_four_times_and_reports_progress_for_every_tile() {
        let img = scene(100, 60); // 2 x 1 tiles
        let seen = Mutex::new(Vec::new());
        let note = |d: usize, t: usize| seen.lock().unwrap().push((d, t));
        let out = enlarge(img.clone(), 200, Enlarge::Ai, &note).unwrap();
        assert_eq!(out.dimensions(), (200, 120), "twice, from the four times picture");
        let mut got = seen.lock().unwrap().clone();
        got.sort();
        assert_eq!(got, [(1, 2), (2, 2)]);
        let out = enlarge(img, 700, Enlarge::Ai, &|_, _| {}).unwrap();
        assert_eq!(out.dimensions(), (700, 420), "seven times: the four times picture, then a smooth step");
    }

    #[test]
    fn the_enlarge_setting_is_written_in_lower_case_and_is_off_by_default() {
        assert_eq!(serde_json::to_string(&Enlarge::Ai).unwrap(), "\"ai\"");
        assert_eq!(serde_json::from_str::<Enlarge>("\"smooth\"").unwrap(), Enlarge::Smooth);
        assert_eq!(Enlarge::default(), Enlarge::None);
        assert!(serde_json::from_str::<Enlarge>("\"magic\"").is_err());
    }

    /// Time it on a real photo: `cargo test --release try_enlarge -- --ignored --nocapture`, with PENUMBRA_PHOTO set to a file.
    #[test]
    #[ignore]
    fn try_enlarge() {
        let Ok(path) = std::env::var("PENUMBRA_PHOTO") else { return };
        let img = image::open(&path).unwrap().to_rgb8();
        let crop = image::imageops::crop_imm(&img, img.width() / 3, img.height() / 3, 600, 400).to_image();
        let t = std::time::Instant::now();
        let big = ai_x4(&crop, &|_, _| {}).unwrap();
        println!("600x400 -> {}x{} in {:?}", big.width(), big.height(), t.elapsed());
        let dir = std::env::temp_dir();
        big.save(dir.join("penumbra-ai.png")).unwrap();
        smooth(&crop, 2400, 1600).save(dir.join("penumbra-smooth.png")).unwrap();
        println!("written to {}", dir.display());
    }
}
