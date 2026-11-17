//! Tries the AI tools, the dust finder and DNG conversion on real photographs and writes what they did to a folder, so a person can look.
//! Not part of the normal test run. Run by hand:
//!   LUCENT_REAL_DIR=<folder of CR2 files> LUCENT_REAL_NAMES=_MG_0031,_MG_0046 LUCENT_REAL_OUT=<empty folder> cargo test --lib realcheck -- --ignored --nocapture
//! The photographs are only read; every result is written to the output folder.

#[cfg(test)]
mod tests {
    use image::{GrayImage, RgbImage};
    use std::path::{Path, PathBuf};
    use std::time::Instant;

    fn secs(t: Instant) -> String {
        format!("{:.1} s", t.elapsed().as_secs_f32())
    }

    fn crop(img: &RgbImage, x: u32, y: u32, w: u32, h: u32) -> RgbImage {
        image::imageops::crop_imm(img, x.min(img.width() - w), y.min(img.height() - h), w, h).to_image()
    }

    fn side(a: &RgbImage, b: &RgbImage) -> RgbImage {
        let mut out = RgbImage::new(a.width() + b.width() + 8, a.height().max(b.height()));
        image::imageops::replace(&mut out, a, 0, 0);
        image::imageops::replace(&mut out, b, a.width() as i64 + 8, 0);
        out
    }

    fn grey_to_rgb(g: &GrayImage) -> RgbImage {
        RgbImage::from_fn(g.width(), g.height(), |x, y| image::Rgb([g.get_pixel(x, y)[0]; 3]))
    }

