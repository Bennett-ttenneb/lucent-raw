//! Face detection with YuNet (OpenCV Zoo, MIT licence, `face_detection_yunet_2023mar.onnx`), run on this machine by `tract`.
//! The model is part of the program; nothing is downloaded or sent anywhere when it runs.
//!
//! The model takes a fixed 640 x 640 picture and finds faces of about 10 px and up. A group photo has small faces,
//! so the picture is scanned in overlapping 640 px tiles at its own size, plus once as a whole (shrunk to fit) for
//! the big faces a tile would cut. The detections are merged. Each face comes with five landmarks (the eyes, the
//! nose, the corners of the mouth), which place the regions of the portrait retouch.
//!
//! Three more passes find what the plain scan misses. The picture is also searched turned by 90, 180 and 270 degrees
//! (a head tipped over, a camera held on its side, a person lying down), and once with a border added all round (a face
//! cut by the edge of the frame). The way a face is turned (tilted, looking left or right, nodding) is worked out
//! from its landmarks.

use std::sync::{Arc, OnceLock};

use image::RgbImage;
use tract_onnx::prelude::*;

use crate::portrait::{Ellipse, Portrait};

pub const MODEL: &[u8] = include_bytes!("../resources/face_detection_yunet_2023mar.onnx");

const SIDE: usize = 640;
const STRIDES: [usize; 3] = [8, 16, 32];
/// How far apart the tiles start, so neighbours overlap by 160 px and a face of up to that size is whole in one of them.
const TILE_STEP: u32 = 480;
/// A face this sure is kept.
pub const MIN_SCORE: f32 = 0.7;
/// The model is asked for anything from here up, so that a picture with no sure face can still offer its best guess.
const FLOOR_SCORE: f32 = 0.45;
/// With no sure face, the single best guess is offered if it is at least this likely.
const GUESS_SCORE: f32 = 0.55;
/// Faces narrower than this share of the picture's long edge are left out: too small to retouch, and often a face in a
/// poster or a printed photo.
const MIN_FACE_SHARE: f32 = 0.011;
/// A face at the edge of the picture, cut by it, is kept at this score.
const CUT_SCORE: f32 = 0.5;
const NMS_IOU: f32 = 0.3;
pub const MAX_FACES: usize = 40;

/// A detected face in pixels of the picture it was found in.
#[derive(Debug, Clone, PartialEq)]
pub struct Face {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub score: f32,
    /// Right eye, left eye (as the model names them), nose tip, right and left mouth corners.
    pub landmarks: [[f32; 2]; 5],
}

type Model = TypedRunnableModel;

