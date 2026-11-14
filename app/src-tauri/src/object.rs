//! Pick an object by pointing at it. The model is SAM 2.1 "Hiera tiny" (Meta, Apache-2.0; the ONNX export is from
//! https://huggingface.co/onnx-community/sam2.1-hiera-tiny-ONNX, made to take fixed sizes with onnx-simplifier so the program's runtime can
//! optimise it). It works in two steps: an encoder looks at the whole picture once (about eight seconds, squashed to 1024 x 1024) and its answer is
//! kept for the photo; then a small decoder turns a point (and a second one that says "not this") into the outline of the thing under it in a
//! fraction of a second. The answer is kept in the mask as a small grey picture, like the subject mask's, so it is the same every time it is drawn.
//!
//! The two model files are big (160 MB between them), so they are shipped beside the program (`resources/sam`) and read when first used.

use base64::Engine as _;
use image::{GrayImage, Luma, RgbImage};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tract_onnx::prelude::*;

const SIDE: usize = 1024;
/// The side of the grey picture kept in the mask.
pub const KEPT: u32 = 256;

static DIR: OnceLock<PathBuf> = OnceLock::new();

/// Where the model files are (set when the program starts).
pub fn set_dir(p: PathBuf) {
    let _ = DIR.set(p);
}

fn dir() -> PathBuf {
    DIR.get().cloned().unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("sam"))
}

fn load(file: &str) -> Result<Arc<TypedRunnableModel>, String> {
    let path = dir().join(file);
    if !path.is_file() {
        return Err(format!("The object model is not there ({}). Reinstall the program.", path.display()));
    }
    let m = tract_onnx::onnx().model_for_path(&path).map_err(|e| e.to_string())?;
    Ok(m.into_typed().and_then(|t| t.into_optimized()).and_then(|t| t.into_runnable()).map_err(|e| format!("The object model could not be prepared: {e}"))?)
}

fn encoder() -> Result<&'static Arc<TypedRunnableModel>, String> {
    static C: OnceLock<Result<Arc<TypedRunnableModel>, String>> = OnceLock::new();
    C.get_or_init(|| load("encoder.onnx")).as_ref().map_err(|e| e.clone())
}

fn decoder() -> Result<&'static Arc<TypedRunnableModel>, String> {
    static C: OnceLock<Result<Arc<TypedRunnableModel>, String>> = OnceLock::new();
    C.get_or_init(|| load("decoder.onnx")).as_ref().map_err(|e| e.clone())
}

/// What the encoder says about one picture: three tensors the decoder needs.
#[derive(Clone)]
pub struct Seen {
    key: String,
    parts: Vec<Arc<Tensor>>,
}

static LAST: Mutex<Option<Seen>> = Mutex::new(None);

/// Let the encoder look at the picture (unless it already has, for this `key`).
pub fn look(img: &RgbImage, key: &str) -> Result<Seen, String> {
    if let Ok(g) = LAST.lock() {
        if let Some(s) = g.as_ref().filter(|s| s.key == key) {
            return Ok(s.clone());
        }
    }
    let small = image::imageops::resize(img, SIDE as u32, SIDE as u32, image::imageops::FilterType::Triangle);
    let (mean, std) = ([0.485f32, 0.456, 0.406], [0.229f32, 0.224, 0.225]);
    let mut data = vec![0f32; 3 * SIDE * SIDE];
    for (x, y, p) in small.enumerate_pixels() {
        let i = y as usize * SIDE + x as usize;
        for c in 0..3 {
            data[c * SIDE * SIDE + i] = (p[c] as f32 / 255.0 - mean[c]) / std[c];
        }
    }
    let input = Tensor::from_shape(&[1, 3, SIDE, SIDE], &data).map_err(|e| e.to_string())?;
    let out = encoder()?.run(tvec!(input.into())).map_err(|e| format!("Looking at the picture stopped: {e}"))?;
    if out.len() != 3 {
        return Err("The object model gave an unexpected answer.".into());
    }
    let seen = Seen { key: key.to_string(), parts: out.iter().map(|t| t.clone().into_tensor().into_arc_tensor()).collect() };
    if let Ok(mut g) = LAST.lock() {
        *g = Some(seen.clone());
    }
    Ok(seen)
}