    #[test]
    #[ignore]
    fn try_the_ai_tools_and_dng_on_real_photographs() {
        let (Ok(dir), Ok(names), Ok(out)) = (std::env::var("LUCENT_REAL_DIR"), std::env::var("LUCENT_REAL_NAMES"), std::env::var("LUCENT_REAL_OUT")) else { return };
        let out = PathBuf::from(out);
        std::fs::create_dir_all(&out).unwrap();
        let mut log = String::new();
        let mut say = |s: String| {
            println!("{s}");
            log += &s;
            log += "\n";
        };
        for name in names.split(',') {
            let path = Path::new(&dir).join(format!("{name}.CR2"));
            say(format!("\n=== {name}"));
            let t = Instant::now();
            let decoded = crate::media::edited_picture(&path, 2048, None);
            let img = match decoded {
                Ok(i) => i.to_rgb8(),
                Err(e) => {
                    say(format!("decode FAILED: {e}"));
                    continue;
                }
            };
            say(format!("decode to 2048 px: {} ({}x{})", secs(t), img.width(), img.height()));
            let meta = crate::media::read_meta(&path);
            let iso = meta.iso.unwrap_or(800) as f32;
            say(format!("camera {:?} {:?}, ISO {iso}", meta.make, meta.model));

            // AI denoise on the middle of the picture, and on the whole picture once
            let t = Instant::now();
            match crate::denoise::denoise(&img, iso, 0.8, &|_, _| {}) {
                Ok(d) => {
                    say(format!("AI denoise, whole 2048 px picture: {}", secs(t)));
                    let (x, y) = (img.width() / 2 - 200, img.height() / 2 - 150);
                    side(&crop(&img, x, y, 400, 300), &crop(&d, x, y, 400, 300)).save(out.join(format!("{name}-denoise.png"))).unwrap();
                    let noise = |i: &RgbImage| {
                        // the average difference between neighbouring pixels in a flat-ish patch: smaller is smoother
                        let c = crop(i, 50, 50, 200, 200);
                        let mut s = 0f64;
                        for (x, y, p) in c.enumerate_pixels() {
                            if x + 1 < c.width() {
                                s += (p[1] as f64 - c.get_pixel(x + 1, y)[1] as f64).abs();
                            }
                        }
                        s / (200.0 * 199.0)
                    };
                    say(format!("neighbour difference in a corner patch: before {:.2}, after {:.2}", noise(&img), noise(&d)));
                }
                Err(e) => say(format!("AI denoise FAILED: {e}")),
            }

            // depth
            let t = Instant::now();
            match crate::depth::find_depth(&img) {
                Ok(m) => {
                    say(format!("depth map: {}", secs(t)));
                    grey_to_rgb(&image::imageops::resize(&m, 512, (512.0 * img.height() as f32 / img.width() as f32) as u32, image::imageops::FilterType::Triangle)).save(out.join(format!("{name}-depth.png"))).unwrap();
                }
                Err(e) => say(format!("depth FAILED: {e}")),
            }

            // object: look once, then point at the middle
            let t = Instant::now();
            match crate::object::look(&img, name) {
                Ok(seen) => {
                    say(format!("object model looked at the picture: {}", secs(t)));
                    let t = Instant::now();
                    match crate::object::pick(&seen, 0.5, 0.5, None) {
                        Ok((m, score)) => {
                            let cover = m.pixels().filter(|p| p[0] > 127).count() as f32 / (m.width() * m.height()) as f32;
                            say(format!("pointing at the middle: {} (score {score:.2}, covers {:.0}% of the picture)", secs(t), cover * 100.0));
                            let small = image::imageops::resize(&img, 512, (512.0 * img.height() as f32 / img.width() as f32) as u32, image::imageops::FilterType::Triangle);
                            let mask = image::imageops::resize(&m, small.width(), small.height(), image::imageops::FilterType::Triangle);
                            let tinted = RgbImage::from_fn(small.width(), small.height(), |x, y| {
                                let p = small.get_pixel(x, y);
                                let k = mask.get_pixel(x, y)[0] as f32 / 255.0;
                                image::Rgb([(p[0] as f32 * (1.0 - 0.6 * k) + 255.0 * 0.6 * k) as u8, (p[1] as f32 * (1.0 - 0.6 * k)) as u8, (p[2] as f32 * (1.0 - 0.6 * k)) as u8])
                            });
                            side(&small, &tinted).save(out.join(format!("{name}-object.png"))).unwrap();
                        }
                        Err(e) => say(format!("object pick FAILED: {e}")),
                    }
                }
                Err(e) => say(format!("object look FAILED: {e}")),
            }

            // enlarge: a 300 x 225 piece, 4 times, smooth against AI
            let piece = crop(&img, img.width() / 2 - 150, img.height() / 2 - 112, 300, 225);
            let t = Instant::now();
            let smooth = crate::upscale::smooth(&piece, 1200, 900);
            say(format!("enlarge smooth 4x of a 300x225 piece: {}", secs(t)));
            let t = Instant::now();
            match crate::upscale::ai_x4(&piece, &|_, _| {}) {
                Ok(a) => {
                    say(format!("enlarge AI 4x of a 300x225 piece: {} (result {}x{})", secs(t), a.width(), a.height()));
                    side(&crop(&smooth, 300, 225, 600, 450), &crop(&a, 300, 225, 600, 450)).save(out.join(format!("{name}-enlarge.png"))).unwrap();
                }
                Err(e) => say(format!("enlarge AI FAILED: {e}")),
            }

            // dust
            let t = Instant::now();
            let dust = crate::spots::find_dust(&img);
            say(format!("find dust: {} spots in {}", dust.len(), secs(t)));
            say(format!("strongest: {:?}", dust.iter().take(6).map(|d| (format!("{:.2},{:.2}", d.x, d.y), d.strength as i32)).collect::<Vec<_>>()));

            // DNG
            let dng = out.join(format!("{name}.dng"));
            let t = Instant::now();
            match crate::dngout::convert(&path, &dng, false) {
                Ok(()) => {
                    let size = std::fs::metadata(&dng).map(|m| m.len()).unwrap_or(0);
                    say(format!("copy as DNG: {} ({:.1} MB; original {:.1} MB)", secs(t), size as f64 / 1e6, std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) as f64 / 1e6));
                    say(format!("orientation tag: original {:?}, DNG {:?}", crate::media::read_meta(&path).orientation, crate::media::read_meta(&dng).orientation));
                    match crate::media::edited_picture(&dng, 2048, None) {
                        Ok(back) => {
                            let back = back.to_rgb8();
                            let same = back.width() == img.width() && back.height() == img.height();
                            let diff = if same { img.pixels().zip(back.pixels()).map(|(a, b)| (a[1] as i32 - b[1] as i32).abs() as f64).sum::<f64>() / (img.width() * img.height()) as f64 } else { -1.0 };
                            say(format!("the DNG reads back: {}x{} (same size as the original's picture: {same}, average difference of the green channel {diff:.2})", back.width(), back.height()));
                        }
                        Err(e) => say(format!("the DNG did NOT read back: {e}")),
                    }
                }
                Err(e) => say(format!("copy as DNG FAILED: {e}")),
            }
        }
        std::fs::write(out.join("log.txt"), log).unwrap();
    }
}

