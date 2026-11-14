//! Finding the main subject of a picture, for the Subject and Background masks.
//!
//! The model is U2-Net (the small "u2netp" one, Apache-2.0), built into the program and run by tract. It looks at the picture
//! squashed to 320 x 320 and says, for every spot, how much it belongs to the main thing in the picture. That answer is kept
//! in the mask as a small grey picture (128 x 128, as a PNG in base64 text), so the mask is the same every time it is drawn,
//! at any size, and does not need the model again.

use base64::Engine;
use image::{GrayImage, Luma, RgbImage};
use std::sync::{Arc, OnceLock};
use tract_onnx::prelude::*;

pub const MODEL: &[u8] = include_bytes!("../resources/u2netp.onnx");

const IN: usize = 320;
/// The side of the grey picture that is kept in the mask.
pub const KEPT: u32 = 128;
/// The longest the kept text may be, so a damaged or hostile recipe cannot make a render slow.
pub const MAX_TEXT: usize = 120_000;

type Model = TypedRunnableModel;

fn model() -> Result<&'static Arc<Model>, String> {
    static CACHE: OnceLock<Result<Arc<Model>, String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let load = || -> TractResult<Arc<Model>> {
                let m = tract_onnx::onnx().model_for_read(&mut std::io::Cursor::new(MODEL))?.with_input_fact(0, f32::fact([1, 3, IN, IN]).into())?;
                Ok(m.into_optimized()?.into_runnable()?)
            };
            load().map_err(|e| format!("the subject model could not be loaded: {e}"))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// How much each spot of `img` belongs to its main subject, as a KEPT x KEPT grey picture of the whole picture (squashed).
