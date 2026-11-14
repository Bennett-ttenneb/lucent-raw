//! How far away each part of a picture is, for the Depth range mask and the Lens blur. The model is Depth Anything V2 Small (Apache-2.0,
//! https://github.com/DepthAnything/Depth-Anything-V2; this copy was exported by https://github.com/fabio-sim/Depth-Anything-ONNX and then had its
//! helper functions unfolded and its size fixed with onnx-simplifier, so the program's runtime can optimise it). It looks at the picture squashed
//! to 518 x 518 and says how near each spot is, in relative terms. The answer is kept in the mask as a small grey picture (128 x 128, a PNG in
//! base64 text; white is near, black is far), so the mask is the same every time it is drawn and does not need the model again.

use image::{GrayImage, Luma, RgbImage};
use std::sync::{Arc, OnceLock};
use tract_onnx::prelude::*;

pub const MODEL: &[u8] = include_bytes!("../resources/depth-anything-v2-small-518.onnx");
const IN: usize = 518;

fn model() -> Result<&'static Arc<TypedRunnableModel>, String> {
    static CACHE: OnceLock<Result<Arc<TypedRunnableModel>, String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let load = || -> TractResult<Arc<TypedRunnableModel>> {
                let m = tract_onnx::onnx().model_for_read(&mut std::io::Cursor::new(MODEL))?;
                Ok(m.into_typed()?.into_optimized()?.into_runnable()?)
            };
            load().map_err(|e| format!("the depth model could not be loaded: {e}"))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// How near each spot of `img` is, as a KEPT x KEPT grey picture of the whole picture (squashed): white nearest, black farthest. The scale is
/// stretched so the picture uses the whole range.
pub fn find_depth(img: &RgbImage) -> Result<GrayImage, String> {
    if img.width() < 8 || img.height() < 8 {
        return Err("The picture is too small to measure.".into());
    }
    let small = image::imageops::resize(img, IN as u32, IN as u32, image::imageops::FilterType::Triangle);
    let (mean, std) = ([0.485f32, 0.456, 0.406], [0.229f32, 0.224, 0.225]);
    let mut data = vec![0f32; 3 * IN * IN];
    for (x, y, p) in small.enumerate_pixels() {
        let i = y as usize * IN + x as usize;
        for c in 0..3 {
            data[c * IN * IN + i] = (p[c] as f32 / 255.0 - mean[c]) / std[c];
        }
    }
    let input = Tensor::from_shape(&[1, 3, IN, IN], &data).map_err(|e| e.to_string())?;
    let out = model()?.run(tvec!(input.into())).map_err(|e| format!("measuring the distance stopped: {e}"))?;
    let view = out[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
    if view.len() != IN * IN {
        return Err(format!("the depth model gave an unexpected size ({} values)", view.len()));
    }
    let vals: Vec<f32> = view.iter().copied().collect();
    // ignore the extremes so one odd spot does not squash the scale
    let mut sorted = vals.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let (lo, hi) = (sorted[sorted.len() / 100], sorted[sorted.len() - 1 - sorted.len() / 100]);
    let span = (hi - lo).max(1e-6);
    let full = GrayImage::from_fn(IN as u32, IN as u32, |x, y| Luma([(((vals[y as usize * IN + x as usize] - lo) / span).clamp(0.0, 1.0) * 255.0).round() as u8]));
    Ok(image::imageops::resize(&full, crate::subject::KEPT, crate::subject::KEPT, image::imageops::FilterType::Triangle))
}

/// The map's value (0 far to 1 near) at the fractions (fx, fy) of the whole picture, blended between the four nearest spots.
pub fn sample(map: &GrayImage, fx: f32, fy: f32) -> f32 {
    let (w, h) = (map.width() as f32, map.height() as f32);
    let (x, y) = ((fx * w - 0.5).clamp(0.0, w - 1.0), (fy * h - 0.5).clamp(0.0, h - 1.0));
    let (x0, y0) = (x.floor(), y.floor());
    let (tx, ty) = (x - x0, y - y0);
    let at = |xx: f32, yy: f32| map.get_pixel((xx as u32).min(map.width() - 1), (yy as u32).min(map.height() - 1))[0] as f32 / 255.0;
    let top = at(x0, y0) * (1.0 - tx) + at(x0 + 1.0, y0) * tx;
    let bottom = at(x0, y0 + 1.0) * (1.0 - tx) + at(x0 + 1.0, y0 + 1.0) * tx;
    top * (1.0 - ty) + bottom * ty
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    #[test]
    fn a_picture_that_gets_more_distant_towards_the_top_is_measured_that_way() {
        // a floor that recedes: dark and plain far away at the top, bright and detailed near at the bottom
        let img = RgbImage::from_fn(400, 300, |x, y| {
            let near = y as f32 / 300.0;
            let tex = (((x / 6 + (y as f32 * (0.5 + near * 4.0)) as u32 / 6) % 2) as f32) * 60.0 * near;
            let v = (60.0 + 120.0 * near + tex).min(255.0) as u8;
            Rgb([v, v, (v as f32 * 0.9) as u8])
        });
        let map = find_depth(&img).unwrap();
        assert_eq!(map.dimensions(), (128, 128));
        let (top, bottom) = (sample(&map, 0.5, 0.1), sample(&map, 0.5, 0.9));
        assert!(bottom > top + 0.03, "the bottom is nearer: top {top:.2}, bottom {bottom:.2}");
        assert!(find_depth(&RgbImage::new(4, 4)).is_err());
    }
}
