//! Lens corrections and transform: bend the picture's geometry before it is cropped.
//!
//! Every output pixel asks "where in the source do I come from?", so the picture is resampled once,
//! whatever combination of corrections is on. All the work is in normalised units where 1 is half of the
//! picture's long edge, so a correction means the same at any size.

use image::RgbImage;
use serde::{Deserialize, Serialize};

use crate::develop::par_bands;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Geometry {
    /// -100..100. Positive pushes the edges outward (corrects barrel distortion), negative pulls them in (pincushion).
    pub distortion: f32,
    /// -100..100. Colour fringes: shifts the red (or blue) channel outward from the centre, or inward.
    pub ca_red: f32,
    pub ca_blue: f32,
    /// -100..100. Tilt of the camera up or down (converging verticals) and left or right.
    pub vertical: f32,
    pub horizontal: f32,
    /// -10..10 degrees.
    pub rotate: f32,
    /// -100..100. Stretches the picture one way and squeezes it the other.
    pub aspect: f32,
    /// 50..200 percent.
    pub scale: f32,
    /// -100..100, a quarter of the picture at either end.
    pub x_offset: f32,
    pub y_offset: f32,
    /// Zoom in just enough that no empty corner shows.
    pub constrain: bool,
    /// Turn the picture clockwise this many quarter turns (0 to 3), after mirroring it left to right if `mirror` is set.
    pub quarter_turns: u8,
    pub mirror: bool,
}

impl Default for Geometry {
    fn default() -> Self {
        Geometry { distortion: 0.0, ca_red: 0.0, ca_blue: 0.0, vertical: 0.0, horizontal: 0.0, rotate: 0.0, aspect: 0.0, scale: 100.0, x_offset: 0.0, y_offset: 0.0, constrain: true, quarter_turns: 0, mirror: false }
    }
}

impl Geometry {
    pub fn sanitized(&self) -> Geometry {
        let c = |v: f32, lo: f32, hi: f32, d: f32| if v.is_finite() { v.clamp(lo, hi) } else { d };
        Geometry {
            distortion: c(self.distortion, -100.0, 100.0, 0.0),
            ca_red: c(self.ca_red, -100.0, 100.0, 0.0),
            ca_blue: c(self.ca_blue, -100.0, 100.0, 0.0),
            vertical: c(self.vertical, -100.0, 100.0, 0.0),
            horizontal: c(self.horizontal, -100.0, 100.0, 0.0),
            rotate: c(self.rotate, -10.0, 10.0, 0.0),
            aspect: c(self.aspect, -100.0, 100.0, 0.0),
            scale: c(self.scale, 50.0, 200.0, 100.0),
            x_offset: c(self.x_offset, -100.0, 100.0, 0.0),
            y_offset: c(self.y_offset, -100.0, 100.0, 0.0),
            constrain: self.constrain,
            quarter_turns: self.quarter_turns % 4,
            mirror: self.mirror,
        }
    }

    /// Does this leave the picture exactly as it is? (The "constrain" choice alone changes nothing.)
    pub fn is_identity(&self) -> bool {
        self.warp_is_identity() && self.quarter_turns % 4 == 0 && !self.mirror
    }

    /// Is the lens and transform part (everything but the quarter turns and the mirror) a no-op?
    fn warp_is_identity(&self) -> bool {
        let z = |v: f32| v.abs() < 1e-4;
        z(self.distortion) && z(self.ca_red) && z(self.ca_blue) && z(self.vertical) && z(self.horizontal) && z(self.rotate) && z(self.aspect) && (self.scale - 100.0).abs() < 1e-4 && z(self.x_offset) && z(self.y_offset)
    }
}

/// Where an output point (normalised, from the centre) comes from in the source, for the red, green and blue channels.
struct Mapper {
    shift: (f32, f32),
    zoom: f32,
    stretch: f32,
    sin: f32,
    cos: f32,
    v: f32,
    h: f32,
    k: f32,
    ca_red: f32,
    ca_blue: f32,
}

impl Mapper {
    fn new(g: &Geometry, half: f32, w: f32, h: f32, zoom: f32) -> Mapper {
        let (sin, cos) = g.rotate.to_radians().sin_cos();
        Mapper {
            shift: (g.x_offset / 100.0 * 0.25 * w / half, g.y_offset / 100.0 * 0.25 * h / half),
            zoom,
            stretch: (g.aspect / 100.0 * 0.35).exp(),
            sin,
            cos,
            v: g.vertical / 100.0 * 0.35,
            h: g.horizontal / 100.0 * 0.35,
            k: g.distortion / 100.0 * 0.5,
            ca_red: g.ca_red / 100.0 * 0.01,
            ca_blue: g.ca_blue / 100.0 * 0.01,
        }
    }