pub fn find_subject(img: &RgbImage) -> Result<GrayImage, String> {
    if img.width() < 8 || img.height() < 8 {
        return Err("The picture is too small to find a subject in.".into());
    }
    let small = image::imageops::resize(img, IN as u32, IN as u32, image::imageops::FilterType::Triangle);
    // the same preparation as the model was trained with: 0 to 1, then each colour taken from its average and spread
    let (mean, std) = ([0.485f32, 0.456, 0.406], [0.229f32, 0.224, 0.225]);
    let mut data = vec![0f32; 3 * IN * IN];
    for (x, y, p) in small.enumerate_pixels() {
        let i = y as usize * IN + x as usize;
        for c in 0..3 {
            data[c * IN * IN + i] = (p[c] as f32 / 255.0 - mean[c]) / std[c];
        }
    }
    let input = Tensor::from_shape(&[1, 3, IN, IN], &data).map_err(|e| e.to_string())?;
    let out = model()?.run(tvec!(input.into())).map_err(|e| format!("finding the subject stopped: {e}"))?;
    // the first output is the finished map; the others are its rougher stages
    let view = out[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
    if view.len() != IN * IN {
        return Err(format!("the subject model gave an unexpected size ({} values)", view.len()));
    }
    let vals: Vec<f32> = view.iter().copied().collect();
    let (lo, hi) = vals.iter().fold((f32::MAX, f32::MIN), |(a, b), v| (a.min(*v), b.max(*v)));
    let span = (hi - lo).max(1e-6);
    let full = GrayImage::from_fn(IN as u32, IN as u32, |x, y| Luma([(((vals[y as usize * IN + x as usize] - lo) / span).clamp(0.0, 1.0) * 255.0).round() as u8]));
    Ok(image::imageops::resize(&full, KEPT, KEPT, image::imageops::FilterType::Triangle))
}

/// The grey picture as text to keep in a mask.
pub fn encode(map: &GrayImage) -> Result<String, String> {
    let mut bytes = Vec::new();
    map.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// The grey picture back from its text, or nothing if the text is not a small grey picture.
pub fn decode(text: &str) -> Option<GrayImage> {
    if text.is_empty() || text.len() > MAX_TEXT {
        return None;
    }
    let bytes = base64::engine::general_purpose::STANDARD.decode(text.as_bytes()).ok()?;
    let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).ok()?;
    let g = img.to_luma8();
    (g.width() >= 2 && g.height() >= 2 && g.width() <= 512 && g.height() <= 512).then_some(g)
}

/// The map's value (0 to 1) at the fractions (fx, fy) of the whole picture, blended between the four nearest spots, and
/// sharpened a little: the model's edges are soft.
pub fn sample(map: &GrayImage, fx: f32, fy: f32) -> f32 {
    let (w, h) = (map.width() as f32, map.height() as f32);
    let (x, y) = ((fx * w - 0.5).clamp(0.0, w - 1.0), (fy * h - 0.5).clamp(0.0, h - 1.0));
    let (x0, y0) = (x.floor(), y.floor());
    let (tx, ty) = (x - x0, y - y0);
    let at = |xx: f32, yy: f32| map.get_pixel((xx as u32).min(map.width() - 1), (yy as u32).min(map.height() - 1))[0] as f32 / 255.0;
    let top = at(x0, y0) * (1.0 - tx) + at(x0 + 1.0, y0) * tx;
    let bottom = at(x0, y0 + 1.0) * (1.0 - tx) + at(x0 + 1.0, y0 + 1.0) * tx;
    let v = top * (1.0 - ty) + bottom * ty;
    crate::develop::smoothstep(0.25, 0.75, v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    #[test]
    fn the_map_survives_being_kept_as_text_and_bad_text_is_refused() {
        let map = GrayImage::from_fn(KEPT, KEPT, |x, y| Luma([((x + y) % 256) as u8]));
        let text = encode(&map).unwrap();
        assert!(text.len() < MAX_TEXT, "a map is {} characters", text.len());
        assert_eq!(decode(&text).unwrap(), map);
        for bad in ["", "not base64 !!", "aGVsbG8=", &"A".repeat(MAX_TEXT + 1)] {
            assert!(decode(bad).is_none(), "{bad:.20}");
        }
        // a real picture that is the wrong kind (too big) is refused too
        let big = encode(&GrayImage::new(600, 600)).unwrap();
        assert!(decode(&big).is_none());
    }

    #[test]
    fn sampling_follows_the_picture_blends_and_stays_inside_it() {
        // left half white, right half black
        let map = GrayImage::from_fn(KEPT, KEPT, |x, _| Luma([if x < KEPT / 2 { 255 } else { 0 }]));
        assert_eq!(sample(&map, 0.1, 0.5), 1.0);
        assert_eq!(sample(&map, 0.9, 0.5), 0.0);
        let mid = sample(&map, 0.5, 0.5);
        assert!(mid > 0.0 && mid < 1.0, "{mid}: the edge is blended");
        // outside the picture takes the nearest edge, and never goes out of 0..1
        for (fx, fy) in [(-0.5, -0.5), (1.5, 1.5), (0.0, 0.0), (1.0, 1.0)] {
            let v = sample(&map, fx, fy);
            assert!((0.0..=1.0).contains(&v), "{v}");
        }
    }

    #[test]
    fn the_model_loads_and_gives_a_full_range_map_of_the_right_size() {
        // a bright red disc on a dull grey background: the clearest "subject" a test can make
        let img = RgbImage::from_fn(320, 240, |x, y| {
            let (dx, dy) = (x as f32 - 160.0, y as f32 - 120.0);
            if (dx * dx + dy * dy).sqrt() < 70.0 {
                Rgb([230, 40, 40])
            } else {
                Rgb([110, 115, 120])
            }
        });
        let map = find_subject(&img).unwrap();
        assert_eq!(map.dimensions(), (KEPT, KEPT));
        let centre = sample(&map, 0.5, 0.5);
        let corner = (sample(&map, 0.04, 0.04) + sample(&map, 0.96, 0.04) + sample(&map, 0.04, 0.96) + sample(&map, 0.96, 0.96)) / 4.0;
        assert!(centre > corner + 0.3, "the disc ({centre}) is not picked out from the background ({corner})");
        // the same picture gives the same map
        assert_eq!(find_subject(&img).unwrap(), map);
        assert!(find_subject(&RgbImage::new(4, 4)).is_err());
    }
}
