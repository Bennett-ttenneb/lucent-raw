//! Colour management.
//!
//! Penumbra works in sRGB, 8 bits per channel. Two things follow from that:
//!
//! * A photo that carries its own profile (Adobe RGB, Display P3, ...) is converted to sRGB when it is read, so
//!   every preview, edit and export starts from correct colours. A photo with no profile, or with an sRGB one, is
//!   taken as it is. RAW files are taken as sRGB.
//! * An export can be converted to another space and is always tagged with its profile. The conversion starts
//!   from sRGB, so a larger space labels the colours correctly but cannot hold colours beyond sRGB.

use image::RgbImage;
use moxcms::{ColorProfile, DataColorSpace, Layout, RenderingIntent, TransformOptions};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Space {
    #[default]
    Srgb,
    DisplayP3,
    AdobeRgb,
    ProPhoto,
}

impl Space {
    /// From the name the page sends; anything unknown is sRGB.
    pub fn from_name(name: &str) -> Space {
        match name {
            "displayP3" => Space::DisplayP3,
            "adobeRgb" => Space::AdobeRgb,
            "proPhoto" => Space::ProPhoto,
            _ => Space::Srgb,
        }
    }

    pub fn profile(self) -> ColorProfile {
        match self {
            Space::Srgb => ColorProfile::new_srgb(),
            Space::DisplayP3 => ColorProfile::new_display_p3(),
            Space::AdobeRgb => ColorProfile::new_adobe_rgb(),
            Space::ProPhoto => ColorProfile::new_pro_photo_rgb(),
        }
    }
}

/// Do two RGB profiles have the same primaries? Used to recognise sRGB under whatever name a camera gave it.
fn same_primaries(a: &ColorProfile, b: &ColorProfile) -> bool {
    let close = |p: &moxcms::Xyzd, q: &moxcms::Xyzd| (p.x - q.x).abs() < 0.003 && (p.y - q.y).abs() < 0.003 && (p.z - q.z).abs() < 0.003;
    close(&a.red_colorant, &b.red_colorant) && close(&a.green_colorant, &b.green_colorant) && close(&a.blue_colorant, &b.blue_colorant)
}

fn convert(img: &RgbImage, from: &ColorProfile, to: &ColorProfile) -> Result<RgbImage, String> {
    let options = TransformOptions { rendering_intent: RenderingIntent::RelativeColorimetric, ..Default::default() };
    let t = from.create_transform_8bit(Layout::Rgb, to, Layout::Rgb, options).map_err(|e| e.to_string())?;
    let mut out = vec![0u8; img.as_raw().len()];
    t.transform(img.as_raw(), &mut out).map_err(|e| e.to_string())?;
    RgbImage::from_raw(img.width(), img.height(), out).ok_or_else(|| "colour conversion changed the size".to_string())
}

/// A photo's own colours in sRGB, if it carries a profile that is not sRGB. `None` means "leave it as it is": no profile,
/// an sRGB one, one that is not an RGB profile, or one that cannot be read.
pub fn embedded_to_srgb(img: &RgbImage, icc: &[u8]) -> Option<RgbImage> {
    let profile = ColorProfile::new_from_slice(icc).ok()?;
    if profile.color_space != DataColorSpace::Rgb {
        return None;
    }
    let srgb = ColorProfile::new_srgb();
    if same_primaries(&profile, &srgb) {
        return None;
    }
    convert(img, &profile, &srgb).ok()
}

