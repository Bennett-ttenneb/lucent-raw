//! Red-eye removal: inside a small circle, the strongly red pixels are turned to a dark neutral.
//!
//! The circle only says where to look. Pixels that are not strongly red (skin, the white of the eye, a
//! catchlight) are left alone, so the circle does not have to be exact. Positions are fractions of the
//! cropped picture. Everything is decided per pixel from its own colour and its distance from the centre, so
//! a window of the picture gets exactly what the same window of the whole would.

use image::RgbImage;
use serde::{Deserialize, Serialize};

use crate::develop::smoothstep;

pub const MAX_RED_EYES: usize = 20;

fn half() -> f32 {
    0.5
}
fn small() -> f32 {
    0.03
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedEye {
    pub id: String,
    /// Centre of the circle.
    pub x: f32,
    pub y: f32,
    /// Diameter, as a fraction of the picture's long edge.
    #[serde(default = "small")]
    pub size: f32,
    /// How much darker the corrected pupil is made, 0 to 1.
    #[serde(default = "half")]
    pub darken: f32,
}

impl RedEye {
    fn sanitized(&self) -> RedEye {
        let f = |v: f32, lo: f32, hi: f32, d: f32| if v.is_finite() { v.clamp(lo, hi) } else { d };
        RedEye { id: self.id.chars().take(64).collect(), x: f(self.x, -0.5, 1.5, 0.5), y: f(self.y, -0.5, 1.5, 0.5), size: f(self.size, 0.005, 0.2, 0.03), darken: f(self.darken, 0.0, 1.0, 0.5) }
    }
}

/// At most MAX_RED_EYES, unique non-empty ids, every value in range.
pub fn sanitize_red_eyes(eyes: &[RedEye]) -> Vec<RedEye> {
    let mut seen = std::collections::HashSet::new();
    eyes.iter().map(RedEye::sanitized).filter(|e| !e.id.is_empty() && seen.insert(e.id.clone())).take(MAX_RED_EYES).collect()
}

/// How red a pixel is, 0 (not at all) to 1 (a red pupil). Skin is around 0.3, a red pupil 0.7 and more.
fn redness(r: u8, g: u8, b: u8) -> f32 {
    let r = r as f32;
    smoothstep(0.45, 0.7, (r - (g.max(b)) as f32) / r.max(1.0))
}

/// Correct the red eyes in `window`, the part of the whole picture (fw by fh) that starts at (ox, oy).
pub fn apply_red_eyes_window(window: &mut RgbImage, ox: u32, oy: u32, fw: u32, fh: u32, eyes: &[RedEye]) {
    let (fwf, fhf) = (fw as f32, fh as f32);
    let long = fwf.max(fhf);
    let (ww, wh) = (window.width() as i64, window.height() as i64);
    for eye in eyes {
        let (cx, cy) = (eye.x * fwf, eye.y * fhf);
        let r = (eye.size * long / 2.0).max(1.0);
        let x0 = ((cx - r).floor() as i64).max(ox as i64);
        let x1 = ((cx + r).ceil() as i64).min(ox as i64 + ww - 1);
        let y0 = ((cy - r).floor() as i64).max(oy as i64);
        let y1 = ((cy + r).ceil() as i64).min(oy as i64 + wh - 1);
        for gy in y0..=y1 {
            for gx in x0..=x1 {
                let (dx, dy) = (gx as f32 + 0.5 - cx, gy as f32 + 0.5 - cy);
                let d = (dx * dx + dy * dy).sqrt();
                if d >= r {
                    continue;
                }
                let p = window.get_pixel_mut((gx - ox as i64) as u32, (gy - oy as i64) as u32);
                let w = (1.0 - smoothstep(0.65 * r, r, d)) * redness(p[0], p[1], p[2]);
                if w <= 0.0 {
                    continue;
                }
                let neutral = (p[1] as f32 + p[2] as f32) / 2.0;
                let red = p[0] as f32 + (neutral - p[0] as f32) * w;
                let k = 1.0 - w * eye.darken * 0.7;
                p[0] = (red * k + 0.5) as u8;
                p[1] = (p[1] as f32 * k + 0.5) as u8;
                p[2] = (p[2] as f32 * k + 0.5) as u8;
            }
        }
    }
}

pub fn any(eyes: &[RedEye]) -> bool {
    !eyes.is_empty()
}

/// Correct the red eyes of a whole picture.
pub fn apply_red_eyes(img: &RgbImage, eyes: &[RedEye]) -> RgbImage {
    let mut out = img.clone();
    apply_red_eyes_window(&mut out, 0, 0, img.width(), img.height(), eyes);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    const SKIN: [u8; 3] = [205, 150, 130];
    const PUPIL: [u8; 3] = [210, 50, 45];

    /// Skin with a red pupil of radius `pr` centred at (cx, cy).
    fn face(w: u32, h: u32, cx: f32, cy: f32, pr: f32) -> RgbImage {
        ImageBuffer::from_fn(w, h, |x, y| if ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)).sqrt() < pr { Rgb(PUPIL) } else { Rgb(SKIN) })
    }
    fn eye(x: f32, y: f32, size: f32, darken: f32) -> RedEye {
        RedEye { id: "e".into(), x, y, size, darken }
    }

    #[test]
    fn a_red_pupil_goes_dark_and_neutral() {
        let img = face(200, 200, 100.0, 100.0, 10.0);
        let out = apply_red_eyes(&img, &[eye(0.5, 0.5, 0.15, 0.5)]);
        let p = out.get_pixel(100, 100).0;
        assert!(p[0] as i32 - p[1].max(p[2]) as i32 <= 8, "no longer red: {p:?}");
        assert!(p[0] < 120, "darker than the red it was: {p:?}");
    }

    #[test]
    fn skin_inside_the_circle_and_everything_outside_are_left_alone() {
        let img = face(200, 200, 100.0, 100.0, 10.0);
        let out = apply_red_eyes(&img, &[eye(0.5, 0.5, 0.3, 1.0)]); // a circle much bigger than the pupil: radius 30
        assert_eq!(out.get_pixel(100, 125).0, SKIN, "skin within the circle");
        assert_eq!(out.get_pixel(5, 5).0, SKIN, "far outside");
        // a red pupil outside the circle is not touched
        let other = face(200, 200, 40.0, 40.0, 10.0);
        assert_eq!(apply_red_eyes(&other, &[eye(0.75, 0.75, 0.1, 1.0)]), other);
    }

    #[test]
    fn more_darken_means_a_darker_pupil_and_none_only_removes_the_red() {
        let img = face(200, 200, 100.0, 100.0, 10.0);
        let at = |d: f32| apply_red_eyes(&img, &[eye(0.5, 0.5, 0.15, d)]).get_pixel(100, 100).0[1];
        assert!(at(1.0) < at(0.5) && at(0.5) < at(0.0));
        let flat = apply_red_eyes(&img, &[eye(0.5, 0.5, 0.15, 0.0)]).get_pixel(100, 100).0;
        assert!(flat[0].abs_diff(flat[1]) <= 6, "red gone even at 0: {flat:?}");
    }

    #[test]
    fn a_window_matches_the_same_part_of_the_whole() {
        let img = face(300, 200, 150.0, 90.0, 12.0);
        let eyes = [eye(0.5, 0.45, 0.1, 0.6)];
        let whole = apply_red_eyes(&img, &eyes);
        let (x, y, w, h) = (120u32, 70u32, 60u32, 40u32);
        let mut win = image::imageops::crop_imm(&img, x, y, w, h).to_image();
        apply_red_eyes_window(&mut win, x, y, 300, 200, &eyes);
        assert_eq!(win, image::imageops::crop_imm(&whole, x, y, w, h).to_image());
    }

    #[test]
    fn a_circle_at_the_edge_does_not_go_outside_the_picture() {
        let img = face(100, 100, 2.0, 2.0, 6.0);
        let out = apply_red_eyes(&img, &[eye(0.0, 0.0, 0.2, 0.5), eye(1.4, -0.4, 0.2, 0.5)]);
        assert_eq!((out.width(), out.height()), (100, 100));
        assert!(out.get_pixel(2, 2)[0] < 150);
    }

    #[test]
    fn bad_values_are_clamped_duplicates_and_extras_dropped_and_old_json_loads() {
        let bad = RedEye { id: "a".into(), x: f32::NAN, y: 9.0, size: 5.0, darken: -3.0 };
        let s = sanitize_red_eyes(&[bad.clone(), bad.clone(), RedEye { id: "".into(), ..bad.clone() }]);
        assert_eq!(s.len(), 1, "duplicate id and empty id dropped");
        assert_eq!((s[0].x, s[0].y, s[0].size, s[0].darken), (0.5, 1.5, 0.2, 0.0));
        let many: Vec<RedEye> = (0..40).map(|i| RedEye { id: format!("e{i}"), ..bad.clone() }).collect();
        assert_eq!(sanitize_red_eyes(&many).len(), MAX_RED_EYES);
        let e: RedEye = serde_json::from_str(r#"{"id":"x","x":0.2,"y":0.3}"#).unwrap();
        assert_eq!((e.size, e.darken), (0.03, 0.5));
    }
}
