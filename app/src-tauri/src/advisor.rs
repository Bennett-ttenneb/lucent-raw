//! The skin-tone assistant and the photo suggestions. Nothing here is a trained model: it measures the picture (the colour of
//! the skin on the faces found, how light the picture is, how much is blown out or crushed, how flat or colourless it is) and
//! works out how much of each setting would put the measure right, by trying the real tone settings on the measured pixels.
//! It suggests; the person decides, and everything it applies is one step in the history that can be undone.

use crate::develop::{self, Recipe};
use crate::faces::Face;
use image::RgbImage;
use serde::Serialize;

/// One setting and the value to give it (the value it would have after the suggestion, not the change).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Change {
    pub field: String,
    pub value: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// "skin-cast", "skin-light", "skin-colour", "exposure", "highlights", "shadows", "contrast", "balance", "vibrance"
    pub id: String,
    pub title: String,
    /// What was measured, in words.
    pub why: String,
    pub changes: Vec<Change>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skin {
    /// How many pixels of skin were measured, and on how many faces.
    pub pixels: usize,
    pub faces: usize,
    /// CIE lightness 0 to 100, hue in degrees (about 40 to 60 is healthy skin) and chroma.
    pub lightness: f32,
    pub hue: f32,
    pub chroma: f32,
    pub verdict: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Advice {
    pub faces: usize,
    pub skin: Option<Skin>,
    pub items: Vec<Suggestion>,
    /// How good the picture looks to most people, 1 to 10 (about 5 is ordinary); a rough guide, left out when it could not be scored.
    pub look: Option<f32>,
}

/// Hue range, in degrees of CIE hue, that skin of every complexion sits in when the picture's colour is right: from the red
/// edge to the yellow edge. Outside it the picture has a cast.
const HUE_LOW: f32 = 36.0;
const HUE_HIGH: f32 = 64.0;
const HUE_AIM: f32 = 48.0;
const MAX_SAMPLES: usize = 6000;

fn srgb_lin(v: u8) -> f32 {
    let c = v as f32 / 255.0;
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// CIE L*a*b* (D65) of an sRGB pixel.
pub fn lab(p: [u8; 3]) -> [f32; 3] {
    let (r, g, b) = (srgb_lin(p[0]), srgb_lin(p[1]), srgb_lin(p[2]));
    let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
    let f = |t: f32| if t > 0.008856 { t.cbrt() } else { 7.787 * t + 16.0 / 116.0 };
    let (fx, fy, fz) = (f(x), f(y), f(z));
    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

fn hue_chroma(a: f32, b: f32) -> (f32, f32) {
    ((b.atan2(a).to_degrees() + 360.0) % 360.0, (a * a + b * b).sqrt())
}

/// Is this pixel plausibly skin: the usual YCbCr box, not blown out and not black. Lips, eyes, hair and the background
/// mostly fall outside it; what gets through is taken as the median, so a few strays do not matter.
pub fn is_skin(p: [u8; 3]) -> bool {
    let (r, g, b) = (p[0] as f32, p[1] as f32, p[2] as f32);
    let cb = 128.0 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    let cr = 128.0 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    let top = p[0].max(p[1]).max(p[2]);
    (77.0..=127.0).contains(&cb) && (133.0..=173.0).contains(&cr) && r > g && g > b * 0.8 && top < 250 && top > 40
}

/// The skin pixels inside the middle of each face: between the eyebrows and the chin, and not the outer fifth on each side.
pub fn skin_pixels(img: &RgbImage, faces: &[Face]) -> Vec<[u8; 3]> {
    let mut out = Vec::new();
    let (w, h) = (img.width() as f32, img.height() as f32);
    for f in faces {
        let (x0, x1) = ((f.x + 0.2 * f.w).max(0.0), (f.x + 0.8 * f.w).min(w - 1.0));
        let (y0, y1) = ((f.y + 0.2 * f.h).max(0.0), (f.y + 0.92 * f.h).min(h - 1.0));
        if x1 <= x0 || y1 <= y0 {
            continue;
        }
        // at most about MAX_SAMPLES / faces pixels from each, evenly spread
        let budget = (MAX_SAMPLES / faces.len().max(1)).max(200) as f32;
        let step = (((x1 - x0) * (y1 - y0) / budget).sqrt()).max(1.0);
        let mut y = y0;
        while y < y1 {
            let mut x = x0;
            while x < x1 {
                let p = img.get_pixel(x as u32, y as u32).0;
                if is_skin(p) {
                    out.push(p);
                }
                x += step;
            }
            y += step;
        }
    }
    out
}

fn median(mut v: Vec<f32>) -> f32 {
    v.sort_by(|a, b| a.total_cmp(b));
    v[v.len() / 2]
}

/// The median skin colour as (lightness, hue, chroma). Hue is taken from the median a and b, so it does not jump at 0/360.
pub fn skin_colour(samples: &[[u8; 3]]) -> Option<(f32, f32, f32)> {
    if samples.len() < 30 {
        return None;
    }
    let labs: Vec<[f32; 3]> = samples.iter().map(|p| lab(*p)).collect();
    let l = median(labs.iter().map(|c| c[0]).collect());
    let a = median(labs.iter().map(|c| c[1]).collect());
    let b = median(labs.iter().map(|c| c[2]).collect());
    let (hue, chroma) = hue_chroma(a, b);
    Some((l, hue, chroma))
}

fn sample_image(samples: &[[u8; 3]]) -> RgbImage {
    RgbImage::from_fn(samples.len() as u32, 1, |x, _| image::Rgb(samples[x as usize]))
}

fn with(mut r: Recipe, f: impl FnOnce(&mut Recipe)) -> Recipe {
    f(&mut r);
    r
}

/// The skin colour after trying these extra settings on top of what the picture already has.
fn tried(samples: &RgbImage, extra: &Recipe) -> (f32, f32, f32) {
    let out = develop::apply_tone(samples, extra);
    let px: Vec<[u8; 3]> = out.pixels().map(|p| p.0).collect();
    skin_colour(&px).unwrap_or((0.0, 0.0, 0.0))
}

fn clamp100(v: f32) -> f32 {
    v.clamp(-100.0, 100.0).round()
}

fn change(field: &str, value: f32) -> Change {
    Change { field: field.into(), value }
}

/// What to say, and what to change, about skin of this colour. `current` is the recipe the picture was drawn with.
pub fn skin_advice(samples: &[[u8; 3]], faces: usize, current: &Recipe) -> (Option<Skin>, Vec<Suggestion>) {
    let Some((l, hue, chroma)) = skin_colour(samples) else { return (None, vec![]) };
    let mut items = Vec::new();
    let mut notes: Vec<&str> = Vec::new();
    let img = sample_image(samples);

    // a colour cast: skin whose hue is outside the healthy range. Try warmth and tint together and keep the smallest
    // change that brings the hue back to the aim.
    if hue < HUE_LOW || hue > HUE_HIGH {
        let aim = if hue < HUE_LOW { HUE_AIM } else { HUE_AIM + 4.0 };
        let mut best: Option<(f32, f32, f32)> = None;
        for temp in (-50i32..=50).step_by(5) {
            for tint in (-40i32..=40).step_by(4) {
                let r = with(Recipe::default(), |r| {
                    r.temperature = temp as f32;
                    r.tint = tint as f32;
                });
                let (_, h, c) = tried(&img, &r);
                // distance round the circle, plus a small price for every step of change
                let miss = ((h - aim + 540.0) % 360.0 - 180.0).abs();
                // a change that makes the colour garish is not a fix, so strength over 40 is charged for
                let cost = miss + 0.08 * (temp.abs() + tint.abs()) as f32 + (c - 40.0).max(0.0) * 1.5;
                if best.map_or(true, |b| cost < b.0) {
                    best = Some((cost, temp as f32, tint as f32));
                }
            }
        }
        if let Some((_, dt, dn)) = best {
            if dt != 0.0 || dn != 0.0 {
                let (t, n) = (clamp100(current.temperature + dt), clamp100(current.tint + dn));
                let word = if hue < HUE_LOW { "too red or pink" } else { "too yellow or green" };
                notes.push(if hue < HUE_LOW { "a little too red" } else { "a little too yellow" });
                items.push(Suggestion {
                    id: "skin-cast".into(),
                    title: if hue < HUE_LOW { "Take the red out of the skin" } else { "Take the yellow out of the skin" }.into(),
                    why: format!("The skin measures {word}: its hue is {hue:.0} degrees, and healthy skin sits between {HUE_LOW:.0} and {HUE_HIGH:.0}."),
                    changes: vec![change("temperature", t), change("tint", n)],
                });
            }
        }
    }

    // skin that is too dark or too bright to show its colour (very dark skin is not "wrong": only a face that is nearly black
    // or nearly white is offered a change)
    if l < 32.0 || l > 88.0 {
        let aim = if l < 32.0 { 42.0 } else { 80.0 };
        let mut best = (f32::MAX, 0.0);
        for step in -30..=30 {
            let e = step as f32 * 0.1;
            let (lt, _, _) = tried(&img, &with(Recipe::default(), |r| r.exposure = e));
            let cost = (lt - aim).abs() + 1.5 * e.abs();
            if cost < best.0 {
                best = (cost, e);
            }
        }
        if best.1.abs() >= 0.2 {
            notes.push(if l < 32.0 { "dark" } else { "very bright" });
            items.push(Suggestion {
                id: "skin-light".into(),
                title: if l < 32.0 { "Brighten the faces" } else { "Bring the bright faces down" }.into(),
                why: format!("The skin's lightness is {l:.0} out of 100, so detail in the faces is {}.", if l < 32.0 { "hard to see" } else { "close to being lost" }),
                changes: vec![change("exposure", (current.exposure + best.1).clamp(-5.0, 5.0))],
            });
        }
    }

    // colour that is too strong or too faint
    if chroma > 40.0 || chroma < 9.0 {
        let aim = if chroma > 40.0 { 32.0 } else { 16.0 };
        let mut best = (f32::MAX, 0.0);
        for v in (-60i32..=60).step_by(5) {
            let (_, _, c) = tried(&img, &with(Recipe::default(), |r| r.vibrance = v as f32));
            let cost = (c - aim).abs() + 0.05 * (v as f32).abs();
            if cost < best.0 {
                best = (cost, v as f32);
            }
        }
        if best.1.abs() >= 5.0 {
            notes.push(if chroma > 40.0 { "over-coloured" } else { "washed out" });
            items.push(Suggestion {
                id: "skin-colour".into(),
                title: if chroma > 40.0 { "Calm the skin colour" } else { "Bring some colour back to the skin" }.into(),
                why: format!("The skin's colour strength is {chroma:.0}; natural skin is usually between 10 and 38."),
                changes: vec![change("vibrance", clamp100(current.vibrance + best.1))],
            });
        }
    }

    let verdict = if notes.is_empty() { "The skin tones look natural.".to_string() } else { format!("The skin looks {}.", notes.join(" and ")) };
    (Some(Skin { pixels: samples.len(), faces, lightness: l, hue, chroma, verdict }), items)
}

/// The luma (0 to 255) of every pixel, as a histogram.
fn luma_histogram(img: &RgbImage) -> [u32; 256] {
    let mut h = [0u32; 256];
    for p in img.pixels() {
        let y = (0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32).round() as usize;
        h[y.min(255)] += 1;
    }
    h
}

fn percentile(h: &[u32; 256], share: f32) -> usize {
    let total: u32 = h.iter().sum();
    let goal = (total as f32 * share) as u32;
    let mut run = 0;
    for (v, n) in h.iter().enumerate() {
        run += n;
        if run >= goal {
            return v;
        }
    }
    255
}

/// Suggestions about the whole picture. `skin_found` keeps the white balance out of it: with skin to go by, the skin
/// assistant is the judge of colour, and grey-world would only argue with it.
pub fn photo_advice(img: &RgbImage, current: &Recipe, skin_found: bool) -> Vec<Suggestion> {
    let mut items = Vec::new();
    let n = (img.width() * img.height()).max(1) as f32;
    let h = luma_histogram(img);
    let median = percentile(&h, 0.5) as f32;
    let (p1, p5, p95, p99) = (percentile(&h, 0.01) as f32, percentile(&h, 0.05) as f32, percentile(&h, 0.95) as f32, percentile(&h, 0.99) as f32);
    let blown = h[253..].iter().sum::<u32>() as f32 / n;
    let crushed = h[..=2].iter().sum::<u32>() as f32 / n;

    // brightness. The aim is 105 out of 255 and a picture is only called too dark or too bright when it is well away from it and
    // nothing in it argues the other way: a dark picture with bright lights in it (a night scene) or a bright one with real
    // blacks in it (a high-key portrait) is the photographer's choice. The numbers come from a check against 24 finished,
    // freely licensed photographs (see build-log.md): their middle tones ran from 35 to 205 with a middle of 104, so the old
    // aim of 118 and a limit of 0.3 stops called about half of them wrong.
    let stops = (105.0f32 / median.max(8.0)).log2();
    let too_dark = stops >= 0.6 && p95 < 130.0;
    let too_bright = stops <= -0.6 && p5 > 40.0;
    if (too_dark || too_bright) && blown < 0.05 {
        let e = (stops * 0.8).clamp(-1.5, 1.5);
        items.push(Suggestion {
            id: "exposure".into(),
            title: if e > 0.0 { "Brighten the picture" } else { "Darken the picture" }.into(),
            why: format!("The middle tone of the picture is {median:.0} out of 255, {}.", if e > 0.0 { "so it is on the dark side" } else { "so it is on the bright side" }),
            changes: vec![change("exposure", ((current.exposure + e) * 10.0).round() / 10.0)],
        });
    }
    if blown > 0.02 {
        items.push(Suggestion {
            id: "highlights".into(),
            title: "Recover the bright parts".into(),
            why: format!("{:.1}% of the picture is pure white, so detail there is lost.", blown * 100.0),
            changes: vec![change("highlights", clamp100(current.highlights - 35.0))],
        });
    }
    // more than two fifths black is a black background, not lost shadows
    if crushed > 0.05 && crushed < 0.4 {
        items.push(Suggestion {
            id: "shadows".into(),
            title: "Open up the dark parts".into(),
            why: format!("{:.1}% of the picture is pure black, so detail there is lost.", crushed * 100.0),
            changes: vec![change("shadows", clamp100(current.shadows + 30.0))],
        });
    }
    // contrast: tones squeezed into a narrow band look flat
    if p95 - p5 < 105.0 {
        items.push(Suggestion {
            id: "contrast".into(),
            title: "Add some contrast".into(),
            why: format!("Nearly all the picture lies between {p5:.0} and {p95:.0} out of 255, which looks flat."),
            changes: vec![change("contrast", clamp100(current.contrast + 20.0)), change("blacks", clamp100(current.blacks - if p1 > 12.0 { 15.0 } else { 0.0 })), change("whites", clamp100(current.whites + if p99 < 235.0 { 15.0 } else { 0.0 }))],
        });
    }

    // colour strength, measured first because it also decides whether the balance is judged
    let mut sat = 0f64;
    for p in img.pixels() {
        let (mx, mn) = (p[0].max(p[1]).max(p[2]) as f64, p[0].min(p[1]).min(p[2]) as f64);
        sat += if mx > 0.0 { (mx - mn) / mx } else { 0.0 };
    }
    let sat = (sat / n as f64) as f32;

    // colour balance: grey-world over the middle tones, only when no skin is there to judge by, and only for a picture that is not
    // colourful: the method assumes the colours average out to grey, which a field of flowers or a sunset does not
    if !skin_found && sat < 0.30 {
        let (mut sr, mut sg, mut sb, mut c) = (0f64, 0f64, 0f64, 0u64);
        for p in img.pixels() {
            let y = 0.2126 * p[0] as f32 + 0.7152 * p[1] as f32 + 0.0722 * p[2] as f32;
            if (50.0..200.0).contains(&y) {
                sr += p[0] as f64;
                sg += p[1] as f64;
                sb += p[2] as f64;
                c += 1;
            }
        }
        if c as f32 > n * 0.2 {
            let (mr, mg, mb) = (sr / c as f64, sg / c as f64, sb / c as f64);
            let warm = ((mr - mb) / (mr + mb).max(1.0)) as f32; // red against blue: positive is warm
            let tint = ((mg - (mr + mb) / 2.0) / (mg + (mr + mb) / 2.0).max(1.0)) as f32; // green against magenta
            if warm.abs() > 0.15 || tint.abs() > 0.07 {
                // a picture that is warm all over (a sunset) is often meant to be: only a strong cast is offered a change
                let dt = (-warm * 120.0).clamp(-30.0, 30.0);
                let dn = (tint * 150.0).clamp(-20.0, 20.0);
                if dt.abs() >= 4.0 || dn.abs() >= 3.0 {
                    items.push(Suggestion {
                        id: "balance".into(),
                        title: "Even out the colour".into(),
                        why: format!("The middle tones lean {}, which can be a cast (it is left alone if it is the mood you wanted).", if warm.abs() > 0.15 { if warm > 0.0 { "warm" } else { "cool" } } else if tint > 0.0 { "green" } else { "magenta" }),
                        changes: vec![change("temperature", clamp100(current.temperature + dt.round())), change("tint", clamp100(current.tint + dn.round()))],
                    });
                }
            }
        }
    }

    // colour strength
    if sat < 0.12 && median > 40.0 {
        items.push(Suggestion {
            id: "vibrance".into(),
            title: "Bring out the colour".into(),
            why: format!("The colours are weak (average strength {:.0}%).", sat * 100.0),
            changes: vec![change("vibrance", clamp100(current.vibrance + 20.0))],
        });
    }
    items
}

/// Everything for one picture: the faces found in it (already in pixels of `img`), the skin report and the suggestions.
pub fn advise(img: &RgbImage, faces: &[Face], current: &Recipe) -> Advice {
    let samples = skin_pixels(img, faces);
    let (skin, mut items) = skin_advice(&samples, faces.len(), current);
    items.extend(photo_advice(img, current, skin.is_some()));
    merge_exposure(&mut items, current);
    Advice { faces: faces.len(), skin, items, look: None }
}

/// "Brighten the faces" and "Brighten the picture" both set the exposure; offered together the second would overwrite the first.
/// Keep the faces' suggestion, with the gentler of the two values (a face alone can ask for far more than the picture can take).
fn merge_exposure(items: &mut Vec<Suggestion>, current: &Recipe) {
    let Some(general) = items.iter().position(|s| s.id == "exposure") else { return };
    let Some(skin) = items.iter().position(|s| s.id == "skin-light") else { return };
    let value = |s: &Suggestion| s.changes.iter().find(|c| c.field == "exposure").map(|c| c.value);
    let (Some(g), Some(k)) = (value(&items[general]), value(&items[skin])) else { return };
    let gentler = if (g - current.exposure).abs() <= (k - current.exposure).abs() { g } else { k };
    for c in items[skin].changes.iter_mut().filter(|c| c.field == "exposure") {
        c.value = gentler;
    }
    items.remove(general);
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgb;

    /// A face-sized patch of one skin colour with a little texture, on a grey background.
    fn portrait(skin: [u8; 3]) -> (RgbImage, Vec<Face>) {
        let img = RgbImage::from_fn(300, 300, |x, y| {
            let inside = (80..220).contains(&x) && (60..240).contains(&y);
            if inside {
                let n = ((x * 7 + y * 13) % 9) as i16 - 4;
                Rgb([(skin[0] as i16 + n).clamp(0, 255) as u8, (skin[1] as i16 + n).clamp(0, 255) as u8, (skin[2] as i16 + n).clamp(0, 255) as u8])
            } else {
                Rgb([120, 120, 120])
            }
        });
        let face = Face { x: 80.0, y: 60.0, w: 140.0, h: 180.0, score: 0.9, landmarks: [[0.0; 2]; 5] };
        (img, vec![face])
    }

    const HEALTHY: [u8; 3] = [214, 160, 130];
    const PINK: [u8; 3] = [212, 148, 148];
    const YELLOW: [u8; 3] = [203, 168, 125];
    const DARK: [u8; 3] = [52, 34, 26];

    fn skin_hue(p: [u8; 3]) -> f32 {
        let l = lab(p);
        hue_chroma(l[1], l[2]).0
    }

    #[test]
    fn the_faces_and_the_picture_do_not_both_set_the_exposure() {
        let mut items = vec![
            Suggestion { id: "skin-light".into(), title: String::new(), why: String::new(), changes: vec![change("exposure", 2.1)] },
            Suggestion { id: "exposure".into(), title: String::new(), why: String::new(), changes: vec![change("exposure", 1.1)] },
            Suggestion { id: "contrast".into(), title: String::new(), why: String::new(), changes: vec![change("contrast", 20.0)] },
        ];
        merge_exposure(&mut items, &Recipe::default());
        assert_eq!(items.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["skin-light", "contrast"]);
        assert_eq!(items[0].changes[0].value, 1.1, "the gentler value");
    }

    #[test]
    fn the_test_colours_are_what_the_tests_say_they_are() {
        assert!((HUE_LOW..=HUE_HIGH).contains(&skin_hue(HEALTHY)), "healthy: {}", skin_hue(HEALTHY));
        assert!(skin_hue(PINK) < HUE_LOW, "pink: {}", skin_hue(PINK));
        assert!(skin_hue(YELLOW) > HUE_HIGH, "yellow: {}", skin_hue(YELLOW));
        for p in [HEALTHY, PINK, YELLOW, DARK] {
            assert!(is_skin(p), "{p:?} is taken for skin");
        }
        assert!(!is_skin([120, 120, 120]) && !is_skin([40, 80, 200]) && !is_skin([255, 255, 255]), "grey, blue and white are not skin");
        let l = lab([255, 255, 255]);
        assert!((l[0] - 100.0).abs() < 0.5 && l[1].abs() < 0.5 && l[2].abs() < 0.5, "{l:?}");
    }

    #[test]
    fn healthy_skin_gets_no_skin_suggestions() {
        let (img, faces) = portrait(HEALTHY);
        let a = advise(&img, &faces, &Recipe::default());
        assert_eq!(a.faces, 1);
        let skin = a.skin.expect("skin was measured");
        assert!(skin.pixels > 100, "{}", skin.pixels);
        assert_eq!(skin.verdict, "The skin tones look natural.");
        assert!(!a.items.iter().any(|s| s.id.starts_with("skin")), "{:?}", a.items);
    }

    #[test]
    fn pink_skin_is_offered_a_fix_and_the_fix_really_brings_the_hue_into_range() {
        let (img, faces) = portrait(PINK);
        let a = advise(&img, &faces, &Recipe::default());
        let s = a.items.iter().find(|s| s.id == "skin-cast").expect("a cast was found");
        assert!(a.skin.as_ref().unwrap().verdict.contains("red"));
        // apply what it says to the picture and measure again
        let mut r = Recipe::default();
        for c in &s.changes {
            match c.field.as_str() {
                "temperature" => r.temperature = c.value,
                "tint" => r.tint = c.value,
                f => panic!("unexpected field {f}"),
            }
        }
        let fixed = develop::apply_tone(&img, &r);
        let again = advise(&fixed, &faces, &r);
        let hue = again.skin.unwrap().hue;
        assert!((HUE_LOW - 3.0..=HUE_HIGH).contains(&hue), "after the fix the hue is {hue}");
        assert!(r.temperature.abs() <= 50.0 && r.tint.abs() <= 40.0, "within the range searched: {r:?}");
    }

    #[test]
    fn greenish_yellow_skin_is_fixed_by_measurement_and_the_values_are_on_top_of_what_the_picture_already_has() {
        let (img, faces) = portrait(YELLOW);
        let current = with(Recipe::default(), |r| {
            r.temperature = 12.0;
            r.tint = -5.0;
        });
        let a = advise(&img, &faces, &current);
        assert!(a.skin.as_ref().unwrap().verdict.contains("yellow"));
        let s = a.items.iter().find(|s| s.id == "skin-cast").expect("a cast was found");
        let get = |f: &str| s.changes.iter().find(|c| c.field == f).unwrap().value;
        // the values are the new settings: the change from the current ones is what is tried on the picture
        let delta = with(Recipe::default(), |r| {
            r.temperature = get("temperature") - current.temperature;
            r.tint = get("tint") - current.tint;
        });
        let hue = advise(&develop::apply_tone(&img, &delta), &faces, &delta).skin.expect("still skin").hue;
        assert!((HUE_LOW - 3.0..=HUE_HIGH + 3.0).contains(&hue), "after the change the hue is {hue}");
    }

    #[test]
    fn a_nearly_black_face_is_offered_light_but_dark_skin_that_is_properly_exposed_is_left_alone() {
        let (img, faces) = portrait(DARK);
        let a = advise(&img, &faces, &Recipe::default());
        let up = a.items.iter().find(|s| s.id == "skin-light").expect("a very dark face is offered light");
        assert!(up.changes[0].value > 0.2);
        // deeply pigmented skin at a normal exposure (lightness well above the floor) gets nothing about light
        let (img, faces) = portrait([120, 80, 60]);
        let a = advise(&img, &faces, &Recipe::default());
        assert!(!a.items.iter().any(|s| s.id == "skin-light"), "{:?}", a.items);
    }

    #[test]
    fn no_faces_means_no_skin_report_and_the_balance_is_judged_by_the_picture() {
        let cool = RgbImage::from_pixel(200, 150, Rgb([108, 125, 150]));
        let a = advise(&cool, &[], &Recipe::default());
        assert!(a.skin.is_none() && a.faces == 0);
        let b = a.items.iter().find(|s| s.id == "balance").expect("a strong cast is mentioned");
        assert!(b.changes.iter().find(|c| c.field == "temperature").unwrap().value > 0.0, "warmer");
        // with skin found, the balance is left to the skin assistant
        let (img, faces) = portrait(PINK);
        assert!(!advise(&img, &faces, &Recipe::default()).items.iter().any(|s| s.id == "balance"));
    }

    #[test]
    fn exposure_highlights_shadows_contrast_and_colour_are_noticed_and_a_good_picture_is_left_alone() {
        let dark = RgbImage::from_fn(200, 150, |x, _| Rgb([(20 + x / 8) as u8; 3]));
        let ids = |img: &RgbImage| photo_advice(img, &Recipe::default(), false).into_iter().map(|s| s.id).collect::<Vec<_>>();
        assert!(ids(&dark).contains(&"exposure".to_string()));
        let bright = RgbImage::from_fn(200, 150, |x, _| Rgb([(200 + x / 8) as u8; 3]));
        let b = photo_advice(&bright, &Recipe::default(), false);
        assert!(b.iter().find(|s| s.id == "exposure").unwrap().changes[0].value < 0.0, "darker");
        let blown = RgbImage::from_fn(200, 150, |x, _| if x < 20 { Rgb([255; 3]) } else { Rgb([(60 + x / 2) as u8; 3]) });
        assert!(ids(&blown).contains(&"highlights".to_string()));
        let crushed = RgbImage::from_fn(200, 150, |x, _| if x < 20 { Rgb([0; 3]) } else { Rgb([(60 + x / 2) as u8; 3]) });
        assert!(ids(&crushed).contains(&"shadows".to_string()));
        let flat = RgbImage::from_fn(200, 150, |x, _| Rgb([(110 + x / 10) as u8; 3]));
        assert!(ids(&flat).contains(&"contrast".to_string()));
        // a well-exposed, full-range, colourful picture has nothing to say
        let good = RgbImage::from_fn(240, 160, |x, y| {
            let (v, t) = (10.0 + 235.0 * x as f32 / 240.0, y as f32 / 160.0);
            Rgb([(v * (0.6 + 0.4 * t)) as u8, (v * 0.8) as u8, (v * (1.0 - 0.4 * t)) as u8])
        });
        assert_eq!(ids(&good), Vec::<String>::new(), "{:?}", photo_advice(&good, &Recipe::default(), false));
    }

    #[test]
    fn pictures_that_are_dark_bright_or_black_by_choice_are_left_alone() {
        let ids = |img: &RgbImage| photo_advice(img, &Recipe::default(), false).into_iter().map(|s| s.id).collect::<Vec<_>>();
        // a night scene: mostly dark, with bright lights in it
        let night = RgbImage::from_fn(200, 150, |x, y| if (x / 10 + y / 10) % 9 == 0 { Rgb([200, 190, 150]) } else { Rgb([(25 + x / 12) as u8; 3]) });
        assert!(!ids(&night).contains(&"exposure".to_string()), "{:?}", ids(&night));
        // a studio picture on black: more than two fifths of it is black on purpose
        let studio = RgbImage::from_fn(200, 150, |x, _| if x < 130 { Rgb([0; 3]) } else { Rgb([(60 + x / 2) as u8; 3]) });
        assert!(!ids(&studio).contains(&"shadows".to_string()));
        // a colourful picture that leans warm is not a colour cast
        let flowers = RgbImage::from_fn(200, 150, |x, _| Rgb([(200 + x / 8) as u8, 90, 40]));
        assert!(!ids(&flowers).contains(&"balance".to_string()));
    }

    #[test]
    fn values_stay_inside_the_ranges_of_the_settings() {
        let extreme = with(Recipe::default(), |r| {
            r.temperature = 95.0;
            r.tint = -95.0;
            r.highlights = -95.0;
        });
        let (img, faces) = portrait(PINK);
        for s in advise(&img, &faces, &extreme).items {
            for c in s.changes {
                let (lo, hi) = if c.field == "exposure" { (-5.0, 5.0) } else { (-100.0, 100.0) };
                assert!((lo..=hi).contains(&c.value), "{} = {}", c.field, c.value);
            }
        }
    }

    #[test]
    fn too_few_skin_pixels_are_not_enough_to_judge_by() {
        let img = RgbImage::from_pixel(100, 100, Rgb([120, 120, 120]));
        let face = Face { x: 10.0, y: 10.0, w: 60.0, h: 60.0, score: 0.9, landmarks: [[0.0; 2]; 5] };
        let a = advise(&img, &[face], &Recipe::default());
        assert!(a.skin.is_none());
        assert!(skin_pixels(&img, &[]).is_empty());
    }
}