    /// The green (reference) source point for an output point.
    fn source(&self, x: f32, y: f32) -> (f32, f32) {
        let (mut x, mut y) = (x - self.shift.0, y - self.shift.1);
        x /= self.zoom * self.stretch;
        y = y / self.zoom * self.stretch;
        let (rx, ry) = (x * self.cos - y * self.sin, x * self.sin + y * self.cos);
        let denom = (1.0 + self.v * ry + self.h * rx).max(0.1);
        let (px, py) = (rx / denom, ry / denom);
        let r2 = px * px + py * py;
        let f = 1.0 - self.k * r2;
        (px * f, py * f)
    }
}

/// The zoom needed so that every point of the output's edge comes from inside the source.
fn constrain_zoom(g: &Geometry, half: f32, w: f32, h: f32) -> f32 {
    let (bx, by) = (w / (2.0 * half), h / (2.0 * half));
    let mut zoom = g.scale / 100.0;
    for _ in 0..4 {
        let m = Mapper::new(g, half, w, h, zoom);
        let mut worst = 1.0f32;
        for i in 0..=48 {
            let t = i as f32 / 48.0 * 2.0 - 1.0;
            for (x, y) in [(t * bx, -by), (t * bx, by), (-bx, t * by), (bx, t * by)] {
                let (sx, sy) = m.source(x, y);
                worst = worst.max(sx.abs() / bx).max(sy.abs() / by);
            }
        }
        if worst <= 1.0005 {
            break;
        }
        zoom *= worst;
    }
    zoom
}

/// Bilinear sample of a pixel's three channels at a fractional position; outside the picture is black.
#[inline(always)]
fn sample_rgb(raw: &[u8], w: i32, h: i32, x: f32, y: f32, out: &mut [f32; 3]) {
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = (x - x0, y - y0);
    let (x0, y0) = (x0 as i32, y0 as i32);
    if x0 >= 0 && y0 >= 0 && x0 + 1 < w && y0 + 1 < h {
        // the common case: all four neighbours exist
        let i = (y0 as usize * w as usize + x0 as usize) * 3;
        let j = i + w as usize * 3;
        let (w00, w10, w01, w11) = ((1.0 - fx) * (1.0 - fy), fx * (1.0 - fy), (1.0 - fx) * fy, fx * fy);
        for k in 0..3 {
            out[k] = raw[i + k] as f32 * w00 + raw[i + 3 + k] as f32 * w10 + raw[j + k] as f32 * w01 + raw[j + 3 + k] as f32 * w11;
        }
        return;
    }
    let at = |xx: i32, yy: i32, k: usize| -> f32 {
        if xx < 0 || yy < 0 || xx >= w || yy >= h {
            0.0
        } else {
            raw[(yy as usize * w as usize + xx as usize) * 3 + k] as f32
        }
    };
    for k in 0..3 {
        let top = at(x0, y0, k) * (1.0 - fx) + at(x0 + 1, y0, k) * fx;
        let bot = at(x0, y0 + 1, k) * (1.0 - fx) + at(x0 + 1, y0 + 1, k) * fx;
        out[k] = top * (1.0 - fy) + bot * fy;
    }
}

/// Mirror the picture left to right if asked, then turn it clockwise by quarter turns. A quarter turn swaps width and height.
pub fn orient(img: &RgbImage, quarter_turns: u8, mirror: bool) -> RgbImage {
    let flipped = if mirror { image::imageops::flip_horizontal(img) } else { img.clone() };
    match quarter_turns % 4 {
        1 => image::imageops::rotate90(&flipped),
        2 => image::imageops::rotate180(&flipped),
        3 => image::imageops::rotate270(&flipped),
        _ => flipped,
    }
}

