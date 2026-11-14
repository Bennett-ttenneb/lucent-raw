//! Face parsing: which pixels of a face are skin, neck, eyes, brows, lips, the inside of the mouth, hair, clothes.
//!
//! A small BiSeNet (ResNet18, MIT licence, trained on CelebAMask-HQ, see resources/MODEL-LICENCES.txt) runs on this
//! machine with `tract`. It sees a square crop around a marked face, stood upright by the face's own tilt, and gives
//! a probability for each of 19 parts at 512 x 512. The retouch asks it for a part at any pixel of the picture.
//! Results are kept for the last few faces, because a slider move redraws the same face again and again.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use image::RgbImage;
use tract_onnx::prelude::*;

const MODEL: &[u8] = include_bytes!("../resources/face-parsing-resnet18.onnx");
pub const SIDE: usize = 512;
const CLASSES: usize = 19;
/// The crop is this many times the longer radius of the face ellipse, each way from the middle: the face, with its hair, ears and neck in view.
const CROP_RADII: f32 = 1.6;

// the 19 classes of CelebAMask-HQ
const SKIN: usize = 1;
const L_BROW: usize = 2;
const R_BROW: usize = 3;
const L_EYE: usize = 4;
const R_EYE: usize = 5;
const L_EAR: usize = 7;
const R_EAR: usize = 8;
const NOSE: usize = 10;
const MOUTH: usize = 11;
const U_LIP: usize = 12;
const L_LIP: usize = 13;
const NECK: usize = 14;
const HAIR: usize = 17;
const CLOTH: usize = 16;
const GLASSES: usize = 6;
const EARRING: usize = 9;
const NECKLACE: usize = 15;
const HAT: usize = 18;

type Model = TypedRunnableModel;

fn model() -> Result<&'static Arc<Model>, String> {
    static CACHE: OnceLock<Result<Arc<Model>, String>> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            let load = || -> TractResult<Arc<Model>> {
                let m = tract_onnx::onnx().model_for_read(&mut std::io::Cursor::new(MODEL))?.with_input_fact(0, f32::fact([1, 3, SIDE, SIDE]).into())?;
                Ok(m.into_optimized()?.into_runnable()?)
            };
            load().map_err(|e| format!("the face-parsing model could not be loaded: {e}"))
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// What the parser found in one crop. Each plane is `SIDE` x `SIDE`, 0 to 1.
pub struct Parts {
    pub skin: Vec<f32>,
    pub neck: Vec<f32>,
    pub eyes: Vec<f32>,
    pub brows: Vec<f32>,
    pub lips: Vec<f32>,
    pub mouth: Vec<f32>,
    pub hair: Vec<f32>,
    pub cloth: Vec<f32>,
    /// Everything on a person that is not skin: eyes, brows, lips, the mouth, hair, glasses, jewellery, a hat, clothes.
    pub others: Vec<f32>,
    /// Where the crop sits in the picture: its middle, its side in pixels, and the tilt it was stood upright by (radians).
    pub cx: f32,
    pub cy: f32,
    pub side: f32,
    pub angle: f32,
}