fn model() -> Result<&'static Arc<Model>, String> {
    static MODEL_CACHE: OnceLock<Result<Arc<Model>, String>> = OnceLock::new();
    MODEL_CACHE
        .get_or_init(|| {
            let load = || -> TractResult<Arc<Model>> { Ok(tract_onnx::onnx().model_for_read(&mut std::io::Cursor::new(MODEL))?.into_optimized()?.into_runnable()?) };
            load().map_err(|e| format!("the face model could not be loaded: {e}"))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// Where tiles of `tile` pixels start along a side of `len` pixels: every `step`, the last one flush with the end.
pub fn tile_origins(len: u32, tile: u32, step: u32) -> Vec<u32> {
    if len <= tile {
        return vec![0];
    }
    let mut out = Vec::new();
    let mut x = 0;
    loop {
        out.push(x);
        if x + tile >= len {
            return out;
        }
        x = (x + step).min(len - tile);
    }
}

/// The model's input for the part of `img` that starts at (x0, y0) and is `w` x `h` pixels, drawn at `scale`, in the
/// top left corner of a black 640 x 640 square. BGR, 0 to 255, channels first.
fn blob(img: &RgbImage, x0: u32, y0: u32, w: u32, h: u32, scale: f32) -> Tensor {
    let part = image::imageops::crop_imm(img, x0, y0, w.min(img.width() - x0), h.min(img.height() - y0)).to_image();
    let (sw, sh) = (((part.width() as f32 * scale).round() as u32).clamp(1, SIDE as u32), ((part.height() as f32 * scale).round() as u32).clamp(1, SIDE as u32));
    let shown = if (scale - 1.0).abs() < 1e-3 { part } else { image::imageops::resize(&part, sw, sh, image::imageops::FilterType::Triangle) };
    let mut data = vec![0f32; 3 * SIDE * SIDE];
    for (x, y, p) in shown.enumerate_pixels() {
        if (x as usize) < SIDE && (y as usize) < SIDE {
            let i = y as usize * SIDE + x as usize;
            data[i] = p[2] as f32; // blue
            data[SIDE * SIDE + i] = p[1] as f32; // green
            data[2 * SIDE * SIDE + i] = p[0] as f32; // red
        }
    }
    Tensor::from_shape(&[1, 3, SIDE, SIDE], &data).expect("shape matches data")
}

/// Turn the model's twelve outputs (class, objectness, box and landmarks, each for strides 8, 16 and 32) into faces
/// in the 640 x 640 square, keeping scores of `min_score` and up.
pub fn decode(outputs: &[Vec<f32>], min_score: f32) -> Vec<Face> {
    let mut faces = Vec::new();
    if outputs.len() < 12 {
        return faces;
    }
    for (i, stride) in STRIDES.iter().enumerate() {
        let cols = SIDE / stride;
        let (cls, obj, bbox, kps) = (&outputs[i], &outputs[i + 3], &outputs[i + 6], &outputs[i + 9]);
        for idx in 0..cols * cols {
            if idx >= cls.len() || idx >= obj.len() || idx * 4 + 3 >= bbox.len() || idx * 10 + 9 >= kps.len() {
                break;
            }
            let score = (cls[idx].clamp(0.0, 1.0) * obj[idx].clamp(0.0, 1.0)).sqrt();
            if score < min_score {
                continue;
            }
            let (r, c) = ((idx / cols) as f32, (idx % cols) as f32);
            let s = *stride as f32;
            let b = &bbox[idx * 4..idx * 4 + 4];
            let (cx, cy, w, h) = ((c + b[0]) * s, (r + b[1]) * s, b[2].exp() * s, b[3].exp() * s);
            let mut landmarks = [[0f32; 2]; 5];
            for (n, lm) in landmarks.iter_mut().enumerate() {
                *lm = [(kps[idx * 10 + 2 * n] + c) * s, (kps[idx * 10 + 2 * n + 1] + r) * s];
            }
            faces.push(Face { x: cx - w / 2.0, y: cy - h / 2.0, w, h, score, landmarks });
        }
    }
    faces
}

fn iou(a: &Face, b: &Face) -> (f32, f32) {
    let (ix, iy) = ((a.x + a.w).min(b.x + b.w) - a.x.max(b.x), (a.y + a.h).min(b.y + b.h) - a.y.max(b.y));
    if ix <= 0.0 || iy <= 0.0 {
        return (0.0, 0.0);
    }
    let inter = ix * iy;
    // intersection over union, and over the smaller box (a small box inside a big one is the same face)
    (inter / (a.w * a.h + b.w * b.h - inter), inter / (a.w * a.h).min(b.w * b.h))
}

/// Keep the best of every group of overlapping boxes.
pub fn merge(mut faces: Vec<Face>) -> Vec<Face> {
    faces.sort_by(|a, b| b.score.total_cmp(&a.score));
    let mut kept: Vec<Face> = Vec::new();
    for f in faces {
        if kept.iter().all(|k| {
            let (u, m) = iou(k, &f);
            u < NMS_IOU && m < 0.7
        }) {
            kept.push(f);
        }
    }
    kept
}

fn run(model: &Arc<Model>, input: Tensor) -> Result<Vec<Vec<f32>>, String> {
    let out = model.run(tvec!(input.into())).map_err(|e| e.to_string())?;
    out.iter().map(|t| t.to_plain_array_view::<f32>().map(|a| a.iter().copied().collect()).map_err(|e| e.to_string())).collect()
}

/// One piece of the search: the whole picture shrunk to fit, or a tile of it at its own size.
#[derive(Clone, Copy)]
enum Job {
    Whole,
    Tile(u32, u32),
    /// The whole picture with a border of a quarter of its long edge added all round, edge pixels repeated.
    Padded,
    /// The whole picture turned clockwise by this many quarter turns (1 to 3).
    Turned(u8),
}

/// A point of the turned picture (`k` quarter turns clockwise) back in the original, which is `w` x `h`.
fn unturn(k: u8, p: [f32; 2], w: f32, h: f32) -> [f32; 2] {
    match k {
        1 => [p[1], h - p[0]],
        2 => [w - p[0], h - p[1]],
        _ => [w - p[1], p[0]],
    }
}

/// Faces found in a picture that was changed to `seen`, put back: `map` takes a point of that picture to the original.
fn put_back(faces: Vec<Face>, map: &dyn Fn([f32; 2]) -> [f32; 2]) -> Vec<Face> {
    faces
        .into_iter()
        .map(|f| {
            let corners = [map([f.x, f.y]), map([f.x + f.w, f.y]), map([f.x, f.y + f.h]), map([f.x + f.w, f.y + f.h])];
            let (x0, x1) = corners.iter().fold((f32::MAX, f32::MIN), |a, c| (a.0.min(c[0]), a.1.max(c[0])));
            let (y0, y1) = corners.iter().fold((f32::MAX, f32::MIN), |a, c| (a.0.min(c[1]), a.1.max(c[1])));
            let mut landmarks = f.landmarks;
            landmarks.iter_mut().for_each(|l| *l = map(*l));
            Face { x: x0, y: y0, w: x1 - x0, h: y1 - y0, score: f.score, landmarks }
        })
        .collect()
}

/// Faces found only on a turned or padded copy must be surer than ones found on the plain picture.
const EXTRA_PASS_FLOOR: f32 = 0.8;

fn search(model: &Arc<Model>, img: &RgbImage, job: Job, floor: f32) -> Result<Vec<Face>, String> {
    let (w, h) = (img.width(), img.height());
    match job {
        // finds faces too big for a tile
        Job::Whole => {
            let scale = SIDE as f32 / w.max(h) as f32;
            let mut faces = decode(&run(model, blob(img, 0, 0, w, h, scale))?, floor);
            for f in &mut faces {
                (f.x, f.y, f.w, f.h) = (f.x / scale, f.y / scale, f.w / scale, f.h / scale);
                f.landmarks.iter_mut().for_each(|l| *l = [l[0] / scale, l[1] / scale]);
            }
            Ok(faces)
        }
        Job::Padded => {
            let pad = w.max(h) / 4;
            let mut big = RgbImage::new(w + 2 * pad, h + 2 * pad);
            for (x, y, p) in big.enumerate_pixels_mut() {
                *p = *img.get_pixel(x.saturating_sub(pad).min(w - 1), y.saturating_sub(pad).min(h - 1));
            }
            let found = search(model, &big, Job::Whole, floor.max(EXTRA_PASS_FLOOR))?;
            let p = pad as f32;
            Ok(put_back(found, &|q| [q[0] - p, q[1] - p]))
        }
        Job::Turned(k) => {
            let turned = match k {
                1 => image::imageops::rotate90(img),
                2 => image::imageops::rotate180(img),
                _ => image::imageops::rotate270(img),
            };
            let found = search(model, &turned, Job::Whole, floor.max(EXTRA_PASS_FLOOR))?;
            let (fw, fh) = (w as f32, h as f32);
            Ok(put_back(found, &|q| unturn(k, q, fw, fh)))
        }
        // finds the small faces of a group
        Job::Tile(tx, ty) => {
            let tile = SIDE as u32;
            let mut faces = decode(&run(model, blob(img, tx, ty, tile, tile, 1.0))?, floor);
            // a face cut by the edge of a tile (not the edge of the picture) is found whole in the next tile
            faces.retain(|f| !((f.x < 2.0 && tx > 0) || (f.y < 2.0 && ty > 0) || (f.x + f.w > tile as f32 - 2.0 && tx + tile < w) || (f.y + f.h > tile as f32 - 2.0 && ty + tile < h)));
            for f in &mut faces {
                (f.x, f.y) = (f.x + tx as f32, f.y + ty as f32);
                f.landmarks.iter_mut().for_each(|l| *l = [l[0] + tx as f32, l[1] + ty as f32]);
            }
            Ok(faces)
        }
    }
}

/// Every candidate of `floor` score and up, merged, best first, in pixels of `img`. The pieces of the search run
/// side by side on all cores.
pub fn candidates(img: &RgbImage, floor: f32) -> Result<Vec<Face>, String> {
    let model = model()?;
    let (w, h) = (img.width(), img.height());
    if w < 16 || h < 16 {
        return Ok(Vec::new());
    }
    let mut jobs = vec![Job::Whole, Job::Padded, Job::Turned(1), Job::Turned(2), Job::Turned(3)];
    if w.max(h) > SIDE as u32 * 13 / 10 {
        let tile = SIDE as u32;
        for ty in tile_origins(h, tile, TILE_STEP) {
            for tx in tile_origins(w, tile, TILE_STEP) {
                jobs.push(Job::Tile(tx, ty));
            }
        }
    }
    let threads = crate::perf::threads(false).min(jobs.len());
    let found: Result<Vec<Vec<Face>>, String> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..threads)
            .map(|t| {
                let jobs = &jobs;
                s.spawn(move || -> Result<Vec<Face>, String> {
                    let mut mine = Vec::new();
                    for job in jobs.iter().skip(t).step_by(threads) {
                        mine.extend(search(model, img, *job, floor)?);
                    }
                    Ok(mine)
                })
            })
            .collect();
        handles.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("face search stopped".to_string()))).collect()
    });
    Ok(merge(found?.into_iter().flatten().filter(|f| f.w >= 8.0 && f.h >= 8.0).collect()))
}

