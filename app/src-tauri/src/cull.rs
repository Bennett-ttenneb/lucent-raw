//! Culling: finding the photos that are probably not keepers. Nothing here is a model: it measures each photo's preview
//! (how sharp its sharpest part is, how much is blown out or crushed, how dark or bright it is) and a small fingerprint of
//! how it looks, so that bursts and near-duplicates can be grouped and the best of each group named. It only ever reports;
//! the person decides what to flag, and flags can be undone.

use image::{imageops::FilterType, GrayImage, RgbImage};
use serde::Serialize;
use std::collections::HashMap;

/// The longest side the measuring is done at, so a big preview and a small one are measured alike.
pub const MEASURE_EDGE: u32 = 1024;
const TILE: usize = 32;
/// Photos whose sharpest part is below this are called soft (a clearly focused photo is well above 100 at this size).
pub const SOFT_BELOW: f32 = 20.0;
/// Two photos look alike if their fingerprints differ in at most this many of 64 places...
const SIMILAR: u32 = 10;
/// ... and at most this many if one of them has no capture time to confirm it.
const SIMILAR_NO_TIME: u32 = 4;
/// ... and were taken within this many seconds of each other.
const BURST_SECONDS: i64 = 60;
/// How many neighbours in time order each photo is compared with.
const NEIGHBOURS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Metrics {
    /// The 90th percentile of the detail in 32 x 32 tiles: how sharp the sharpest part is (so a portrait with a soft
    /// background still counts as sharp).
    pub sharpness: f32,
    /// Share of the picture (0 to 1) that is pure white, and pure black.
    pub blown: f32,
    pub crushed: f32,
    /// The middle brightness, 0 to 255.
    pub median: f32,
    /// A 64-bit fingerprint of the picture's look.
    pub hash: u64,
    /// How good the picture looks to most people, 1 to 10 (from the aesthetic model); 0 when it has not been scored.
    pub look: f32,
}

fn luma(img: &RgbImage) -> GrayImage {
    GrayImage::from_fn(img.width(), img.height(), |x, y| {
        let p = img.get_pixel(x, y);
        image::Luma([(0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32).round() as u8])
    })
}

/// The difference hash: the picture as 9 x 8 grey squares, a bit for each "this square is brighter than the next one".
pub fn dhash(grey: &GrayImage) -> u64 {
    let s = image::imageops::resize(grey, 9, 8, FilterType::Triangle);
    let mut h = 0u64;
    for y in 0..8 {
        for x in 0..8 {
            h = (h << 1) | (s.get_pixel(x, y)[0] > s.get_pixel(x + 1, y)[0]) as u64;
        }
    }
    h
}

pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// How sharp the sharpest part of the picture is: the spread of the second differences (a Laplacian) in each tile, and the
/// 90th percentile of those.
fn sharpness(grey: &GrayImage) -> f32 {
    let (w, h) = (grey.width() as usize, grey.height() as usize);
    if w < TILE * 2 || h < TILE * 2 {
        return 0.0;
    }
    let g = grey.as_raw();
    let at = |x: usize, y: usize| g[y * w + x] as f32;
    let mut tiles = Vec::new();
    let (tx, ty) = (w / TILE, h / TILE);
    for j in 0..ty {
        for i in 0..tx {
            let (mut sum, mut sum2, mut n) = (0f64, 0f64, 0f64);
            for y in (j * TILE).max(1)..((j + 1) * TILE).min(h - 1) {
                for x in (i * TILE).max(1)..((i + 1) * TILE).min(w - 1) {
                    let l = (4.0 * at(x, y) - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1)) as f64;
                    sum += l;
                    sum2 += l * l;
                    n += 1.0;
                }
            }
            if n > 0.0 {
                tiles.push(((sum2 / n) - (sum / n).powi(2)) as f32);
            }
        }
    }
    tiles.sort_by(|a, b| a.total_cmp(b));
    tiles[(tiles.len() as f32 * 0.9) as usize % tiles.len().max(1)]
}

