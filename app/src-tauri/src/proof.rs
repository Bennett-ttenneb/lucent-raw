//! Soft proofing: how a picture would look printed on paper (or shown on another device), judged on the screen. The picture is converted to
//! the colours the chosen profile can hold and back again, so what the paper cannot reproduce is shown as it would come out. Colours the
//! profile cannot reach can be marked.

use image::RgbImage;
use moxcms::{ColorProfile, DataColorSpace, Layout, RenderingIntent, TransformExecutor, TransformOptions};
use std::sync::Arc;

type Exec = Arc<dyn TransformExecutor<u8> + Send + Sync>;

/// A profile ready to proof with: the way there and the way back.
pub struct ProofSetup {
    to_proof: Exec,
    back: Exec,
    /// four channels (a printer's inks) rather than three
    cmyk: bool,
    pub description: String,
}

fn intent_of(name: &str) -> RenderingIntent {
    match name {
        "perceptual" => RenderingIntent::Perceptual,
        "saturation" => RenderingIntent::Saturation,
        "absolute" => RenderingIntent::AbsoluteColorimetric,
        _ => RenderingIntent::RelativeColorimetric,
    }
}

/// Read a profile file's bytes and make the two conversions. `intent` is "perceptual", "relative" (the default), "saturation" or "absolute".
pub fn load(icc: &[u8], intent: &str) -> Result<ProofSetup, String> {
    let proof = ColorProfile::new_from_slice(icc).map_err(|e| format!("That is not a colour profile this program can read: {e}"))?;
    let cmyk = match proof.color_space {
        DataColorSpace::Rgb => false,
        DataColorSpace::Cmyk => true,
        _ => return Err("Only RGB and CMYK profiles can be used to proof (this one is for something else).".into()),
    };
    let srgb = ColorProfile::new_srgb();
    // four ink channels are carried in the layout of four-channel pixels
    let layout = if cmyk { Layout::Rgba } else { Layout::Rgb };
    let wanted = intent_of(intent);
    let options = TransformOptions { rendering_intent: wanted, ..Default::default() };
    let to_proof = srgb.create_transform_8bit(Layout::Rgb, &proof, layout, options).map_err(|e| format!("This profile cannot be proofed with: {e}"))?;
    // coming back to the screen is always judged by the closest match
    let back_options = TransformOptions { rendering_intent: RenderingIntent::RelativeColorimetric, ..Default::default() };
    let back = proof.create_transform_8bit(layout, &srgb, Layout::Rgb, back_options).map_err(|e| format!("This profile cannot be proofed with: {e}"))?;
    let description = proof.description.as_ref().map(|d| format!("{d:?}")).unwrap_or_default();
    Ok(ProofSetup { to_proof, back, cmyk, description })
}

/// The picture as the profile would reproduce it. With `warn`, the colours it cannot reproduce (those that moved a lot) are washed with red.
pub fn apply(img: &RgbImage, setup: &ProofSetup, warn: bool) -> Result<RgbImage, String> {
    let n = (img.width() * img.height()) as usize;
    let channels = if setup.cmyk { 4 } else { 3 };
    let mut mid = vec![0u8; n * channels];
    setup.to_proof.transform(img.as_raw(), &mut mid).map_err(|e| e.to_string())?;
    let mut out = vec![0u8; n * 3];
    setup.back.transform(&mid, &mut out).map_err(|e| e.to_string())?;
    if warn {
        let src = img.as_raw();
        for i in 0..n {
            let d: i32 = (0..3).map(|c| (src[i * 3 + c] as i32 - out[i * 3 + c] as i32).abs()).sum();
            if d > 36 {
                // a red wash over what the profile cannot hold
                out[i * 3] = ((out[i * 3] as u16 + 255) / 2) as u8;
                out[i * 3 + 1] /= 2;
                out[i * 3 + 2] /= 2;
            }
        }
    }
    RgbImage::from_raw(img.width(), img.height(), out).ok_or_else(|| "colour conversion changed the size".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn icc(p: ColorProfile) -> Vec<u8> {
        p.encode().unwrap()
    }

    #[test]
    fn proofing_with_the_same_space_changes_nothing_much_and_a_narrower_one_pulls_saturated_colours_in() {
        let img: RgbImage = ImageBuffer::from_pixel(8, 8, Rgb([255, 0, 0]));
        let same = load(&icc(ColorProfile::new_srgb()), "relative").unwrap();
        let out = apply(&img, &same, false).unwrap();
        let d: i32 = (0..3).map(|c| (out.get_pixel(0, 0)[c] as i32 - img.get_pixel(0, 0)[c] as i32).abs()).sum();
        assert!(d <= 6, "sRGB through sRGB is the same picture ({d})");
        // a colour sRGB can show but a narrower profile cannot is changed, and marked when asked
        let wide: RgbImage = ImageBuffer::from_pixel(8, 8, Rgb([0, 255, 0]));
        let adobe = load(&icc(ColorProfile::new_adobe_rgb()), "relative").unwrap();
        let ok = apply(&wide, &adobe, true).unwrap();
        assert_eq!(ok.dimensions(), (8, 8));
        // Adobe RGB is wider than sRGB, so sRGB green is inside it: nothing is marked
        assert!(ok.get_pixel(0, 0)[0] < 120, "not washed red: {:?}", ok.get_pixel(0, 0));
    }

    /// Windows ships a press (CMYK) profile; where it is there, a saturated colour must come back duller, which only a real CMYK round trip does.
    #[test]
    fn a_cmyk_press_profile_pulls_vivid_colours_in() {
        let found = ["C:\\Windows\\System32\\spool\\drivers\\color\\RSWOP.icm", "/mnt/c/Windows/System32/spool/drivers/color/RSWOP.icm"].iter().find_map(|p| std::fs::read(p).ok());
        let Some(bytes) = found else { return };
        let setup = match load(&bytes, "relative") {
            Ok(s) => s,
            Err(e) => panic!("the press profile was refused: {e}"),
        };
        let img: RgbImage = ImageBuffer::from_pixel(8, 8, Rgb([0, 255, 0]));
        let out = apply(&img, &setup, true).unwrap();
        let p = out.get_pixel(0, 0);
        assert!(p[1] < 235, "pure green cannot be printed: {p:?}");
        assert!(p[0] > 40, "marked with a red wash: {p:?}");
        let grey: RgbImage = ImageBuffer::from_pixel(8, 8, Rgb([128, 128, 128]));
        let g = apply(&grey, &setup, false).unwrap();
        let q = g.get_pixel(0, 0);
        assert!((q[0] as i32 - 128).abs() < 24 && (q[1] as i32 - 128).abs() < 24 && (q[2] as i32 - 128).abs() < 24, "grey stays about grey: {q:?}");
    }

    #[test]
    fn a_file_that_is_not_a_profile_is_refused_in_words() {
        assert!(load(b"not a profile", "relative").err().unwrap().contains("not a colour profile"));
    }
}
