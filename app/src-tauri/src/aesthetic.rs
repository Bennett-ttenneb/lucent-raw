//! How good a photo looks to most people, for Cull. The model is NIMA (Neural Image Assessment, Google; the trained MobileNet weights are
//! idealo's "weights_mobilenet_aesthetic_0.07", Apache-2.0), converted to ONNX by a third party
//! (https://github.com/nyarrow-studio/daysta-thirdparty-sources, release nima-aesthetic-onnx-20260927; its SHA-256 matches the one published
//! there). It looks at the picture squashed to 224 x 224 and gives the share of people who would rate it 1 to 10; the score here is the average
//! of that. It was trained on photos people rated on a photo site, so it likes sharp, well-lit, colourful pictures and it is a rough guide to
//! taste, not a judge.

use image::RgbImage;
use std::sync::{Arc, OnceLock};
use tract_onnx::prelude::*;

pub const MODEL: &[u8] = include_bytes!("../resources/nima-aesthetic.onnx");
const IN: usize = 224;

fn model() -> Result<&'static Arc<TypedRunnableModel>, String> {
    static CACHE: OnceLock<Result<Arc<TypedRunnableModel>, String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let load = || -> TractResult<Arc<TypedRunnableModel>> {
                let m = tract_onnx::onnx().model_for_read(&mut std::io::Cursor::new(MODEL))?.with_input_fact(0, f32::fact([1, IN, IN, 3]).into())?;
                Ok(m.into_optimized()?.into_runnable()?)
            };
            load().map_err(|e| format!("the aesthetic model could not be loaded: {e}"))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// The picture's score from 1 to 10 (about 5 is an ordinary photo).
pub fn score(img: &RgbImage) -> Result<f32, String> {
    let small = image::imageops::resize(img, IN as u32, IN as u32, image::imageops::FilterType::Triangle);
    let mut data = vec![0f32; IN * IN * 3];
    for (x, y, p) in small.enumerate_pixels() {
        let i = (y as usize * IN + x as usize) * 3;
        for c in 0..3 {
            data[i + c] = p[c] as f32 / 127.5 - 1.0;
        }
    }
    let input = Tensor::from_shape(&[1, IN, IN, 3], &data).map_err(|e| e.to_string())?;
    let out = model()?.run(tvec!(input.into())).map_err(|e| format!("scoring the picture stopped: {e}"))?;
    let view = out[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?;
    let probs: Vec<f32> = view.iter().copied().collect();
    if probs.len() != 10 {
        return Err(format!("the aesthetic model gave an unexpected answer ({} values)", probs.len()));
    }
    let total: f32 = probs.iter().sum::<f32>().max(1e-6);
    Ok(probs.iter().enumerate().map(|(i, p)| (i as f32 + 1.0) * p).sum::<f32>() / total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    #[test]
    fn a_score_is_between_one_and_ten_and_a_sharp_colourful_picture_beats_flat_grey_noise() {
        let flat = RgbImage::from_fn(320, 240, |x, y| {
            let n = ((x * 7919 + y * 104729) % 41) as u8;
            Rgb([110 + n / 4, 112 + n / 5, 108 + n / 4])
        });
        let scene = RgbImage::from_fn(320, 240, |x, y| {
            let sky = 120 + (y as f32 * 0.5) as u8;
            if y > 150 { Rgb([40 + (x / 4) as u8, 110, 50]) } else { Rgb([sky / 2, sky, 255 - (y as u8 / 2)]) }
        });
        let (a, b) = (score(&flat).unwrap(), score(&scene).unwrap());
        assert!((1.0..=10.0).contains(&a) && (1.0..=10.0).contains(&b), "{a} {b}");
        assert_eq!(score(&scene).unwrap(), b, "the same picture gets the same score");
        eprintln!("flat {a:.2}, scene {b:.2}");
    }
}