/// Apply the quarter turns and the mirror, then the lens corrections and the transform. Only a quarter turn changes the size.
pub fn apply_geometry(img: &RgbImage, geometry: &Geometry) -> RgbImage {
    let g = geometry.sanitized();
    let turned;
    let img: &RgbImage = if g.quarter_turns != 0 || g.mirror {
        turned = orient(img, g.quarter_turns, g.mirror);
        &turned
    } else {
        img
    };
    if g.warp_is_identity() || img.width() < 2 || img.height() < 2 {
        return img.clone();
    }
    let (w, h) = (img.width() as usize, img.height() as usize);
    let half = w.max(h) as f32 / 2.0;
    let zoom = if g.constrain { constrain_zoom(&g, half, w as f32, h as f32) } else { g.scale / 100.0 };
    let m = Mapper::new(&g, half, w as f32, h as f32, zoom);
    let fringes = g.ca_red != 0.0 || g.ca_blue != 0.0;
    let (cx, cy) = (w as f32 / 2.0, h as f32 / 2.0);
    let raw: &[u8] = img.as_raw();
    let (wi, hi) = (w as i32, h as i32);
    let mut out = vec![0u8; w * h * 3];
    par_bands(&mut out, w * 3, |row0, band| {
        for (ry, row) in band.chunks_exact_mut(w * 3).enumerate() {
            let ny = ((row0 + ry) as f32 + 0.5 - cy) / half;
            for x in 0..w {
                let nx = (x as f32 + 0.5 - cx) / half;
                let (sx, sy) = m.source(nx, ny);
                let (gx, gy) = (cx + sx * half - 0.5, cy + sy * half - 0.5);
                let mut g3 = [0f32; 3];
                sample_rgb(raw, wi, hi, gx, gy, &mut g3);
                if fringes {
                    // the red and blue pictures are very slightly bigger or smaller than the green one
                    let mut c = [0f32; 3];
                    sample_rgb(raw, wi, hi, cx + sx * (1.0 + m.ca_red) * half - 0.5, cy + sy * (1.0 + m.ca_red) * half - 0.5, &mut c);
                    g3[0] = c[0];
                    sample_rgb(raw, wi, hi, cx + sx * (1.0 + m.ca_blue) * half - 0.5, cy + sy * (1.0 + m.ca_blue) * half - 0.5, &mut c);
                    g3[2] = c[2];
                }
                for k in 0..3 {
                    row[x * 3 + k] = (g3[k] + 0.5) as u8;
                }
            }
        }
    });
    RgbImage::from_raw(w as u32, h as u32, out).expect("same size as the input")
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn flat(w: u32, h: u32, v: u8) -> RgbImage {
        ImageBuffer::from_pixel(w, h, Rgb([v; 3]))
    }
    fn with(f: impl FnOnce(&mut Geometry)) -> Geometry {
        let mut g = Geometry::default();
        f(&mut g);
        g
    }
    #[test]
    #[ignore]
    fn geometry_speed() {
        for (w, h) in [(1100u32, 733u32), (2048, 1365)] {
            let img: RgbImage = ImageBuffer::from_fn(w, h, |x, y| Rgb([(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8]));
            for (name, g) in [("rotate+vertical", with(|g| { g.rotate = 3.0; g.vertical = 30.0 })), ("distortion+CA", with(|g| { g.distortion = 40.0; g.ca_red = 30.0; g.ca_blue = -30.0 }))] {
                let mut t = Vec::new();
                for _ in 0..5 {
                    let s = std::time::Instant::now();
                    let _ = apply_geometry(&img, &g);
                    t.push(s.elapsed().as_millis());
                }
                eprintln!("geometry {w}x{h} {name}: {t:?} ms");
            }
        }
    }

    // ---- turning and mirroring ----

    /// A picture 3 wide and 2 tall whose pixels are the letters A to F, row by row:  A B C / D E F
    fn letters() -> RgbImage {
        ImageBuffer::from_fn(3, 2, |x, y| Rgb([10 + (y * 3 + x) as u8 * 10, 0, 0]))
    }
    /// A picture as text, one line per row, the pixel values 10, 20 ... 60 shown as A to F.
    fn text(img: &RgbImage) -> String {
        (0..img.height()).map(|y| (0..img.width()).map(|x| (b'A' + (img.get_pixel(x, y)[0] / 10 - 1)) as char).collect::<String>()).collect::<Vec<_>>().join("/")
    }

    #[test]
    fn all_eight_orientations_of_an_asymmetric_picture_come_out_as_worked_out_by_hand() {
        // (quarter turns, mirrored): the result, row by row. Mirrored means left to right first, then the turn, clockwise.
        let table = [
            (0, false, "ABC/DEF"),
            (1, false, "DA/EB/FC"),
            (2, false, "FED/CBA"),
            (3, false, "CF/BE/AD"),
            (0, true, "CBA/FED"),
            (1, true, "FC/EB/DA"),
            (2, true, "DEF/ABC"),
            (3, true, "AD/BE/CF"),
        ];
        // the same table is in the page's tests (orient.test.ts)
        for (q, mirror, want) in table {
            let out = orient(&letters(), q, mirror);
            assert_eq!(text(&out), want, "{q} quarter turns, mirrored: {mirror}");
        }
    }

    #[test]
    fn a_quarter_turn_swaps_width_and_height_and_four_turns_are_none() {
        let img: RgbImage = ImageBuffer::from_fn(300, 200, |x, y| Rgb([(x % 251) as u8, (y % 251) as u8, 90]));
        for q in [1u8, 3] {
            let out = apply_geometry(&img, &with(|g| g.quarter_turns = q));
            assert_eq!((out.width(), out.height()), (200, 300));
        }
        for q in [0u8, 2, 4, 8] {
            let out = apply_geometry(&img, &with(|g| g.quarter_turns = q));
            assert_eq!((out.width(), out.height()), (300, 200), "{q}");
        }
        assert_eq!(apply_geometry(&img, &with(|g| g.quarter_turns = 4)), img, "four quarter turns are no turn");
    }

    #[test]
    fn turning_and_mirroring_count_as_a_change_and_nothing_else_does_when_they_are_off() {
        assert!(Geometry::default().is_identity());
        assert!(!with(|g| g.quarter_turns = 1).is_identity());
        assert!(!with(|g| g.mirror = true).is_identity());
        assert!(with(|g| g.quarter_turns = 4).is_identity(), "a full circle is nothing");
        assert_eq!(with(|g| g.quarter_turns = 7).sanitized().quarter_turns, 3);
        let old: Geometry = serde_json::from_str(r#"{"rotate":2.0,"constrain":false}"#).unwrap();
        assert_eq!((old.quarter_turns, old.mirror), (0, false), "geometry saved before turning existed loads as not turned");
    }

    #[test]
    fn the_turn_comes_first_and_the_lens_and_transform_work_on_the_turned_picture() {
        // a tall bar, turned a quarter, is a wide bar; the small rotation then tilts it in the turned picture
        let img: RgbImage = ImageBuffer::from_fn(200, 300, |x, y| if (95..105).contains(&x) && y < 200 { Rgb([240; 3]) } else { Rgb([10; 3]) });
        let turned = apply_geometry(&img, &with(|g| g.quarter_turns = 1));
        assert_eq!((turned.width(), turned.height()), (300, 200));
        assert!(bright_in_row(&turned, 100) >= 190, "the bar now runs across");
        let both = apply_geometry(&img, &with(|g| { g.quarter_turns = 1; g.rotate = 6.0; g.constrain = false }));
        assert_eq!((both.width(), both.height()), (300, 200), "the small rotation keeps the (turned) size");
        assert_ne!(both, turned);
    }

    /// How many pixels of a row are brighter than the middle grey.
    fn bright_in_row(img: &RgbImage, y: u32) -> u32 {
        (0..img.width()).filter(|x| img.get_pixel(*x, y)[0] > 128).count() as u32
    }
    /// A bright rectangle on dark.
    fn block(w: u32, h: u32, x0: u32, y0: u32, x1: u32, y1: u32) -> RgbImage {
        ImageBuffer::from_fn(w, h, |x, y| if x >= x0 && x < x1 && y >= y0 && y < y1 { Rgb([240; 3]) } else { Rgb([10; 3]) })
    }

    #[test]
    fn the_default_leaves_the_picture_exactly_alone() {
        let img: RgbImage = ImageBuffer::from_fn(80, 50, |x, y| Rgb([(x * 3) as u8, (y * 5) as u8, 9]));
        assert_eq!(apply_geometry(&img, &Geometry::default()), img);
        assert_eq!(apply_geometry(&img, &with(|g| g.constrain = false)), img, "constrain alone changes nothing");
        assert!(Geometry::default().is_identity());
        assert!(!with(|g| g.rotate = 1.0).is_identity());
        assert!(!with(|g| g.scale = 120.0).is_identity());
    }

    #[test]
    fn scale_zooms_about_the_centre() {
        let img = block(200, 100, 90, 40, 110, 60); // a 20 by 20 block in the middle
        let big = apply_geometry(&img, &with(|g| g.scale = 200.0));
        assert!(bright_in_row(&big, 50) > 34 && bright_in_row(&big, 50) < 46, "twice as wide: {}", bright_in_row(&big, 50));
        assert_eq!(big.get_pixel(100, 50)[0], 240, "the centre stays");
        let small = apply_geometry(&img, &with(|g| { g.scale = 50.0; g.constrain = false }));
        assert!(bright_in_row(&small, 50) > 6 && bright_in_row(&small, 50) < 14, "half as wide: {}", bright_in_row(&small, 50));
    }

    #[test]
    fn rotate_tilts_a_level_line() {
        let bar = block(300, 100, 0, 47, 300, 53); // a level bar across the middle
        let tilted = apply_geometry(&bar, &with(|g| g.rotate = 5.0));
        let row_of = |img: &RgbImage, x: u32| (0..img.height()).find(|y| img.get_pixel(x, *y)[0] > 128);
        let (left, right) = (row_of(&tilted, 40).unwrap() as i32, row_of(&tilted, 260).unwrap() as i32);
        // 220 px along a 5 degree tilt is about 19 px; the bar rises on one side and falls on the other
        assert!((left - right).abs() >= 12, "left {left} right {right}");
        let back = apply_geometry(&bar, &with(|g| g.rotate = -5.0));
        let (l2, r2) = (row_of(&back, 40).unwrap() as i32, row_of(&back, 260).unwrap() as i32);
        assert!((l2 - r2) * (left - right) < 0, "the other way round for the other sign");
    }

    #[test]
    fn vertical_perspective_makes_the_top_and_bottom_of_a_shape_different_widths_and_flips_with_the_sign() {
        let img = block(300, 300, 100, 60, 200, 240); // a tall block
        let widths = |g: Geometry| {
            let out = apply_geometry(&img, &g);
            (bright_in_row(&out, 80) as i32, bright_in_row(&out, 220) as i32)
        };
        let (flat_top, flat_bottom) = widths(Geometry::default());
        assert_eq!(flat_top, flat_bottom);
        let (a_top, a_bottom) = widths(with(|g| g.vertical = 60.0));
        let (b_top, b_bottom) = widths(with(|g| g.vertical = -60.0));
        assert!((a_top - a_bottom).abs() > 8, "top {a_top} bottom {a_bottom}");
        assert!((a_top - a_bottom) * (b_top - b_bottom) < 0, "the other way for the other sign");
    }

    #[test]
    fn horizontal_perspective_changes_the_height_of_the_two_sides() {
        let img = block(300, 300, 60, 100, 240, 200);
        let heights = |g: Geometry| {
            let out = apply_geometry(&img, &g);
            let col = |x: u32| (0..300).filter(|y| out.get_pixel(x, *y)[0] > 128).count() as i32;
            (col(80), col(220))
        };
        let (l, r) = heights(with(|g| g.horizontal = 60.0));
        assert!((l - r).abs() > 8, "left {l} right {r}");
    }

    #[test]
    fn distortion_moves_the_edges_and_not_the_centre() {
        // a grid of lines
        let grid: RgbImage = ImageBuffer::from_fn(300, 300, |x, y| if x % 30 == 0 || y % 30 == 0 { Rgb([240; 3]) } else { Rgb([10; 3]) });
        let out = apply_geometry(&grid, &with(|g| { g.distortion = 80.0; g.constrain = false }));
        // the middle line stays where it was
        assert!(out.get_pixel(150, 120)[0] > 100 || out.get_pixel(149, 120)[0] > 100);
        let col_of_line = |img: &RgbImage| (0..300).find(|x| *x > 250 && img.get_pixel(*x, 145)[0] > 128); // row 145 lies between two horizontal lines
        let (a, b) = (col_of_line(&grid), col_of_line(&out));
        assert_ne!(a, b, "a line near the edge has moved");
        // and the reverse sign moves it the other way
        let pinch = apply_geometry(&grid, &with(|g| { g.distortion = -80.0; g.constrain = false }));
        let near = |img: &RgbImage| (200..300).filter(|x| img.get_pixel(*x, 145)[0] > 128).map(|x| x as i32).sum::<i32>() / (200..300).filter(|x| img.get_pixel(*x, 145)[0] > 128).count().max(1) as i32;
        assert!(near(&pinch) != near(&out), "the two signs differ");
    }

    #[test]
    fn constrain_hides_the_empty_corners_and_leaving_it_off_shows_them() {
        let img = flat(300, 200, 200);
        for g in [with(|g| g.rotate = 6.0), with(|g| g.vertical = 70.0), with(|g| { g.distortion = -70.0; g.rotate = -4.0 })] {
            let kept = apply_geometry(&img, &g);
            let darkest = kept.pixels().map(|p| p[0]).min().unwrap();
            assert!(darkest >= 195, "no empty corner with constrain on: {darkest} for {g:?}");
            let loose = apply_geometry(&img, &Geometry { constrain: false, ..g.clone() });
            assert!(loose.pixels().any(|p| p[0] < 50), "an empty corner shows without it for {g:?}");
        }
    }

    #[test]
    fn offsets_move_the_picture() {
        let img = block(200, 100, 90, 40, 110, 60);
        let moved = apply_geometry(&img, &with(|g| { g.x_offset = 100.0; g.constrain = false }));
        // the block moves right by a quarter of the width, 50 px
        assert!(moved.get_pixel(150, 50)[0] > 128 && moved.get_pixel(100, 50)[0] < 128);
        let up = apply_geometry(&img, &with(|g| { g.y_offset = -100.0; g.constrain = false }));
        assert!(up.get_pixel(100, 25)[0] > 128 && up.get_pixel(100, 50)[0] < 128, "a negative offset moves it up");
    }

    #[test]
    fn aspect_stretches_one_way_and_squeezes_the_other() {
        let img = block(200, 200, 80, 80, 120, 120);
        let wide = apply_geometry(&img, &with(|g| { g.aspect = 100.0; g.constrain = false }));
        let wide_w = bright_in_row(&wide, 100) as i32;
        let tall_h = (0..200).filter(|y| wide.get_pixel(100, *y)[0] > 128).count() as i32;
        assert!(wide_w != tall_h, "no longer square: {wide_w} by {tall_h}");
        let other = apply_geometry(&img, &with(|g| { g.aspect = -100.0; g.constrain = false }));
        let other_w = bright_in_row(&other, 100) as i32;
        assert!((wide_w - 40) * (other_w - 40) < 0, "the two signs go opposite ways");
    }

    #[test]
    fn colour_fringe_correction_moves_red_and_blue_apart_and_leaves_green() {
        // a white dot far from the centre
        let mut img = flat(400, 400, 0);
        for y in 196..204 {
            for x in 340..348 {
                img.put_pixel(x, y, Rgb([255; 3]));
            }
        }
        let weighted = |out: &RgbImage, ch: usize| {
            let (mut sum, mut total) = (0.0, 0.0);
            for y in 190..210 {
                for x in 320..370 {
                    let v = out.get_pixel(x, y)[ch] as f32;
                    sum += v * x as f32;
                    total += v;
                }
            }
            sum / total
        };
        let out = apply_geometry(&img, &with(|g| { g.ca_red = 100.0; g.ca_blue = -100.0; g.constrain = false }));
        let (r, gr, b) = (weighted(&out, 0), weighted(&out, 1), weighted(&out, 2));
        assert!((gr - weighted(&img, 1)).abs() < 0.3, "green stays put");
        assert!(r < gr - 0.5 && b > gr + 0.5, "red {r}, green {gr}, blue {b}: the fringes go opposite ways");
    }

    #[test]
    fn values_are_clamped_and_old_recipes_load() {
        let s = Geometry { distortion: f32::NAN, rotate: 99.0, scale: 1.0, vertical: -1e9, ..Default::default() }.sanitized();
        assert_eq!((s.distortion, s.rotate, s.scale, s.vertical), (0.0, 10.0, 50.0, -100.0));
        let part: Geometry = serde_json::from_str(r#"{"rotate":2}"#).unwrap();
        assert_eq!((part.rotate, part.scale, part.constrain), (2.0, 100.0, true), "missing fields take their own defaults");
        assert_eq!(serde_json::to_string(&Geometry::default()).unwrap().contains("xOffset"), true);
        // a tiny picture does not break
        let tiny = flat(1, 1, 5);
        assert_eq!(apply_geometry(&tiny, &with(|g| g.rotate = 5.0)), tiny);
    }
}