/// The picture in `space`, and the profile to embed in the file. sRGB is tagged but its pixels are not touched.
pub fn for_export(img: &RgbImage, space: Space) -> Result<(RgbImage, Vec<u8>), String> {
    let target = space.profile();
    let icc = target.encode().map_err(|e| e.to_string())?;
    if space == Space::Srgb {
        return Ok((img.clone(), icc));
    }
    Ok((convert(img, &Space::Srgb.profile(), &target)?, icc))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn flat(rgb: [u8; 3]) -> RgbImage {
        ImageBuffer::from_pixel(4, 4, Rgb(rgb))
    }
    fn icc(space: Space) -> Vec<u8> {
        space.profile().encode().unwrap()
    }

    #[test]
    fn names_from_the_page_map_to_spaces_and_unknown_is_srgb() {
        assert_eq!(Space::from_name("displayP3"), Space::DisplayP3);
        assert_eq!(Space::from_name("adobeRgb"), Space::AdobeRgb);
        assert_eq!(Space::from_name("proPhoto"), Space::ProPhoto);
        assert_eq!(Space::from_name("srgb"), Space::Srgb);
        assert_eq!(Space::from_name("nonsense"), Space::Srgb);
    }

    #[test]
    fn every_space_makes_a_profile_that_reads_back_with_the_right_primaries() {
        for space in [Space::Srgb, Space::DisplayP3, Space::AdobeRgb, Space::ProPhoto] {
            let back = ColorProfile::new_from_slice(&icc(space)).unwrap();
            assert!(same_primaries(&back, &space.profile()), "{space:?}");
            assert_eq!(back.color_space, DataColorSpace::Rgb);
        }
        assert!(!same_primaries(&Space::AdobeRgb.profile(), &Space::Srgb.profile()), "the spaces are told apart");
        assert!(!same_primaries(&Space::DisplayP3.profile(), &Space::Srgb.profile()));
    }

    #[test]
    fn an_srgb_or_missing_or_broken_profile_leaves_the_picture_alone() {
        let img = flat([100, 160, 100]);
        assert!(embedded_to_srgb(&img, &icc(Space::Srgb)).is_none());
        assert!(embedded_to_srgb(&img, &[]).is_none());
        assert!(embedded_to_srgb(&img, b"not a profile at all").is_none());
    }

    #[test]
    fn a_wide_gamut_photo_gets_more_saturated_numbers_in_srgb_and_greys_stay_grey() {
        // the same numbers mean a less saturated colour in Adobe RGB than in sRGB, so converting makes them stronger
        let green = embedded_to_srgb(&flat([100, 160, 100]), &icc(Space::AdobeRgb)).unwrap().get_pixel(0, 0).0;
        assert!(green[1] as i32 - green[0] as i32 > 60, "greener than the 60 it was: {green:?}");
        let grey = embedded_to_srgb(&flat([128, 128, 128]), &icc(Space::AdobeRgb)).unwrap().get_pixel(0, 0).0;
        assert!(grey.iter().all(|c| c.abs_diff(grey[0]) <= 2), "still neutral: {grey:?}");
        let p3 = embedded_to_srgb(&flat([200, 80, 80]), &icc(Space::DisplayP3)).unwrap().get_pixel(0, 0).0;
        assert!(p3[0] as i32 - p3[1] as i32 > 120, "redder in sRGB numbers: {p3:?}");
    }

    #[test]
    fn export_in_srgb_keeps_the_pixels_and_other_spaces_change_the_numbers_not_the_look() {
        let img = flat([220, 40, 40]);
        let (same, _) = for_export(&img, Space::Srgb).unwrap();
        assert_eq!(same, img);
        let (p3, _) = for_export(&img, Space::DisplayP3).unwrap();
        let q = p3.get_pixel(0, 0).0;
        assert!(q[0] < 220 && q[1] > 40, "the same colour needs a less extreme triplet in P3: {q:?}");
        // and back again: the colour is the same colour
        let back = embedded_to_srgb(&p3, &icc(Space::DisplayP3)).unwrap().get_pixel(0, 0).0;
        for k in 0..3 {
            assert!(back[k].abs_diff(img.get_pixel(0, 0)[k]) <= 3, "round trip {back:?}");
        }
        let (grey, _) = for_export(&flat([90, 90, 90]), Space::ProPhoto).unwrap();
        let g = grey.get_pixel(0, 0).0;
        assert!(g.iter().all(|c| c.abs_diff(g[0]) <= 2), "grey stays grey: {g:?}");
    }

    #[test]
    fn an_empty_picture_does_not_crash() {
        let empty: RgbImage = ImageBuffer::new(0, 0);
        let _ = for_export(&empty, Space::AdobeRgb);
    }
}