/// The faces to offer for `img`, best first, in pixels of `img`: every sure one that is big enough to matter, or, when
/// none is sure, the single best guess.
pub fn detect(img: &RgbImage) -> Result<Vec<Face>, String> {
    let min_width = (MIN_FACE_SHARE * img.width().max(img.height()) as f32).max(8.0);
    let mut all = candidates(img, FLOOR_SCORE)?;
    all.retain(|f| f.w >= min_width);
    // a face cut by the frame is only partly there, so a lower score is enough for it
    let (iw, ih) = (img.width() as f32, img.height() as f32);
    let cut = |f: &Face| f.x < 2.0 || f.y < 2.0 || f.x + f.w > iw - 2.0 || f.y + f.h > ih - 2.0;
    let mut sure: Vec<Face> = all.iter().filter(|f| f.score >= MIN_SCORE || (cut(f) && f.score >= CUT_SCORE)).cloned().collect();
    if sure.is_empty() {
        sure = all.into_iter().filter(|f| f.score >= GUESS_SCORE).take(1).collect();
    }
    sure.truncate(MAX_FACES);
    Ok(sure)
}

/// How a face is turned, from its landmarks, in degrees: `roll` is how far it is tipped clockwise from upright (180 is upside
/// down), `yaw` how far it looks towards the right of the picture (negative: the left), `pitch` how far it nods down
/// (negative: looks up). A guide worked out from where the nose sits between the eyes and the mouth, not a measurement.
pub fn orientation(lm: &[[f32; 2]; 5]) -> (f32, f32, f32) {
    let [re, le, nose, _, _] = *lm;
    let a = [le[0] - re[0], le[1] - re[1]];
    let between = (a[0] * a[0] + a[1] * a[1]).sqrt().max(1.0);
    let (u, v) = ([a[0] / between, a[1] / between], [-a[1] / between, a[0] / between]);
    let mid = [(re[0] + le[0]) / 2.0, (re[1] + le[1]) / 2.0];
    let n = [nose[0] - mid[0], nose[1] - mid[1]];
    let (x_off, y_off) = ((n[0] * u[0] + n[1] * u[1]) / between, (n[0] * v[0] + n[1] * v[1]) / between);
    let roll = a[1].atan2(a[0]).to_degrees();
    let yaw = (x_off / 0.5).clamp(-1.0, 1.0) * 70.0;
    let pitch = ((y_off - 0.6) / 0.25 * 25.0).clamp(-45.0, 45.0);
    let (roll, yaw, pitch) = (if roll.abs() < 3.0 { 0.0 } else { roll }, if yaw.abs() < 3.0 { 0.0 } else { yaw }, if pitch.abs() < 3.0 { 0.0 } else { pitch });
    (roll, yaw, pitch)
}