#[cfg(test)]
mod enlarge_speed {
    use image::RgbImage;
    use std::time::Instant;

    #[test]
    #[ignore]
    fn how_long_the_enlarger_takes() {
        let tile = RgbImage::from_fn(96, 96, |x, y| image::Rgb([(x * 2) as u8, (y * 2) as u8, 90]));
        let t = Instant::now();
        crate::upscale::ai_x4(&tile, &|_, _| {}).unwrap();
        println!("first call, one tile (includes loading the model): {:.1} s", t.elapsed().as_secs_f32());
        let t = Instant::now();
        crate::upscale::ai_x4(&tile, &|_, _| {}).unwrap();
        println!("second call, one tile: {:.1} s", t.elapsed().as_secs_f32());
        let big = RgbImage::from_fn(300, 225, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 90]));
        let t = Instant::now();
        crate::upscale::ai_x4(&big, &|_, _| {}).unwrap();
        println!("300x225 (12 tiles): {:.1} s", t.elapsed().as_secs_f32());
    }
}

#[cfg(test)]
mod retouch_check {
    use image::RgbImage;
    use std::path::{Path, PathBuf};
    use std::time::Instant;

    fn crop(img: &RgbImage, x: u32, y: u32, w: u32, h: u32) -> RgbImage {
        let x = x.min(img.width().saturating_sub(w));
        let y = y.min(img.height().saturating_sub(h));
        image::imageops::crop_imm(img, x, y, w.min(img.width()), h.min(img.height())).to_image()
    }

    /// LUCENT_REAL_DIR, LUCENT_REAL_NAMES, LUCENT_REAL_OUT as for the other real-photo check.
    #[test]
    #[ignore]
    fn try_b_bot_and_the_portrait_retouch_on_real_photographs() {
        let (Ok(dir), Ok(names), Ok(out)) = (std::env::var("LUCENT_REAL_DIR"), std::env::var("LUCENT_REAL_NAMES"), std::env::var("LUCENT_REAL_OUT")) else { return };
        crate::portrait::USE_PARSER.store(true, std::sync::atomic::Ordering::Relaxed);
        let out = PathBuf::from(out);
        std::fs::create_dir_all(&out).unwrap();
        for name in names.split(',') {
            println!("\n=== {name}");
            let path = Path::new(&dir).join(format!("{name}.CR2"));
            let img = crate::media::edited_picture(&path, 2048, None).unwrap().to_rgb8();
            let t = Instant::now();
            let faces = crate::faces::detect(&img).unwrap();
            println!("faces: {} in {:.2} s", faces.len(), t.elapsed().as_secs_f32());
            let t = Instant::now();
            let advice = crate::advisor::advise(&img, &faces, &crate::develop::Recipe::default());
            println!("advise: {:.2} s", t.elapsed().as_secs_f32());
            println!("skin: {:?}", advice.skin);
            for s in &advice.items {
                println!("suggestion: {}", serde_json::to_string(s).unwrap());
            }
            if faces.is_empty() {
                continue;
            }
            let mut p = crate::faces::to_portrait(&faces[0], img.width(), img.height());
            p.skin.blemishes = 55.0;
            p.skin.dark_circles = 25.0;
            p.skin.even_amount = 40.0;
            p.skin.even_texture = 75.0;
            p.skin.contouring = 0.0;
            p.skin.tone = 35.0;
            p.skin.shine = 30.0;
            p.skin.colour = 35.0;
            p.skin.body = std::env::var("BODY").ok().and_then(|v| v.parse().ok()).unwrap_or(50.0);
            p.teeth.brightness = std::env::var("T").ok().and_then(|v| v.parse().ok()).unwrap_or(15.0);
            p.eyes.both.iris = 10.0;
            p.eyes.both.sclera = 15.0;
            let t = Instant::now();
            let after = crate::portrait::apply_portraits(&img, &[p.clone()]);
            println!("retouch (all tools, first time, with the face parser) at 2048 px: {:.2} s", t.elapsed().as_secs_f32());
            let t = Instant::now();
            let _ = crate::portrait::apply_portraits(&img, &[p.clone()]);
            println!("retouch (all tools, parser remembered) at 2048 px: {:.2} s", t.elapsed().as_secs_f32());
            let mut s = p.clone();
            s.teeth = Default::default();
            s.eyes = Default::default();
            let t = Instant::now();
            let _ = crate::portrait::apply_portraits(&img, &[s]);
            println!("retouch (skin only) at 2048 px: {:.2} s", t.elapsed().as_secs_f32());
            let f = &faces[0];
            let (x, y, w, h) = ((f.x - f.w * 1.2).max(0.0) as u32, (f.y - f.h * 0.3).max(0.0) as u32, (f.w * 3.4) as u32, (f.h * 3.2) as u32);
            let (a, b) = (crop(&img, x, y, w, h), crop(&after, x, y, w, h));
            let mut both = RgbImage::new(a.width() * 2 + 8, a.height());
            image::imageops::replace(&mut both, &a, 0, 0);
            image::imageops::replace(&mut both, &b, a.width() as i64 + 8, 0);
            both.save(out.join(format!("{name}-retouch.png"))).unwrap();
        }
    }
}