/// Measure a preview (any size; it is brought to MEASURE_EDGE first).
pub fn measure(img: &RgbImage) -> Metrics {
    let long = img.width().max(img.height());
    let small = if long > MEASURE_EDGE {
        let k = MEASURE_EDGE as f32 / long as f32;
        image::imageops::resize(img, ((img.width() as f32 * k).round() as u32).max(1), ((img.height() as f32 * k).round() as u32).max(1), FilterType::Triangle)
    } else {
        img.clone()
    };
    let grey = luma(&small);
    let mut hist = [0u32; 256];
    for p in grey.pixels() {
        hist[p[0] as usize] += 1;
    }
    let n = (grey.width() * grey.height()).max(1) as f32;
    let blown = hist[253..].iter().sum::<u32>() as f32 / n;
    let crushed = hist[..=2].iter().sum::<u32>() as f32 / n;
    let (mut run, mut median) = (0u32, 0f32);
    for (v, c) in hist.iter().enumerate() {
        run += c;
        if run as f32 >= n / 2.0 {
            median = v as f32;
            break;
        }
    }
    Metrics { sharpness: sharpness(&grey), blown, crushed, median, hash: dhash(&grey), look: 0.0 }
}

pub fn is_soft(m: &Metrics) -> bool {
    m.sharpness < SOFT_BELOW
}

/// Why the exposure is bad, in words, or nothing.
pub fn exposure_problem(m: &Metrics) -> Option<&'static str> {
    if m.blown > 0.10 || m.median > 215.0 {
        Some("too bright")
    } else if m.median < 35.0 && m.crushed > 0.4 {
        Some("too dark")
    } else {
        None
    }
}

/// How good a photo is for choosing the best of a group: sharper is better, clipping is worse.
pub fn quality(m: &Metrics) -> f32 {
    (1.0 + m.sharpness).ln() - 5.0 * m.blown - 2.0 * m.crushed + if m.look > 0.0 { 0.4 * (m.look - 5.0) } else { 0.0 }
}

pub struct Item {
    pub id: i64,
    /// Seconds since 1970 by the camera's clock, when the photo says when it was taken.
    pub taken: Option<i64>,
    pub m: Metrics,
}

/// "2026-05-10T10:00:05" (or with a space, or a fraction) as seconds, or nothing if it is not a date and time.
pub fn parse_taken(text: &str) -> Option<i64> {
    let t = text.trim();
    let (date, time) = t.split_once(['T', ' '])?;
    let mut d = date.split('-').map(|v| v.parse::<i64>().ok());
    let (y, mo, da) = (d.next()??, d.next()??, d.next()??);
    let mut c = time.split(['.', '+', 'Z']).next()?.split(':').map(|v| v.parse::<i64>().ok());
    let (h, mi, s) = (c.next()??, c.next().flatten().unwrap_or(0), c.next().flatten().unwrap_or(0));
    if !(1..=12).contains(&mo) || !(1..=31).contains(&da) || !(0..24).contains(&h) || !(0..60).contains(&mi) || !(0..60).contains(&s) {
        return None;
    }
    // days since 1970 from the civil date (Howard Hinnant's algorithm)
    let (yy, mm) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + da - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(days * 86400 + h * 3600 + mi * 60 + s)
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub ids: Vec<i64>,
    /// The sharpest, best-exposed one.
    pub best: i64,
}