/// The outline of the thing at the point `(x, y)` (fractions of the picture). `not` is an optional second point that is not part of it. The
/// answer is a KEPT x KEPT grey picture, white inside the object. Returns the map and how sure the model is (0 to 1).
pub fn pick(seen: &Seen, x: f32, y: f32, not: Option<(f32, f32)>) -> Result<(GrayImage, f32), String> {
    let (px, py) = (x.clamp(0.0, 1.0) * SIDE as f32, y.clamp(0.0, 1.0) * SIDE as f32);
    // two points are always given: the second is a pad (label -1) unless there is a point to leave out (label 0)
    let (nx, ny, nl) = match not {
        Some((a, b)) => (a.clamp(0.0, 1.0) * SIDE as f32, b.clamp(0.0, 1.0) * SIDE as f32, 0i64),
        None => (0.0, 0.0, -1i64),
    };
    let points = Tensor::from_shape(&[1, 1, 2, 2], &[px, py, nx, ny]).map_err(|e| e.to_string())?;
    let labels = Tensor::from_shape(&[1, 1, 2], &[1i64, nl]).map_err(|e| e.to_string())?;
    // the graph always takes a box: a loose one round the point (it keeps the answer to what is near the point; a bigger thing is cut off at its edge)
    let reach = 0.3 * SIDE as f32;
    let boxes = Tensor::from_shape(&[1, 1, 4], &[(px - reach).max(0.0), (py - reach).max(0.0), (px + reach).min(SIDE as f32), (py + reach).min(SIDE as f32)]).map_err(|e| e.to_string())?;
    let inputs: TVec<TValue> = tvec!(points.into(), labels.into(), boxes.into(), seen.parts[0].clone().into_tvalue(), seen.parts[1].clone().into_tvalue(), seen.parts[2].clone().into_tvalue());
    let out = decoder()?.run(inputs).map_err(|e| format!("Finding the object stopped: {e}"))?;
    let scores = out[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
    let masks = out[1].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
    let n = scores.len().min(3);
    if n == 0 || masks.len() < n * 256 * 256 {
        return Err("The object model gave an unexpected answer.".into());
    }
    let sc: Vec<f32> = scores.iter().copied().take(n).collect();
    let best = (0..n).max_by(|a, b| sc[*a].partial_cmp(&sc[*b]).unwrap_or(std::cmp::Ordering::Equal)).unwrap_or(0);
    let all: Vec<f32> = masks.iter().copied().collect();
    let slice = &all[best * 256 * 256..(best + 1) * 256 * 256];
    let map = GrayImage::from_fn(256, 256, |px, py| {
        let logit = slice[py as usize * 256 + px as usize];
        Luma([((1.0 / (1.0 + (-logit * 1.2).exp())) * 255.0).round() as u8])
    });
    Ok((map, sc[best].clamp(0.0, 1.0)))
}

/// The map as text to keep in a mask (the same form as the subject mask's).
pub fn encode(map: &GrayImage) -> Result<String, String> {
    let mut bytes = Vec::new();
    map.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    /// A dark picture with a bright round object in it.
    fn scene() -> RgbImage {
        RgbImage::from_fn(300, 220, |x, y| {
            let d = (((x as f32 - 90.0).powi(2) + (y as f32 - 110.0).powi(2)) as f32).sqrt();
            if d < 55.0 { Rgb([235, 190, 60]) } else { Rgb([40 + (x / 8) as u8, 70, 90 + (y / 6) as u8]) }
        })
    }

    #[test]
    #[ignore = "reads 160 MB of model files and takes about ten seconds: run it with --ignored"]
    fn pointing_at_an_object_outlines_it_and_pointing_elsewhere_does_not() {
        let img = scene();
        let seen = look(&img, "test").unwrap();
        let (on, _) = pick(&seen, 90.0 / 300.0, 110.0 / 220.0, None).unwrap();
        let at = |m: &GrayImage, fx: f32, fy: f32| m.get_pixel((fx * 255.0) as u32, (fy * 255.0) as u32)[0];
        assert!(at(&on, 90.0 / 300.0, 110.0 / 220.0) > 180, "the object is white");
        assert!(at(&on, 270.0 / 300.0, 30.0 / 220.0) < 80, "the background is dark");
        // the picture is remembered: a second point costs only the small decoder
        let t = std::time::Instant::now();
        let again = look(&img, "test").unwrap();
        pick(&again, 0.9, 0.15, None).unwrap();
        assert!(t.elapsed().as_secs_f32() < 3.0);
    }
}