#[cfg(test)]
mod advice_check {
    use image::RgbImage;
    use std::path::Path;

    #[test]
    #[ignore]
    fn what_the_exposure_suggestions_do_to_the_picture() {
        let (Ok(dir), Ok(out)) = (std::env::var("LUCENT_REAL_DIR"), std::env::var("LUCENT_REAL_OUT")) else { return };
        let img = crate::media::edited_picture(&Path::new(&dir).join("_MG_0031.CR2"), 700, None).unwrap().to_rgb8();
        let mut strip = RgbImage::new(img.width() * 3 + 16, img.height());
        for (i, ev) in [0.0f32, 1.1, 2.1].iter().enumerate() {
            let mut r = crate::develop::Recipe::default();
            r.exposure = *ev;
            let shown = crate::develop::render(&img, &r);
            image::imageops::replace(&mut strip, &shown, (i as u32 * (img.width() + 8)) as i64, 0);
        }
        std::fs::create_dir_all(&out).unwrap();
        strip.save(Path::new(&out).join("exposure-strip.png")).unwrap();
    }
}

#[cfg(test)]
mod face_finding_check {
    use std::path::Path;

    /// The same real photograph turned on its side, upside down, and cut so a face is half out of the frame.
    #[test]
    #[ignore]
    fn faces_that_are_turned_or_cut_by_the_frame_are_found_and_their_turn_is_read() {
        let (Ok(dir), Ok(names)) = (std::env::var("LUCENT_REAL_DIR"), std::env::var("LUCENT_REAL_NAMES")) else { return };
        for name in names.split(',') {
            let img = crate::media::edited_picture(&Path::new(&dir).join(format!("{name}.CR2")), 2048, None).unwrap().to_rgb8();
            let first = crate::faces::detect(&img).unwrap();
            println!("
=== {name}: upright {}", first.len());
            let Some(f) = first.first() else { continue };
            let cut = image::imageops::crop_imm(&img, (f.x + f.w * 0.45) as u32, 0, img.width() - (f.x + f.w * 0.45) as u32, img.height()).to_image();
            let variants = [
                ("upright", img.clone()),
                ("turned 90 clockwise", image::imageops::rotate90(&img)),
                ("upside down", image::imageops::rotate180(&img)),
                ("turned 90 counter-clockwise", image::imageops::rotate270(&img)),
                ("half the face cut off", cut),
            ];
            for (label, v) in variants {
                let t = std::time::Instant::now();
                let found = crate::faces::detect(&v).unwrap();
                print!("{label}: {} face(s) in {:.2} s", found.len(), t.elapsed().as_secs_f32());
                for f in &found {
                    let (roll, yaw, pitch) = crate::faces::orientation(&f.landmarks);
                    print!(" | score {:.2} roll {roll:.0} yaw {yaw:.0} pitch {pitch:.0}", f.score);
                }
                println!();
            }
        }
    }
}

#[cfg(test)]
mod headshot_check {
    use image::RgbImage;
    use std::path::Path;