/// The portrait regions for a face: its face ellipse from the box, the eyes and mouth from the landmarks, and the way it
/// is turned. A face tipped far over has its regions laid out from the landmarks, because its box is the box of a tilted face.
pub fn to_portrait(face: &Face, w: u32, h: u32) -> Portrait {
    let (fw, fh) = (w as f32, h as f32);
    let long = fw.max(fh);
    let ellipse = |cx: f32, cy: f32, rx: f32, ry: f32| Ellipse { cx: cx / fw, cy: cy / fh, rx: rx / long, ry: ry / long };
    let (roll, yaw, pitch) = orientation(&face.landmarks);
    let [a, b, _, ma, mb] = face.landmarks;
    let (ux, uy) = (roll.to_radians().cos(), roll.to_radians().sin()); // along the face's own left-right
    let along = |p: [f32; 2]| p[0] * ux + p[1] * uy;
    // "left" and "right" are the person's own: the eye further along the face's x axis is the right-hand one
    let (left_eye, right_eye) = if along(a) <= along(b) { (a, b) } else { (b, a) };
    let (left_mouth, right_mouth) = if along(ma) <= along(mb) { (ma, mb) } else { (mb, ma) };
    let between = ((right_eye[0] - left_eye[0]).powi(2) + (right_eye[1] - left_eye[1]).powi(2)).sqrt().max(4.0);
    let mouth_width = ((right_mouth[0] - left_mouth[0]).powi(2) + (right_mouth[1] - left_mouth[1]).powi(2)).sqrt().max(4.0);
    let face_ellipse = if roll.abs() > 20.0 {
        let mid = [(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0];
        let down = [-uy, ux];
        ellipse(mid[0] + down[0] * 0.5 * between, mid[1] + down[1] * 0.5 * between, 1.05 * between, 1.45 * between)
    } else {
        // the box runs from the brow to the chin; the retouch also wants some forehead
        ellipse(face.x + face.w / 2.0, face.y + face.h / 2.0 - 0.04 * face.h, face.w / 2.0, face.h / 2.0 * 1.12)
    };
    Portrait {
        face: face_ellipse,
        left_eye: ellipse(left_eye[0], left_eye[1], 0.22 * between, 0.10 * between),
        right_eye: ellipse(right_eye[0], right_eye[1], 0.22 * between, 0.10 * between),
        mouth: ellipse((left_mouth[0] + right_mouth[0]) / 2.0, (left_mouth[1] + right_mouth[1]) / 2.0, 0.6 * mouth_width, 0.3 * mouth_width),
        roll,
        yaw,
        pitch,
        ..Portrait::default()
    }
    .sanitized()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn face_at(x: f32, y: f32, w: f32, h: f32, score: f32) -> Face {
        Face { x, y, w, h, score, landmarks: [[x + w * 0.3, y + h * 0.35], [x + w * 0.7, y + h * 0.35], [x + w * 0.5, y + h * 0.55], [x + w * 0.35, y + h * 0.75], [x + w * 0.65, y + h * 0.75]] }
    }

    /// Twelve outputs for a 640 x 640 picture, all zero, with room for every anchor.
    fn silent() -> Vec<Vec<f32>> {
        let n = |s: usize| (SIDE / s) * (SIDE / s);
        let mut v = Vec::new();
        for ch in [1usize, 1, 4, 10] {
            for s in STRIDES {
                v.push(vec![0.0; n(s) * ch]);
            }
        }
        v
    }

    #[test]
    fn the_model_is_part_of_the_program_and_loads() {
        assert!(MODEL.len() > 200_000, "{} bytes", MODEL.len());
        assert!(model().is_ok(), "{:?}", model().err());
    }

    #[test]
    fn a_blank_picture_has_no_faces_and_the_outputs_have_the_shapes_the_decoder_expects() {
        let m = model().unwrap();
        let outs = run(m, blob(&ImageBuffer::from_pixel(640, 640, Rgb([120u8, 120, 120])), 0, 0, 640, 640, 1.0)).unwrap();
        let counts: Vec<usize> = outs.iter().map(|o| o.len()).collect();
        // class and objectness: one value per anchor; box: four; landmarks: ten; for strides 8, 16, 32
        assert_eq!(counts, [6400, 1600, 400, 6400, 1600, 400, 25600, 6400, 1600, 64000, 16000, 4000]);
        assert!(decode(&outs, MIN_SCORE).is_empty());
        assert!(detect(&ImageBuffer::from_pixel(1500, 1000, Rgb([90u8, 100, 110]))).unwrap().is_empty());
    }

    #[test]
    fn a_confident_anchor_decodes_to_its_box_and_landmarks_and_a_weak_one_does_not() {
        let mut o = silent();
        // stride 8: row 10, column 20
        let idx = 10 * 80 + 20;
        o[0][idx] = 0.9;
        o[3][idx] = 0.9;
        o[6][idx * 4..idx * 4 + 4].copy_from_slice(&[0.5, 0.5, 4f32.ln(), 5f32.ln()]);
        for n in 0..5 {
            o[9][idx * 10 + 2 * n] = n as f32 * 0.5;
            o[9][idx * 10 + 2 * n + 1] = 1.0;
        }
        // a weak anchor elsewhere
        o[1][5] = 0.3;
        o[4][5] = 0.3;
        let faces = decode(&o, MIN_SCORE);
        assert_eq!(faces.len(), 1);
        let f = &faces[0];
        assert!((f.score - 0.9).abs() < 1e-5);
        // centre ((20 + 0.5) * 8, (10 + 0.5) * 8) = (164, 84); 32 wide, 40 tall
        assert!((f.x - 148.0).abs() < 1e-3 && (f.y - 64.0).abs() < 1e-3 && (f.w - 32.0).abs() < 1e-3 && (f.h - 40.0).abs() < 1e-3, "{f:?}");
        assert_eq!(f.landmarks[0], [160.0, 88.0]);
        assert_eq!(f.landmarks[2], [168.0, 88.0]);
        assert_eq!(f.landmarks[4], [176.0, 88.0]);
        assert!(decode(&o[..5], MIN_SCORE).is_empty(), "too few outputs is nothing, not a crash");
    }

    #[test]
    fn overlapping_boxes_are_merged_keeping_the_best_and_apart_ones_are_kept() {
        let kept = merge(vec![face_at(100.0, 100.0, 80.0, 90.0, 0.8), face_at(105.0, 98.0, 80.0, 92.0, 0.95), face_at(400.0, 100.0, 80.0, 90.0, 0.75)]);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].score, 0.95, "best first");
        // a small box inside a big one is the same face
        let inside = merge(vec![face_at(100.0, 100.0, 200.0, 220.0, 0.9), face_at(150.0, 150.0, 60.0, 70.0, 0.85)]);
        assert_eq!(inside.len(), 1);
    }

    #[test]
    fn tiles_cover_the_whole_side_with_the_last_flush_and_a_small_side_is_one_tile() {
        assert_eq!(tile_origins(500, 640, 480), [0]);
        assert_eq!(tile_origins(640, 640, 480), [0]);
        assert_eq!(tile_origins(1000, 640, 480), [0, 360]);
        for len in [641u32, 1000, 1365, 2048, 3000, 6000] {
            let t = tile_origins(len, 640, 480);
            assert_eq!(t[0], 0);
            assert_eq!(*t.last().unwrap() + 640, len, "the last tile ends at the edge ({len})");
            assert!(t.windows(2).all(|p| p[1] - p[0] <= 480 && p[1] > p[0]), "no gaps, moving on ({len})");
        }
    }

    #[test]
    fn a_face_becomes_a_face_two_eyes_and_a_mouth_in_the_right_places_whatever_the_picture_shape() {
        for (w, h) in [(3000u32, 2000u32), (2000, 3000), (1000, 1000)] {
            let f = face_at(w as f32 * 0.4, h as f32 * 0.3, w as f32 * 0.1, h as f32 * 0.14, 0.9);
            let p = to_portrait(&f, w, h);
            assert!(p.left_eye.cx < p.right_eye.cx, "left is the left in the picture");
            assert!((p.left_eye.cy - p.right_eye.cy).abs() < 1e-6);
            assert!(p.left_eye.cy < p.face.cy + 0.02 && p.mouth.cy > p.face.cy, "eyes above, mouth below");
            assert!((p.mouth.cx - p.face.cx).abs() < 0.02, "the mouth is in the middle");
            for e in [p.left_eye, p.right_eye, p.mouth] {
                assert!((e.cx - p.face.cx).abs() < p.face.rx * (w.max(h) as f32 / w as f32), "inside the face width");
                assert!(e.rx > e.ry, "wider than tall");
            }
            assert_eq!(p.skin.impact, 100.0);
        }
        // the order of the eyes carries meaning (the right eye comes first), so a swapped pair reads as a face upside down
        let mut f = face_at(100.0, 100.0, 80.0, 90.0, 0.9);
        f.landmarks.swap(0, 1);
        f.landmarks.swap(3, 4);
        assert!((to_portrait(&f, 1000, 1000).roll.abs() - 180.0).abs() < 1.0);
    }

    #[test]
    fn the_turn_of_a_face_is_read_from_its_landmarks() {
        // upright and facing the camera: eyes level, nose in the middle, a normal distance down
        let front = [[40.0, 40.0], [60.0, 40.0], [50.0, 52.0], [42.0, 66.0], [58.0, 66.0]];
        assert_eq!(orientation(&front), (0.0, 0.0, 0.0));
        // the whole face turned a quarter clockwise: the eye line runs down the picture
        let quarter = [[60.0, 40.0], [60.0, 60.0], [48.0, 50.0], [34.0, 42.0], [34.0, 58.0]];
        let (roll, _, _) = orientation(&quarter);
        assert!((roll - 90.0).abs() < 1.0, "{roll}");
        // the nose well to one side of the eyes: looking that way
        let right = [[40.0, 40.0], [60.0, 40.0], [57.0, 52.0], [48.0, 66.0], [62.0, 66.0]];
        let left = [[40.0, 40.0], [60.0, 40.0], [43.0, 52.0], [38.0, 66.0], [52.0, 66.0]];
        assert!(orientation(&right).1 > 20.0 && orientation(&left).1 < -20.0);
    }

    #[test]
    fn a_turned_search_puts_points_back_where_they_were() {
        // a point of a 300 x 200 picture, found on the copy turned by k quarter turns, comes back to the same place
        let (w, h) = (300.0f32, 200.0f32);
        let p = [70.0, 30.0];
        let turned = |k: u8| match k {
            1 => [h - p[1], p[0]],
            2 => [w - p[0], h - p[1]],
            _ => [p[1], w - p[0]],
        };
        for k in 1..=3u8 {
            let back = unturn(k, turned(k), w, h);
            assert!((back[0] - p[0]).abs() < 1e-3 && (back[1] - p[1]).abs() < 1e-3, "{k}: {back:?}");
        }
    }

    #[test]
    fn a_face_tipped_over_has_its_regions_laid_out_along_its_own_axes() {
        // a face lying on its side (the eye line runs down the picture): the eyes are one above the other in the picture
        let face = Face { x: 20.0, y: 30.0, w: 90.0, h: 70.0, score: 0.9, landmarks: [[70.0, 50.0], [70.0, 90.0], [50.0, 70.0], [30.0, 55.0], [30.0, 85.0]] };
        let p = to_portrait(&face, 200, 200);
        assert!((p.roll - 90.0).abs() < 1.0, "{}", p.roll);
        assert!((p.left_eye.cx - p.right_eye.cx).abs() < 0.01 && (p.left_eye.cy - p.right_eye.cy).abs() > 0.1);
        // the face ellipse sits on the far side of the eyes from where the forehead is, not on the eyes
        assert!(p.face.cx < p.left_eye.cx);
    }

    /// Run the detector on a folder of real photos and save annotated copies, to see it work.
    /// PENUMBRA_FACE_DIR=<folder> PENUMBRA_FACE_OUT=<folder> PENUMBRA_FACE_N=<how many> cargo test try_my_photos -- --ignored --nocapture
    #[test]
    #[ignore]
    fn try_my_photos() {
        let dir = std::env::var("PENUMBRA_FACE_DIR").expect("set PENUMBRA_FACE_DIR");
        let out = std::env::var("PENUMBRA_FACE_OUT").expect("set PENUMBRA_FACE_OUT");
        let n: usize = std::env::var("PENUMBRA_FACE_N").ok().and_then(|v| v.parse().ok()).unwrap_or(15);
        std::fs::create_dir_all(&out).unwrap();
        let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| crate::media::kind_of(p) == Some(crate::media::Kind::Image)).collect();
        files.sort();
        let step = (files.len() / n.max(1)).max(1);
        for path in files.iter().step_by(step).take(n) {
            let Ok(img) = crate::media::decode_oriented(path) else { continue };
            let img = if img.width().max(img.height()) > 2048 { img.resize(2048, 2048, image::imageops::FilterType::Triangle) } else { img };
            let mut rgb = img.to_rgb8();
            let t = std::time::Instant::now();
            let faces = detect(&rgb).unwrap();
            let ms = t.elapsed().as_millis();
            let low: Vec<f32> = candidates(&rgb, 0.3).unwrap().iter().take(4).map(|f| (f.score * 100.0).round() / 100.0).collect();
            let line = |im: &mut RgbImage, x0: i32, y0: i32, x1: i32, y1: i32, c: [u8; 3]| {
                let (w, h) = (im.width() as i32, im.height() as i32);
                for t in 0..3 {
                    for x in x0..=x1 {
                        for y in [y0 + t, y1 - t] {
                            if x >= 0 && y >= 0 && x < w && y < h {
                                im.put_pixel(x as u32, y as u32, Rgb(c));
                            }
                        }
                    }
                    for y in y0..=y1 {
                        for x in [x0 + t, x1 - t] {
                            if x >= 0 && y >= 0 && x < w && y < h {
                                im.put_pixel(x as u32, y as u32, Rgb(c));
                            }
                        }
                    }
                }
            };
            for f in &faces {
                line(&mut rgb, f.x as i32, f.y as i32, (f.x + f.w) as i32, (f.y + f.h) as i32, [255, 40, 40]);
                let p = to_portrait(f, rgb.width(), rgb.height());
                let long = rgb.width().max(rgb.height()) as f32;
                for e in [p.left_eye, p.right_eye, p.mouth] {
                    let (cx, cy, rx, ry) = (e.cx * rgb.width() as f32, e.cy * rgb.height() as f32, e.rx * long, e.ry * long);
                    line(&mut rgb, (cx - rx) as i32, (cy - ry) as i32, (cx + rx) as i32, (cy + ry) as i32, [40, 255, 40]);
                }
            }
            let name = path.file_stem().unwrap().to_string_lossy().replace(' ', "_");
            let small = image::DynamicImage::ImageRgb8(rgb).resize(1400, 1400, image::imageops::FilterType::Triangle);
            crate::media::save_jpeg(&small, &std::path::Path::new(&out).join(format!("{name}.jpg")), 85).unwrap();
            eprintln!("{}: {} face(s) in {} ms, scores {:?}; best candidates from 0.3 up {:?}", path.file_name().unwrap().to_string_lossy(), faces.len(), ms, faces.iter().map(|f| (f.score * 100.0).round() / 100.0).collect::<Vec<_>>(), low);
        }
    }
}