fn sample(plane: &[f32], u: f32, v: f32) -> f32 {
    // bilinear, u and v in 0..SIDE
    let (x, y) = ((u - 0.5).clamp(0.0, SIDE as f32 - 1.001), (v - 0.5).clamp(0.0, SIDE as f32 - 1.001));
    let (x0, y0) = (x.floor() as usize, y.floor() as usize);
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let at = |xx: usize, yy: usize| plane[yy * SIDE + xx];
    (at(x0, y0) * (1.0 - fx) + at(x0 + 1, y0) * fx) * (1.0 - fy) + (at(x0, y0 + 1) * (1.0 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
}

impl Parts {
    /// Where a picture pixel falls in the crop: (u, v) in 0..SIDE, or None outside it.
    fn to_crop(&self, x: f32, y: f32) -> Option<(f32, f32)> {
        let (dx, dy) = (x - self.cx, y - self.cy);
        let (c, s) = (self.angle.cos(), self.angle.sin());
        // undo the tilt: the crop shows the face upright
        let (px, py) = (dx * c + dy * s, -dx * s + dy * c);
        let k = SIDE as f32 / self.side;
        let (u, v) = (px * k + SIDE as f32 / 2.0, py * k + SIDE as f32 / 2.0);
        (u >= 0.0 && v >= 0.0 && u < SIDE as f32 && v < SIDE as f32).then_some((u, v))
    }
    fn at(&self, plane: &[f32], x: f32, y: f32) -> f32 {
        self.to_crop(x, y).map_or(0.0, |(u, v)| sample(plane, u, v))
    }
    /// Skin of the face (the cheeks, forehead, nose and ears) at a picture pixel, 0 to 1.
    pub fn skin_at(&self, x: f32, y: f32) -> f32 {
        self.at(&self.skin, x, y)
    }
    pub fn neck_at(&self, x: f32, y: f32) -> f32 {
        self.at(&self.neck, x, y)
    }
    pub fn eyes_at(&self, x: f32, y: f32) -> f32 {
        self.at(&self.eyes, x, y)
    }
    pub fn brows_at(&self, x: f32, y: f32) -> f32 {
        self.at(&self.brows, x, y)
    }
    pub fn lips_at(&self, x: f32, y: f32) -> f32 {
        self.at(&self.lips, x, y)
    }
    /// The inside of the mouth: the teeth and the tongue.
    pub fn mouth_at(&self, x: f32, y: f32) -> f32 {
        self.at(&self.mouth, x, y)
    }
    pub fn hair_at(&self, x: f32, y: f32) -> f32 {
        self.at(&self.hair, x, y)
    }
    /// Anything that is not skin (eyes, lashes, brows, lips, hair, glasses, jewellery, clothes) at a picture pixel.
    pub fn others_at(&self, x: f32, y: f32) -> f32 {
        self.at(&self.others, x, y)
    }
    pub fn cloth_at(&self, x: f32, y: f32) -> f32 {
        self.at(&self.cloth, x, y)
    }
    /// A named part at a picture pixel: skin, neck, eyes, brows, lips, teeth, hair or clothes.
    pub fn part_at(&self, part: &str, x: f32, y: f32) -> f32 {
        match part {
            "skin" => self.skin_at(x, y),
            "neck" => self.neck_at(x, y),
            "eyes" => self.eyes_at(x, y),
            "brows" => self.brows_at(x, y),
            "lips" => self.lips_at(x, y),
            "teeth" => self.mouth_at(x, y),
            "hair" => self.hair_at(x, y),
            "clothes" => self.cloth_at(x, y),
            _ => 0.0,
        }
    }
}

/// The parts every face of a picture is asked for.
pub const PARTS: [&str; 8] = ["skin", "neck", "eyes", "brows", "lips", "teeth", "hair", "clothes"];

/// A grey picture of the whole picture (long side 384, squashed to the picture's own shape) that is white where `part`
/// of any face is, for the People masks. The faces are found in `img` first.
pub fn person_map(img: &RgbImage, part: &str) -> Result<image::GrayImage, String> {
    if !PARTS.contains(&part) {
        return Err(format!("Unknown part of a person: {part}."));
    }
    let faces = crate::faces::detect(img)?;
    if faces.is_empty() {
        return Err("No face was found in this picture, so there is no person to mask.".into());
    }
    let (fw, fh) = (img.width() as f32, img.height() as f32);
    let long = fw.max(fh);
    let mut found = Vec::new();
    for f in &faces {
        let p = crate::faces::to_portrait(f, img.width(), img.height());
        found.push(parse(img, p.face.cx * fw, p.face.cy * fh, p.face.rx.max(p.face.ry) * long, p.roll.to_radians())?);
    }
    let k = 384.0 / long;
    let (mw, mh) = (((fw * k).round() as u32).max(2), ((fh * k).round() as u32).max(2));
    Ok(image::GrayImage::from_fn(mw, mh, |u, v| {
        let (x, y) = ((u as f32 + 0.5) / mw as f32 * fw, (v as f32 + 0.5) / mh as f32 * fh);
        let m = found.iter().map(|pt| pt.part_at(part, x, y)).fold(0.0f32, f32::max);
        image::Luma([(m.clamp(0.0, 1.0) * 255.0).round() as u8])
    }))
}

/// The crop for a face: stood upright, `SIDE` x `SIDE`, as the model's input (RGB, ImageNet-normalised, channels first).
fn input(img: &RgbImage, cx: f32, cy: f32, side: f32, angle: f32) -> Tensor {
    let (c, s) = (angle.cos(), angle.sin());
    let k = side / SIDE as f32;
    let mean = [0.485f32, 0.456, 0.406];
    let std = [0.229f32, 0.224, 0.225];
    let (w, h) = (img.width() as i64, img.height() as i64);
    let mut data = vec![0f32; 3 * SIDE * SIDE];
    for v in 0..SIDE {
        for u in 0..SIDE {
            let (px, py) = ((u as f32 + 0.5 - SIDE as f32 / 2.0) * k, (v as f32 + 0.5 - SIDE as f32 / 2.0) * k);
            let (x, y) = (cx + px * c - py * s, cy + px * s + py * c);
            // bilinear read, with the edge repeated outside the picture
            let (fx, fy) = (x - 0.5, y - 0.5);
            let (x0, y0) = (fx.floor() as i64, fy.floor() as i64);
            let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
            let get = |xx: i64, yy: i64, ch: usize| img.get_pixel(xx.clamp(0, w - 1) as u32, yy.clamp(0, h - 1) as u32)[ch] as f32 / 255.0;
            for ch in 0..3 {
                let top = get(x0, y0, ch) * (1.0 - tx) + get(x0 + 1, y0, ch) * tx;
                let bot = get(x0, y0 + 1, ch) * (1.0 - tx) + get(x0 + 1, y0 + 1, ch) * tx;
                data[ch * SIDE * SIDE + v * SIDE + u] = ((top * (1.0 - ty) + bot * ty) - mean[ch]) / std[ch];
            }
        }
    }
    Tensor::from_shape(&[1, 3, SIDE, SIDE], &data).expect("shape matches data")
}

/// Softmax over the 19 class logits at every pixel, then the planes the retouch wants.
fn planes(logits: &[f32], cx: f32, cy: f32, side: f32, angle: f32) -> Parts {
    let n = SIDE * SIDE;
    let mut p = vec![vec![0f32; n]; CLASSES];
    for i in 0..n {
        let mut m = f32::MIN;
        for c in 0..CLASSES {
            m = m.max(logits[c * n + i]);
        }
        let mut sum = 0.0;
        for c in 0..CLASSES {
            let e = (logits[c * n + i] - m).exp();
            p[c][i] = e;
            sum += e;
        }
        for c in 0..CLASSES {
            p[c][i] /= sum;
        }
    }
    let add = |cs: &[usize]| -> Vec<f32> { (0..n).map(|i| cs.iter().map(|&c| p[c][i]).sum::<f32>().min(1.0)).collect() };
    Parts {
        skin: add(&[SKIN, NOSE, L_EAR, R_EAR]),
        neck: add(&[NECK]),
        eyes: add(&[L_EYE, R_EYE]),
        brows: add(&[L_BROW, R_BROW]),
        lips: add(&[U_LIP, L_LIP]),
        mouth: add(&[MOUTH]),
        hair: add(&[HAIR]),
        cloth: add(&[CLOTH]),
        others: add(&[L_BROW, R_BROW, L_EYE, R_EYE, GLASSES, EARRING, MOUTH, U_LIP, L_LIP, NECKLACE, CLOTH, HAIR, HAT]),
        cx,
        cy,
        side,
        angle,
    }
}

/// Run the parser on the crop around a face. `cx`, `cy` and `radius` describe the face in pixels of `img`, `angle` is its tilt in radians.
pub fn parse(img: &RgbImage, cx: f32, cy: f32, radius: f32, angle: f32) -> Result<Arc<Parts>, String> {
    let side = (radius * CROP_RADII * 2.0).max(32.0);
    // the same face of the same picture is asked for again at every slider move: remember it
    let mut hash: u64 = 1469598103934665603;
    let mut mix = |v: u64| hash = (hash ^ v).wrapping_mul(1099511628211);
    mix(img.width() as u64);
    mix(img.height() as u64);
    for v in [cx, cy, side, angle] {
        mix(v.to_bits() as u64);
    }
    // a thin sample of the picture's own pixels, so a different picture of the same size does not match
    let step = (img.as_raw().len() / 4099).max(3) / 3 * 3;
    for b in img.as_raw().iter().step_by(step.max(1)) {
        mix(*b as u64);
    }
    static CACHE: OnceLock<Mutex<HashMap<u64, Arc<Parts>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache.lock().map_err(|_| "the face cache stopped".to_string())?.get(&hash) {
        return Ok(hit.clone());
    }
    let out = model()?.run(tvec!(input(img, cx, cy, side, angle).into())).map_err(|e| e.to_string())?;
    let logits: Vec<f32> = out[0].to_plain_array_view::<f32>().map_err(|e| e.to_string())?.iter().copied().collect();
    if logits.len() != CLASSES * SIDE * SIDE {
        return Err(format!("the face-parsing model gave {} numbers, not {}", logits.len(), CLASSES * SIDE * SIDE));
    }
    let parts = Arc::new(planes(&logits, cx, cy, side, angle));
    let mut map = cache.lock().map_err(|_| "the face cache stopped".to_string())?;
    if map.len() >= 8 {
        map.clear();
    }
    map.insert(hash, parts.clone());
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_model_loads_and_a_blank_picture_has_no_face_in_it() {
        let img = RgbImage::from_pixel(300, 300, image::Rgb([120, 120, 125]));
        let parts = parse(&img, 150.0, 150.0, 60.0, 0.0).unwrap();
        assert!(parts.skin_at(150.0, 150.0) < 0.5, "no skin in a grey picture");
        assert_eq!(parts.skin_at(-500.0, 0.0), 0.0, "nothing outside the crop");
    }

    #[test]
    fn a_point_maps_into_the_crop_and_back_whatever_the_tilt() {
        let p = Parts { skin: vec![], neck: vec![], eyes: vec![], brows: vec![], lips: vec![], mouth: vec![], hair: vec![], cloth: vec![], others: vec![], cx: 100.0, cy: 100.0, side: 200.0, angle: 90f32.to_radians() };
        let (u, v) = p.to_crop(100.0, 100.0).unwrap();
        assert!((u - 256.0).abs() < 0.01 && (v - 256.0).abs() < 0.01, "the middle stays the middle");
        // a point 50 px to the right of the middle of a face turned a quarter clockwise lies above the middle once it is stood upright
        let (u, v) = p.to_crop(150.0, 100.0).unwrap();
        assert!((u - 256.0).abs() < 0.5 && v < 256.0, "{u} {v}");
    }

    /// PARSE_PICTURE=<file> PARSE_OUT=<folder>: save the parts the parser finds in a face picture, to see them.
    #[test]
    #[ignore]
    fn show_the_parts_of_a_picture() {
        let (Ok(file), Ok(out)) = (std::env::var("PARSE_PICTURE"), std::env::var("PARSE_OUT")) else { return };
        let img = if file.to_lowercase().ends_with(".cr2") {
            crate::media::edited_picture(std::path::Path::new(&file), 2048, None).unwrap().to_rgb8()
        } else {
            image::open(&file).unwrap().to_rgb8()
        };
        let faces = crate::faces::detect(&img).unwrap();
        let f = &faces[0];
        let p = crate::faces::to_portrait(f, img.width(), img.height());
        let long = img.width().max(img.height()) as f32;
        let t = std::time::Instant::now();
        let parts = parse(&img, p.face.cx * img.width() as f32, p.face.cy * img.height() as f32, p.face.rx.max(p.face.ry) * long, p.roll.to_radians()).unwrap();
        println!("parsed in {:.2} s", t.elapsed().as_secs_f32());
        let mut show = RgbImage::new(img.width(), img.height());
        for (x, y, px) in show.enumerate_pixels_mut() {
            let (xf, yf) = (x as f32 + 0.5, y as f32 + 0.5);
            let o = img.get_pixel(x, y);
            let layers = [
                (parts.skin_at(xf, yf), [255.0, 190.0, 120.0]),
                (parts.neck_at(xf, yf), [255.0, 120.0, 60.0]),
                (parts.eyes_at(xf, yf), [60.0, 160.0, 255.0]),
                (parts.brows_at(xf, yf), [200.0, 60.0, 255.0]),
                (parts.lips_at(xf, yf), [255.0, 60.0, 120.0]),
                (parts.mouth_at(xf, yf), [255.0, 255.0, 255.0]),
                (parts.hair_at(xf, yf), [60.0, 255.0, 120.0]),
            ];
            let mut v = [o[0] as f32 * 0.5, o[1] as f32 * 0.5, o[2] as f32 * 0.5];
            for (m, c) in layers {
                for k in 0..3 {
                    v[k] += m * c[k] * 0.5;
                }
            }
            *px = image::Rgb([v[0].min(255.0) as u8, v[1].min(255.0) as u8, v[2].min(255.0) as u8]);
        }
        std::fs::create_dir_all(&out).unwrap();
        show.save(std::path::Path::new(&out).join("parts.png")).unwrap();
    }
}