    /// LUCENT_FILES=<a.jpg,b.jpg> LUCENT_REAL_OUT=<folder>: Auto retouch on any photographs, saved as a close before/after of the face.
    /// LUCENT_SKIN="blemishes,dark,amount,texture,tone,shine,colour,body" overrides what Auto retouch sets.
    #[test]
    #[ignore]
    fn auto_retouch_on_headshots_close_up() {
        let (Ok(files), Ok(out)) = (std::env::var("LUCENT_FILES"), std::env::var("LUCENT_REAL_OUT")) else { return };
        crate::portrait::USE_PARSER.store(true, std::sync::atomic::Ordering::Relaxed);
        std::fs::create_dir_all(&out).unwrap();
        let v: Vec<f32> = std::env::var("LUCENT_SKIN").ok().map(|s| s.split(',').filter_map(|t| t.trim().parse().ok()).collect()).unwrap_or_default();
        let g = |i: usize, d: f32| v.get(i).copied().unwrap_or(d);
        for file in files.split(',') {
            let path = Path::new(file);
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            let img = crate::media::edited_picture(path, 3000, None).unwrap().to_rgb8();
            let faces = crate::faces::detect(&img).unwrap();
            println!("{name}: {} x {}, {} face(s)", img.width(), img.height(), faces.len());
            let Some(f) = faces.first() else { continue };
            let mut p = crate::faces::to_portrait(f, img.width(), img.height());
            p.skin.blemishes = g(0, 55.0);
            p.skin.dark_circles = g(1, 25.0);
            p.skin.even_amount = g(2, 40.0);
            p.skin.even_texture = g(3, 75.0);
            p.skin.tone = g(4, 35.0);
            p.skin.shine = g(5, 30.0);
            p.skin.colour = g(6, 35.0);
            p.skin.body = g(7, 50.0);
            p.skin.glow = g(8, 25.0);
            p.skin.crisp = g(9, 20.0);
            p.teeth.brightness = 15.0;
            p.teeth.desaturation = 25.0;
            p.eyes.both.iris = 10.0;
            p.eyes.both.sclera = 15.0;
            p.lips = g(10, 15.0);
            p.brows = g(11, 10.0);
            let t = std::time::Instant::now();
            let after = crate::portrait::apply_portraits(&img, &[p]);
            println!("  retouch {:.2} s", t.elapsed().as_secs_f32());
            let (x, y) = ((f.x - f.w * 0.25).max(0.0) as u32, (f.y - f.h * 0.3).max(0.0) as u32);
            let (w, h) = (((f.w * 1.5) as u32).min(img.width() - x), ((f.h * 1.6) as u32).min(img.height() - y));
            let (a, b) = (image::imageops::crop_imm(&img, x, y, w, h).to_image(), image::imageops::crop_imm(&after, x, y, w, h).to_image());
            let mut both = RgbImage::new(w * 2 + 8, h);
            image::imageops::replace(&mut both, &a, 0, 0);
            image::imageops::replace(&mut both, &b, w as i64 + 8, 0);
            both.save(Path::new(&out).join(format!("{name}-face.png"))).unwrap();
            println!("  crop {x} {y} {w} {h}");
        }
    }
}

#[cfg(test)]
mod auto_face_check {
    use std::path::Path;

    /// Auto tone with and without the faces taken into account, on real photographs.
    #[test]
    #[ignore]
    fn auto_tone_aims_the_exposure_at_the_faces() {
        let (Ok(dir), Ok(names)) = (std::env::var("LUCENT_REAL_DIR"), std::env::var("LUCENT_REAL_NAMES")) else { return };
        for name in names.split(',') {
            let img = crate::media::edited_picture(&Path::new(&dir).join(format!("{name}.CR2")), 1600, None).unwrap().to_rgb8();
            let plain = crate::develop::auto_settings(&img);
            let t = std::time::Instant::now();
            let with_faces = crate::auto_for_picture(&img);
            println!("{name}: exposure {:+.2} without faces, {:+.2} with them ({:.2} s)", plain.exposure, with_faces.exposure, t.elapsed().as_secs_f32());
        }
    }
}

#[cfg(test)]
mod hostile_files {
    use std::path::Path;