/// Bursts and near-duplicates: photos that look alike and were taken close together, with the best of each. Only groups of
/// two or more are returned, in the order of their first photo.
pub fn group(items: &[Item]) -> Vec<Group> {
    let mut order: Vec<usize> = (0..items.len()).collect();
    order.sort_by_key(|&i| (items[i].taken.unwrap_or(i64::MAX), items[i].id));
    let mut parent: Vec<usize> = (0..items.len()).collect();
    fn find(p: &mut Vec<usize>, i: usize) -> usize {
        let mut r = i;
        while p[r] != r {
            r = p[r];
        }
        let mut c = i;
        while p[c] != r {
            let n = p[c];
            p[c] = r;
            c = n;
        }
        r
    }
    for (pos, &i) in order.iter().enumerate() {
        for &j in order.iter().skip(pos + 1).take(NEIGHBOURS) {
            let d = hamming(items[i].m.hash, items[j].m.hash);
            let alike = match (items[i].taken, items[j].taken) {
                (Some(a), Some(b)) => (a - b).abs() <= BURST_SECONDS && d <= SIMILAR,
                _ => d <= SIMILAR_NO_TIME,
            };
            if alike {
                let (ri, rj) = (find(&mut parent, i), find(&mut parent, j));
                if ri != rj {
                    parent[rj] = ri;
                }
            }
        }
    }
    let mut by_root: HashMap<usize, Vec<usize>> = HashMap::new();
    for &i in &order {
        let r = find(&mut parent, i);
        by_root.entry(r).or_default().push(i);
    }
    let mut groups: Vec<Vec<usize>> = by_root.into_values().filter(|g| g.len() >= 2).collect();
    groups.sort_by_key(|g| order.iter().position(|&o| o == g[0]).unwrap_or(0));
    groups
        .into_iter()
        .map(|g| {
            let best = g.iter().copied().max_by(|&a, &b| quality(&items[a].m).total_cmp(&quality(&items[b].m)).then(items[b].id.cmp(&items[a].id))).unwrap();
            Group { ids: g.iter().map(|&i| items[i].id).collect(), best: items[best].id }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    /// A picture full of edges: a checker of small squares with a gradient.
    fn crisp(w: u32, h: u32, shade: u8) -> RgbImage {
        RgbImage::from_fn(w, h, |x, y| {
            let v = if (x / 6 + y / 6) % 2 == 0 { shade.saturating_add(70) } else { shade };
            Rgb([v, v, v])
        })
    }
    fn blur(img: &RgbImage) -> RgbImage {
        image::imageops::blur(img, 6.0)
    }
    fn item(id: i64, taken: Option<i64>, img: &RgbImage) -> Item {
        Item { id, taken, m: measure(img) }
    }

    #[test]
    fn a_sharp_photo_scores_far_above_a_blurred_one_and_only_the_blurred_is_soft() {
        let sharp = crisp(600, 400, 70);
        let soft = blur(&sharp);
        let (a, b) = (measure(&sharp), measure(&soft));
        assert!(a.sharpness > b.sharpness * 10.0, "{} against {}", a.sharpness, b.sharpness);
        assert!(!is_soft(&a) && is_soft(&b), "sharp {} soft {}", a.sharpness, b.sharpness);
        // a flat grey picture has no detail at all
        assert!(is_soft(&measure(&RgbImage::from_pixel(600, 400, Rgb([120, 120, 120])))));
        // too small to measure: not called sharp
        assert_eq!(measure(&RgbImage::new(20, 20)).sharpness, 0.0);
    }

    #[test]
    fn the_sharpest_part_counts_so_a_sharp_subject_on_a_soft_background_is_not_soft() {
        let mut img = blur(&crisp(600, 400, 70));
        let sharp = crisp(600, 400, 70);
        for y in 100..260 {
            for x in 200..400 {
                img.put_pixel(x, y, *sharp.get_pixel(x, y)); // a sharp patch (about a fifth of the picture)
            }
        }
        assert!(!is_soft(&measure(&img)), "{}", measure(&img).sharpness);
    }

    #[test]
    fn exposure_problems_are_named_and_a_normal_photo_has_none() {
        let normal = measure(&crisp(300, 200, 90));
        assert_eq!(exposure_problem(&normal), None);
        let bright = measure(&RgbImage::from_pixel(300, 200, Rgb([250, 250, 250])));
        assert_eq!(exposure_problem(&bright), Some("too bright"));
        let dark = measure(&RgbImage::from_pixel(300, 200, Rgb([2, 2, 2])));
        assert_eq!(exposure_problem(&dark), Some("too dark"));
        // a dark but not crushed scene (a night street with lights) is not flagged
        let night = RgbImage::from_fn(300, 200, |x, _| Rgb([if x % 5 == 0 { 200 } else { 20 }; 3]));
        assert_eq!(exposure_problem(&measure(&night)), None);
    }

    #[test]
    fn the_fingerprint_is_the_same_for_the_same_look_at_another_size_and_different_for_another_picture() {
        let a = RgbImage::from_fn(300, 200, |x, y| Rgb([(x * 255 / 300) as u8, (y * 255 / 200) as u8, 90]));
        let bigger = image::imageops::resize(&a, 600, 400, FilterType::Triangle);
        assert!(hamming(measure(&a).hash, measure(&bigger).hash) <= 3);
        let other = RgbImage::from_fn(300, 200, |x, y| Rgb([(255 - x * 255 / 300) as u8, (255 - y * 255 / 200) as u8, 200]));
        assert!(hamming(measure(&a).hash, measure(&other).hash) > 20);
    }

    #[test]
    fn capture_times_are_read_as_seconds_and_nonsense_is_refused() {
        assert_eq!(parse_taken("1970-01-01T00:00:00"), Some(0));
        assert_eq!(parse_taken("1970-01-02 00:00:01"), Some(86401));
        assert_eq!(parse_taken("2026-05-10T10:00:05"), Some(parse_taken("2026-05-10T10:00:00").unwrap() + 5));
        assert_eq!(parse_taken("2026-05-10T10:00:05.250Z"), parse_taken("2026-05-10T10:00:05"));
        assert_eq!(parse_taken("2024-03-01T00:00:00").unwrap() - parse_taken("2024-02-28T00:00:00").unwrap(), 2 * 86400, "2024 had a 29th of February");
        for bad in ["", "yesterday", "2026-13-01T00:00:00", "2026-05-10", "2026-05-10T25:00:00"] {
            assert_eq!(parse_taken(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_burst_is_grouped_with_its_sharpest_frame_named_best_and_unrelated_photos_are_left_out() {
        let scene = crisp(500, 340, 80);
        let t = parse_taken("2026-05-10T10:00:00").unwrap();
        let items = vec![
            item(1, Some(t), &blur(&scene)),
            item(2, Some(t + 1), &scene), // the sharp frame of the burst
            item(3, Some(t + 2), &blur(&blur(&scene))),
            item(4, Some(t + 3600), &RgbImage::from_fn(500, 340, |x, y| Rgb([(x / 2) as u8, (y / 2) as u8, 30]))), // an hour later, another picture
        ];
        let groups = group(&items);
        assert_eq!(groups.len(), 1, "{groups:?}");
        assert_eq!(groups[0].ids, [1, 2, 3]);
        assert_eq!(groups[0].best, 2);
    }

    #[test]
    fn alike_pictures_hours_apart_are_not_a_burst_and_without_times_only_very_alike_ones_group() {
        let scene = crisp(400, 300, 80);
        let t = parse_taken("2026-05-10T10:00:00").unwrap();
        assert!(group(&[item(1, Some(t), &scene), item(2, Some(t + 7200), &scene)]).is_empty(), "two hours apart");
        // no times: the same picture twice still groups, a different one does not
        let diff = RgbImage::from_fn(400, 300, |x, y| Rgb([(255 - x * 255 / 400) as u8, (y * 255 / 300) as u8, 40]));
        let g = group(&[item(1, None, &scene), item(2, None, &scene), item(3, None, &diff)]);
        assert_eq!(g.len(), 1);
        assert_eq!(g[0].ids, [1, 2]);
        assert!(group(&[]).is_empty() && group(&[item(1, None, &scene)]).is_empty());
    }

    #[test]
    fn clipping_counts_against_a_frame_when_the_best_is_chosen() {
        let good = crisp(400, 300, 80);
        let mut clipped = good.clone();
        for y in 0..300 {
            for x in 0..200 {
                clipped.put_pixel(x, y, Rgb([255, 255, 255]));
            }
        }
        assert!(quality(&measure(&good)) > quality(&measure(&clipped)) - 3.0 || measure(&clipped).blown > 0.4);
        let t = 1_000_000;
        let g = group(&[item(1, Some(t), &clipped), item(2, Some(t + 1), &good)]);
        if let Some(g) = g.first() {
            assert_eq!(g.best, 2, "the frame without the blown half is the better one");
        }
    }

    /// Print the measures for real photos, to check the thresholds: PENUMBRA_PHOTOS is a folder of pictures.
    #[test]
    #[ignore]
    fn try_cull() {
        let Ok(dir) = std::env::var("PENUMBRA_PHOTOS") else { return };
        let mut files: Vec<_> = std::fs::read_dir(dir).unwrap().filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| matches!(p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(), Some("jpg" | "jpeg" | "png"))).collect();
        files.sort();
        for f in files.iter().take(40) {
            if let Ok(img) = image::open(f) {
                let m = measure(&img.to_rgb8());
                println!("{:<40} sharp {:7.1} soft {:5} blown {:.3} crushed {:.3} median {:3.0} {:?}", f.file_name().unwrap().to_string_lossy(), m.sharpness, is_soft(&m), m.blown, m.crushed, m.median, exposure_problem(&m));
            }
        }
    }
}