    /// A small repeatable random number maker, so a failure can be run again.
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n.max(1) as u64) as usize
        }
    }

    /// A damaged copy of `bytes`: cut short, bytes flipped, a stretch zeroed or filled with 0xFF, or a block repeated.
    fn damage(bytes: &[u8], rng: &mut Rng) -> Vec<u8> {
        let mut v = bytes.to_vec();
        match rng.below(6) {
            0 => v.truncate(rng.below(v.len())),
            1 => (0..1 + rng.below(40)).for_each(|_| {
                let i = rng.below(v.len());
                v[i] ^= 1 << rng.below(8);
            }),
            // the header is where the sizes and offsets are: most of the damage goes there
            2 => (0..1 + rng.below(30)).for_each(|_| {
                let i = rng.below(v.len().min(4096));
                v[i] = rng.next() as u8;
            }),
            3 => {
                let (a, n) = (rng.below(v.len()), rng.below(5000));
                v.iter_mut().skip(a).take(n).for_each(|b| *b = 0);
            }
            4 => {
                let (a, n) = (rng.below(v.len().min(8192)), rng.below(64));
                v.iter_mut().skip(a).take(n).for_each(|b| *b = 0xFF);
            }
            _ => {
                let (a, n) = (rng.below(v.len()), rng.below(20_000));
                let block: Vec<u8> = v.iter().skip(a).take(n).copied().collect();
                v.extend(block);
            }
        }
        v
    }

    /// LUCENT_FUZZ_FILES=<a.cr2,b.jpg,...> LUCENT_FUZZ_N=<how many damaged copies of each>: damaged photographs must be refused
    /// or decoded, never crash the program, hang it or make it ask for an absurd amount of memory.
    #[test]
    #[ignore]
    fn damaged_photographs_are_refused_not_crashed_on() {
        let Ok(files) = std::env::var("LUCENT_FUZZ_FILES") else { return };
        let n: usize = std::env::var("LUCENT_FUZZ_N").ok().and_then(|v| v.parse().ok()).unwrap_or(40);
        let dir = std::env::temp_dir().join("lucent-fuzz");
        std::fs::create_dir_all(&dir).unwrap();
        let mut rng = Rng(0x9E3779B97F4A7C15);
        let (mut panics, mut slow, mut opened, mut refused) = (0, 0, 0, 0);
        for file in files.split(',') {
            let bytes = std::fs::read(file).unwrap();
            let ext = Path::new(file).extension().unwrap().to_string_lossy().to_string();
            for k in 0..n {
                let path = dir.join(format!("f{k}.{ext}"));
                std::fs::write(&path, damage(&bytes, &mut rng)).unwrap();
                let t = std::time::Instant::now();
                let p = path.clone();
                let r = std::panic::catch_unwind(move || {
                    let _ = crate::media::read_meta(&p);
                    let _ = crate::media::fingerprint(&p);
                    let _ = crate::media::source_thumb(&p, 240);
                    crate::media::edited_picture(&p, 400, None).is_ok()
                });
                let secs = t.elapsed().as_secs_f32();
                match r {
                    Ok(true) => opened += 1,
                    Ok(false) => refused += 1,
                    Err(_) => {
                        panics += 1;
                        let keep = dir.join(format!("PANIC-{}-{k}.{ext}", Path::new(file).file_stem().unwrap().to_string_lossy()));
                        let _ = std::fs::copy(&path, &keep);
                        println!("PANIC on damaged copy {k} of {file} (kept as {})", keep.display());
                    }
                }
                if secs > 20.0 {
                    slow += 1;
                    println!("SLOW: {secs:.1} s on damaged copy {k} of {file}");
                }
            }
            println!("{file}: done");
        }
        println!("damaged files: {opened} still opened, {refused} refused, {panics} panicked, {slow} took over 20 s");
    }

    /// Damaged sidecars and hostile text must be refused or read, never crash.
    #[test]
    fn damaged_sidecars_are_refused_not_crashed_on() {
        let good = crate::xmp::write(&crate::xmp::Sidecar::default());
        let mut rng = Rng(0xD1B54A32D192ED03);
        for _ in 0..400 {
            let bad = damage(good.as_bytes(), &mut rng);
            let _ = crate::xmp::parse(&String::from_utf8_lossy(&bad));
        }
        for hostile in ["", "<", "<x:xmpmeta", &"<a>".repeat(100_000), &"&".repeat(50_000), "<?xml version=\"1.0\"?><!DOCTYPE x [<!ENTITY a \"aaaaaaaaaa\"><!ENTITY b \"&a;&a;&a;&a;&a;&a;&a;&a;\">]><x>&b;</x>"] {
            let _ = crate::xmp::parse(hostile);
        }
    }
}
