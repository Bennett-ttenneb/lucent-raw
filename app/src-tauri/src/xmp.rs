//! XMP sidecar files: a small text file next to a photo that carries what the catalog knows about it (rating, label, title,
//! caption, creator, copyright, keywords, and the edits), so that it survives outside the catalog and other programs can read it.
//!
//! What is written follows the Adobe names where there are some (`xmp:Rating`, `xmp:Label`, `dc:title`, `dc:description`,
//! `dc:creator`, `dc:rights`, `dc:subject`, `lr:hierarchicalSubject`), so darktable, digiKam and other photo programs read the
//! ratings, labels, text and keywords. What has no standard name (the pick flag, and the edits as this app stores them) goes in
//! this app's own namespace, `lucent:`. The edits are NOT turned into Adobe's `crs:` develop settings: the two do not mean the
//! same thing, and a wrong translation would be worse than none.
//!
//! A sidecar this app did not write is never overwritten (it may hold another program's edits). It can be read.

use roxmltree::{Document, Node, ParsingOptions};
use serde::Serialize;
use std::path::{Path, PathBuf};

const NS_RDF: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const NS_XMP: &str = "http://ns.adobe.com/xap/1.0/";
const NS_DC: &str = "http://purl.org/dc/elements/1.1/";
const NS_CRS: &str = "http://ns.adobe.com/camera-raw-settings/1.0/";
const NS_LR: &str = "http://ns.adobe.com/lightroom/1.0/";
const NS_PS: &str = "http://ns.adobe.com/photoshop/1.0/";
const NS_IPTC: &str = "http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/";
const NS_RIGHTS: &str = "http://ns.adobe.com/xap/1.0/rights/";
pub const NS_LUCENT: &str = "http://ns.lucentraw.app/1.0/";

const LABELS: &[(&str, &str)] = &[("red", "Red"), ("yellow", "Yellow"), ("green", "Green"), ("blue", "Blue"), ("purple", "Purple")];
/// A sidecar bigger than this is not read (a sidecar is a few KB; this guards against a wrong file).
pub const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Everything a sidecar can say about a photo. A field that is `None` (or an empty list) is not in the file.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Sidecar {
    /// 0 to 5
    pub rating: Option<i64>,
    /// -1 reject, 0 none, 1 pick
    pub flag: Option<i64>,
    /// as the catalog names it: red, yellow, green, blue, purple
    pub label: Option<String>,
    pub title: Option<String>,
    pub caption: Option<String>,
    pub creator: Option<String>,
    pub copyright: Option<String>,
    /// the rest of the details a photo can carry (photoshop:Credit, photoshop:Source, Iptc4xmpCore:Location, photoshop:City, photoshop:State,
    /// photoshop:Country, photoshop:Headline, photoshop:AuthorsPosition, photoshop:Instructions, photoshop:TransmissionReference, xmpRights:UsageTerms)
    pub credit: Option<String>,
    pub source: Option<String>,
    pub sublocation: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub country: Option<String>,
    pub headline: Option<String>,
    pub job_title: Option<String>,
    pub instructions: Option<String>,
    pub job_id: Option<String>,
    pub usage_terms: Option<String>,
    /// keyword paths, top level first, at most three levels
    pub keywords: Vec<Vec<String>>,
    /// the edits (this app's own recipe, as JSON)
    pub recipe: Option<String>,
    /// written by this app (so it may be rewritten)
    #[serde(skip)]
    pub ours: bool,
    /// Lightroom's develop settings ("crs:"), from a sidecar written by another program: only the ones that mean the same here
    #[serde(skip)]
    pub crs: Option<Crs>,
}

/// The develop settings of a Lightroom or Camera Raw sidecar that this program understands: the tone sliders, the presence sliders, the
/// colour mixer, the tone curve and the crop. White balance is not here (Lightroom keeps it in Kelvin for RAW photos, this program as a
/// relative slider), and neither are the sharpening and noise reduction numbers, which are on other scales.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Crs {
    pub exposure: Option<f32>,
    pub contrast: Option<f32>,
    pub highlights: Option<f32>,
    pub shadows: Option<f32>,
    pub whites: Option<f32>,
    pub blacks: Option<f32>,
    pub texture: Option<f32>,
    pub clarity: Option<f32>,
    pub dehaze: Option<f32>,
    pub vibrance: Option<f32>,
    pub saturation: Option<f32>,
    /// red, orange, yellow, green, aqua, blue, purple, magenta
    pub hue: [Option<f32>; 8],
    pub sat: [Option<f32>; 8],
    pub lum: [Option<f32>; 8],
    /// the tone curve's points between the ends
    pub curve: Option<Vec<[f32; 2]>>,
    /// left, top, right, bottom, as fractions of the picture (only when the frame is not turned)
    pub crop: Option<[f32; 4]>,
}

impl Crs {
    fn is_empty(&self) -> bool {
        *self == Crs::default()
    }

    /// The recipe with these settings put on it; everything this does not understand stays as it was.
    pub fn apply_to(&self, base: &crate::develop::Recipe) -> crate::develop::Recipe {
        let mut r = base.clone();
        let mut set = |dst: &mut f32, v: Option<f32>, lo: f32, hi: f32| {
            if let Some(v) = v.filter(|v| v.is_finite()) {
                *dst = v.clamp(lo, hi);
            }
        };
        set(&mut r.exposure, self.exposure, -5.0, 5.0);
        set(&mut r.contrast, self.contrast, -100.0, 100.0);
        set(&mut r.highlights, self.highlights, -100.0, 100.0);
        set(&mut r.shadows, self.shadows, -100.0, 100.0);
        set(&mut r.whites, self.whites, -100.0, 100.0);
        set(&mut r.blacks, self.blacks, -100.0, 100.0);
        set(&mut r.texture, self.texture, -100.0, 100.0);
        set(&mut r.clarity, self.clarity, -100.0, 100.0);
        set(&mut r.dehaze, self.dehaze, -100.0, 100.0);
        set(&mut r.vibrance, self.vibrance, -100.0, 100.0);
        set(&mut r.saturation, self.saturation, -100.0, 100.0);
        for i in 0..8 {
            set(&mut r.hsl.hue[i], self.hue[i], -100.0, 100.0);
            set(&mut r.hsl.sat[i], self.sat[i], -100.0, 100.0);
            set(&mut r.hsl.lum[i], self.lum[i], -100.0, 100.0);
        }
        if let Some(c) = &self.curve {
            r.curve = c.clone();
        }
        if let Some([l, t, rt, b]) = self.crop {
            if rt > l && b > t {
                r.crop.angle = 0.0;
                r.crop.rect = Some(crate::develop::CropRect { cx: (l + rt) / 2.0, cy: (t + b) / 2.0, w: rt - l, h: b - t });
                r.crop.aspect = "free".into();
            }
        }
        r
    }
}

/// Where a photo's sidecar is: `name.xmp` beside a RAW file (the Adobe way), `name.ext.xmp` beside anything else, so a RAW
/// and a JPEG with the same name do not share one.
pub fn sidecar_path(photo: &Path, is_raw: bool) -> PathBuf {
    if is_raw {
        photo.with_extension("xmp")
    } else {
        let mut name = photo.file_name().map(|n| n.to_os_string()).unwrap_or_default();
        name.push(".xmp");
        photo.with_file_name(name)
    }
}

fn clean(s: &str) -> String {
    s.chars().filter(|c| matches!(c, '\t' | '\n') || (!c.is_control() && *c != '\u{FFFE}' && *c != '\u{FFFF}')).collect()
}

fn esc(s: &str) -> String {
    clean(s).replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

fn alt(tag: &str, v: &str) -> String {
    format!("   <{tag}><rdf:Alt><rdf:li xml:lang=\"x-default\">{}</rdf:li></rdf:Alt></{tag}>\n", esc(v))
}

fn unique<T: PartialEq + Clone>(items: impl Iterator<Item = T>) -> Vec<T> {
    let mut out: Vec<T> = Vec::new();
    for i in items {
        if !out.contains(&i) {
            out.push(i);
        }
    }
    out
}

/// The sidecar as text.
pub fn write(sc: &Sidecar) -> String {
    let mut attrs = String::new();
    if let Some(r) = sc.rating {
        // Adobe's way of saying rejected is a rating of -1
        let r = if sc.flag == Some(-1) { -1 } else { r.clamp(0, 5) };
        attrs += &format!(" xmp:Rating=\"{r}\"");
    }
    if let Some(l) = sc.label.as_deref().and_then(|l| LABELS.iter().find(|(k, _)| *k == l)) {
        attrs += &format!(" xmp:Label=\"{}\"", l.1);
    }
    let flag = match sc.flag {
        Some(1) => "pick",
        Some(-1) => "reject",
        _ => "none",
    };
    attrs += &format!(" lucent:Flag=\"{flag}\"");
    let mut body = String::new();
    if let Some(v) = sc.title.as_deref().filter(|v| !v.is_empty()) {
        body += &alt("dc:title", v);
    }
    if let Some(v) = sc.caption.as_deref().filter(|v| !v.is_empty()) {
        body += &alt("dc:description", v);
    }
    if let Some(v) = sc.creator.as_deref().filter(|v| !v.is_empty()) {
        body += &format!("   <dc:creator><rdf:Seq><rdf:li>{}</rdf:li></rdf:Seq></dc:creator>\n", esc(v));
    }
    if let Some(v) = sc.copyright.as_deref().filter(|v| !v.is_empty()) {
        body += &alt("dc:rights", v);
    }
    for (tag, v) in [
        ("photoshop:Credit", &sc.credit),
        ("photoshop:Source", &sc.source),
        ("Iptc4xmpCore:Location", &sc.sublocation),
        ("photoshop:City", &sc.city),
        ("photoshop:State", &sc.state),
        ("photoshop:Country", &sc.country),
        ("photoshop:Headline", &sc.headline),
        ("photoshop:AuthorsPosition", &sc.job_title),
        ("photoshop:Instructions", &sc.instructions),
        ("photoshop:TransmissionReference", &sc.job_id),
    ] {
        if let Some(v) = v.as_deref().filter(|v| !v.is_empty()) {
            body += &format!("   <{tag}>{}</{tag}>\n", esc(v));
        }
    }
    if let Some(v) = sc.usage_terms.as_deref().filter(|v| !v.is_empty()) {
        body += &alt("xmpRights:UsageTerms", v);
    }
    if !sc.keywords.is_empty() {
        let flat = unique(sc.keywords.iter().flatten().cloned());
        body += "   <dc:subject><rdf:Bag>\n";
        for k in &flat {
            body += &format!("    <rdf:li>{}</rdf:li>\n", esc(k));
        }
        body += "   </rdf:Bag></dc:subject>\n   <lr:hierarchicalSubject><rdf:Bag>\n";
        for p in &sc.keywords {
            body += &format!("    <rdf:li>{}</rdf:li>\n", esc(&p.join("|")));
        }
        body += "   </rdf:Bag></lr:hierarchicalSubject>\n";
    }
    if let Some(r) = sc.recipe.as_deref() {
        body += &format!("   <lucent:Recipe>{}</lucent:Recipe>\n", esc(r));
    }
    format!(
        "<?xpacket begin=\"\u{FEFF}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n<x:xmpmeta xmlns:x=\"adobe:ns:meta/\" x:xmptk=\"Lucent Raw\">\n <rdf:RDF xmlns:rdf=\"{NS_RDF}\">\n  <rdf:Description rdf:about=\"\" xmlns:xmp=\"{NS_XMP}\" xmlns:dc=\"{NS_DC}\" xmlns:lr=\"{NS_LR}\" xmlns:photoshop=\"{NS_PS}\" xmlns:Iptc4xmpCore=\"{NS_IPTC}\" xmlns:xmpRights=\"{NS_RIGHTS}\" xmlns:lucent=\"{NS_LUCENT}\"{attrs}>\n{body}  </rdf:Description>\n </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end=\"w\"?>\n"
    )
}

// ---- reading -------------------------------------------------------------------------------------------

fn text_of(n: Node) -> String {
    n.descendants().filter(|d| d.is_text()).map(|d| d.text().unwrap_or("")).collect::<String>().trim().to_string()
}

/// A value that may be an attribute of the description or a child element holding text.
fn simple(descs: &[Node], ns: &str, name: &str) -> Option<String> {
    for d in descs {
        if let Some(a) = d.attribute((ns, name)) {
            return Some(a.trim().to_string());
        }
        if let Some(c) = d.children().find(|c| c.is_element() && c.tag_name().namespace() == Some(ns) && c.tag_name().name() == name) {
            let lis: Vec<Node> = c.descendants().filter(|x| x.is_element() && x.tag_name().namespace() == Some(NS_RDF) && x.tag_name().name() == "li").collect();
            if lis.is_empty() {
                return Some(text_of(c));
            }
            // a language alternative: the default language, otherwise the first
            let pick = lis.iter().find(|l| l.attribute(("http://www.w3.org/XML/1998/namespace", "lang")) == Some("x-default")).or(lis.first());
            return pick.map(|l| text_of(*l));
        }
    }
    None
}

fn list(descs: &[Node], ns: &str, name: &str) -> Vec<String> {
    let mut out = vec![];
    for d in descs {
        for c in d.children().filter(|c| c.is_element() && c.tag_name().namespace() == Some(ns) && c.tag_name().name() == name) {
            for li in c.descendants().filter(|x| x.is_element() && x.tag_name().namespace() == Some(NS_RDF) && x.tag_name().name() == "li") {
                let t = text_of(li);
                if !t.is_empty() {
                    out.push(t);
                }
            }
        }
    }
    out
}

/// Lightroom's `crs:` settings, as far as they are understood here.
fn read_crs(descs: &[Node]) -> Option<Crs> {
    let num = |name: &str| simple(descs, NS_CRS, name).and_then(|v| v.trim().trim_start_matches('+').parse::<f32>().ok()).filter(|v| v.is_finite());
    let mut c = Crs { exposure: num("Exposure2012"), contrast: num("Contrast2012"), highlights: num("Highlights2012"), shadows: num("Shadows2012"), whites: num("Whites2012"), blacks: num("Blacks2012"), texture: num("Texture"), clarity: num("Clarity2012"), dehaze: num("Dehaze"), vibrance: num("Vibrance"), saturation: num("Saturation"), ..Default::default() };
    for (i, colour) in ["Red", "Orange", "Yellow", "Green", "Aqua", "Blue", "Purple", "Magenta"].iter().enumerate() {
        c.hue[i] = num(&format!("HueAdjustment{colour}"));
        c.sat[i] = num(&format!("SaturationAdjustment{colour}"));
        c.lum[i] = num(&format!("LuminanceAdjustment{colour}"));
    }
    // the tone curve: "x, y" pairs from 0 to 255 (a straight line is two points, the ends)
    let points: Vec<[f32; 2]> = list(descs, NS_CRS, "ToneCurvePV2012")
        .iter()
        .filter_map(|p| {
            let mut it = p.split(',').map(|v| v.trim().parse::<f32>().ok());
            Some([it.next()??, it.next()??])
        })
        .collect();
    if points.len() >= 2 {
        let inner: Vec<[f32; 2]> = points.iter().copied().filter(|p| p[0] > 0.0 && p[0] < 255.0).collect();
        let straight = inner.iter().all(|p| (p[0] - p[1]).abs() < 0.5);
        c.curve = Some(if straight { vec![] } else { inner });
    }
    // the crop, when there is one and it is not turned
    let has_crop = simple(descs, NS_CRS, "HasCrop").map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let angle = num("CropAngle").unwrap_or(0.0);
    if has_crop && angle.abs() < 0.001 {
        if let (Some(l), Some(t), Some(r), Some(b)) = (num("CropLeft"), num("CropTop"), num("CropRight"), num("CropBottom")) {
            if (0.0..=1.0).contains(&l) && (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&r) && (0.0..=1.0).contains(&b) {
                c.crop = Some([l, t, r, b]);
            }
        }
    }
    Some(c)
}

/// The biggest sidecar that is read, and the deepest its elements may be nested (a real one is a few levels deep).
const MAX_SIDECAR_BYTES: usize = 8 * 1024 * 1024;
const MAX_NESTING: usize = 64;

/// How deeply the elements of `xml` are nested, counted from the tags alone (comments and instructions do not count).
fn deepest_nesting(xml: &str) -> usize {
    let b = xml.as_bytes();
    let (mut depth, mut deepest, mut i) = (0usize, 0usize, 0usize);
    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        let end = b[i..].iter().position(|c| *c == b'>').map_or(b.len(), |p| i + p);
        match b.get(i + 1) {
            Some(b'/') => depth = depth.saturating_sub(1),
            Some(b'?') | Some(b'!') => {}
            _ if end > i && b[end - 1] == b'/' => {} // <a/> opens and closes
            _ => {
                depth += 1;
                deepest = deepest.max(depth);
            }
        }
        i = end + 1;
    }
    deepest
}

/// Read a sidecar. Anything it does not understand is ignored; text that is not XMP is an error.
pub fn parse(xml: &str) -> Result<Sidecar, String> {
    // A sidecar is a small, shallow file. One that is huge or nested hundreds deep is damaged or hostile, and reading it would
    // run the program out of stack or memory: it is refused before the XML reader sees it.
    if xml.len() > MAX_SIDECAR_BYTES {
        return Err("it is too big to be a sidecar".into());
    }
    if deepest_nesting(xml) > MAX_NESTING {
        return Err("it is nested too deeply to be a sidecar".into());
    }
    let opts = ParsingOptions { allow_dtd: false, nodes_limit: 200_000, ..Default::default() };
    let doc = Document::parse_with_options(xml.trim_start_matches('\u{FEFF}'), opts).map_err(|e| format!("it is not readable as XMP ({e})"))?;
    let descs: Vec<Node> = doc.descendants().filter(|n| n.is_element() && n.tag_name().namespace() == Some(NS_RDF) && n.tag_name().name() == "Description").collect();
    if descs.is_empty() {
        return Err("it has no XMP description in it".into());
    }
    let ours = doc.root_element().attribute(("adobe:ns:meta/", "xmptk")) == Some("Lucent Raw") || descs.iter().any(|d| d.attribute((NS_LUCENT, "Flag")).is_some());
    let mut sc = Sidecar { ours, ..Default::default() };
    if let Some(r) = simple(&descs, NS_XMP, "Rating").and_then(|v| v.parse::<i64>().ok()) {
        if r == -1 {
            sc.flag = Some(-1)
        } else if (0..=5).contains(&r) {
            sc.rating = Some(r);
        }
    }
    sc.label = simple(&descs, NS_XMP, "Label").and_then(|v| LABELS.iter().find(|(_, n)| n.eq_ignore_ascii_case(&v)).map(|(k, _)| k.to_string()));
    match simple(&descs, NS_LUCENT, "Flag").as_deref() {
        Some("pick") => sc.flag = Some(1),
        Some("reject") => sc.flag = Some(-1),
        Some("none") => sc.flag = Some(0),
        _ => {}
    }
    sc.title = simple(&descs, NS_DC, "title");
    sc.caption = simple(&descs, NS_DC, "description");
    sc.creator = simple(&descs, NS_DC, "creator");
    sc.copyright = simple(&descs, NS_DC, "rights");
    sc.credit = simple(&descs, NS_PS, "Credit");
    sc.source = simple(&descs, NS_PS, "Source");
    sc.sublocation = simple(&descs, NS_IPTC, "Location");
    sc.city = simple(&descs, NS_PS, "City");
    sc.state = simple(&descs, NS_PS, "State");
    sc.country = simple(&descs, NS_PS, "Country");
    sc.headline = simple(&descs, NS_PS, "Headline");
    sc.job_title = simple(&descs, NS_PS, "AuthorsPosition");
    sc.instructions = simple(&descs, NS_PS, "Instructions");
    sc.job_id = simple(&descs, NS_PS, "TransmissionReference");
    sc.usage_terms = simple(&descs, NS_RIGHTS, "UsageTerms");
    let mut paths: Vec<Vec<String>> = vec![];
    for h in list(&descs, NS_LR, "hierarchicalSubject") {
        let p: Vec<String> = h.split('|').map(|s| s.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|s| !s.is_empty()).collect();
        if !p.is_empty() && p.len() <= 3 {
            paths.push(p);
        }
    }
    for k in list(&descs, NS_DC, "subject") {
        let k = k.split_whitespace().collect::<Vec<_>>().join(" ");
        // a flat keyword that is already a level of a hierarchical one is not a keyword of its own
        if !k.is_empty() && !paths.iter().any(|p| p.iter().any(|l| l.eq_ignore_ascii_case(&k))) {
            paths.push(vec![k]);
        }
    }
    sc.keywords = unique(paths.into_iter());
    sc.recipe = simple(&descs, NS_LUCENT, "Recipe").filter(|r| !r.is_empty());
    if !ours {
        sc.crs = read_crs(&descs).filter(|c| !c.is_empty());
    }
    Ok(sc)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full() -> Sidecar {
        Sidecar {
            rating: Some(4),
            flag: Some(1),
            label: Some("blue".into()),
            title: Some("Sunrise & <lake>".into()),
            caption: Some("Line one\nLine \"two\" 'quoted'".into()),
            creator: Some("Bennett".into()),
            copyright: Some("© 2026 Bennett".into()),
            credit: Some("Lucent & Co".into()),
            source: Some("Card 1".into()),
            sublocation: Some("Main <street>".into()),
            city: Some("Paarl".into()),
            state: Some("Western Cape".into()),
            country: Some("South Africa".into()),
            headline: Some("Dawn over the lake".into()),
            job_title: Some("Photographer".into()),
            instructions: Some("Do not crop".into()),
            job_id: Some("JOB-77".into()),
            usage_terms: Some("Editorial use only".into()),
            keywords: vec![vec!["Places".into(), "Lake".into()], vec!["Family".into()]],
            recipe: Some(r#"{"tone":{"exposure":0.5},"note":"a & b < c"}"#.into()),
            ours: true,
            crs: None,
        }
    }

    #[test]
    fn what_is_written_reads_back_the_same_including_awkward_text() {
        let text = write(&full());
        let back = parse(&text).unwrap();
        assert_eq!(back, full());
        assert!(text.starts_with("<?xpacket begin="));
        assert!(text.contains("xmp:Rating=\"4\"") && text.contains("xmp:Label=\"Blue\"") && text.contains("<rdf:li>Places|Lake</rdf:li>"), "{text}");
        // the flat keywords hold every level once
        assert!(text.contains("<rdf:li>Places</rdf:li>") && text.contains("<rdf:li>Lake</rdf:li>") && text.contains("<rdf:li>Family</rdf:li>"));
    }

    #[test]
    fn lightroom_develop_settings_are_read_for_the_ones_that_mean_the_same_and_not_from_our_own_files() {
        let lr = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmp:Rating="3" crs:Version="15.0" crs:Temperature="5600" crs:Tint="+12" crs:Exposure2012="+0.45" crs:Contrast2012="+18"
    crs:Highlights2012="-35" crs:Shadows2012="+22" crs:Whites2012="+5" crs:Blacks2012="-10" crs:Texture="+8" crs:Clarity2012="+6"
    crs:Dehaze="0" crs:Vibrance="+25" crs:Saturation="-4" crs:HueAdjustmentGreen="+10" crs:SaturationAdjustmentBlue="-20"
    crs:LuminanceAdjustmentRed="+7" crs:HasCrop="True" crs:CropTop="0.1" crs:CropLeft="0.05" crs:CropBottom="0.9" crs:CropRight="0.85" crs:CropAngle="0">
   <crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>64, 50</rdf:li><rdf:li>192, 210</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></crs:ToneCurvePV2012>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>"#;
        let sc = parse(lr).unwrap();
        assert!(!sc.ours);
        let crs = sc.crs.clone().expect("Lightroom's settings are read");
        let r = crs.apply_to(&crate::develop::Recipe::default());
        assert_eq!((r.exposure, r.contrast, r.highlights, r.shadows, r.whites, r.blacks), (0.45, 18.0, -35.0, 22.0, 5.0, -10.0));
        assert_eq!((r.texture, r.clarity, r.dehaze, r.vibrance, r.saturation), (8.0, 6.0, 0.0, 25.0, -4.0));
        assert_eq!((r.hsl.hue[3], r.hsl.sat[5], r.hsl.lum[0]), (10.0, -20.0, 7.0), "green hue, blue saturation, red luminance");
        assert_eq!(r.curve, vec![[64.0, 50.0], [192.0, 210.0]], "the curve without its ends");
        let rect = r.crop.rect.unwrap();
        assert!((rect.cx - 0.45).abs() < 1e-6 && (rect.cy - 0.5).abs() < 1e-6 && (rect.w - 0.8).abs() < 1e-6 && (rect.h - 0.8).abs() < 1e-6, "{rect:?}");
        // white balance is left as it was: Kelvin is not the slider here
        assert_eq!((r.temperature, r.tint), (0.0, 0.0));
        // a turned frame is not read as a crop, and a straight curve is no curve
        let turned = lr.replace("crs:CropAngle=\"0\"", "crs:CropAngle=\"2.5\"").replace("<rdf:li>64, 50</rdf:li><rdf:li>192, 210</rdf:li>", "");
        let t = parse(&turned).unwrap().crs.unwrap();
        assert_eq!(t.crop, None);
        assert_eq!(t.curve, Some(vec![]));
        // our own files are never read this way
        let ours = write(&Sidecar { rating: Some(2), ours: true, ..Default::default() });
        assert!(parse(&ours).unwrap().crs.is_none());
    }
    #[test]
    fn a_rejected_photo_is_written_the_standard_way_and_a_pick_is_kept_in_our_own_name() {
        let rej = write(&Sidecar { rating: Some(3), flag: Some(-1), ours: true, ..Default::default() });
        assert!(rej.contains("xmp:Rating=\"-1\"") && rej.contains("lucent:Flag=\"reject\""));
        let back = parse(&rej).unwrap();
        assert_eq!(back.flag, Some(-1));
        assert_eq!(back.rating, None, "the rating is not read from -1");
        let pick = parse(&write(&Sidecar { rating: Some(2), flag: Some(1), ours: true, ..Default::default() })).unwrap();
        assert_eq!((pick.rating, pick.flag), (Some(2), Some(1)));
    }

    #[test]
    fn a_sidecar_from_another_program_is_read_in_both_of_the_ways_xmp_can_be_written() {
        // attributes on the description, as other programs write a rating and a label
        let lr = r#"<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"
    xmlns:lr="http://ns.adobe.com/lightroom/1.0/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmp:Rating="5" xmp:Label="Green" crs:Exposure2012="+0.50">
   <dc:title><rdf:Alt><rdf:li xml:lang="fr">Titre</rdf:li><rdf:li xml:lang="x-default">Title</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>Someone</rdf:li><rdf:li>Else</rdf:li></rdf:Seq></dc:creator>
   <dc:subject><rdf:Bag><rdf:li>Beach</rdf:li><rdf:li>Sand</rdf:li><rdf:li>Solo</rdf:li></rdf:Bag></dc:subject>
   <lr:hierarchicalSubject><rdf:Bag><rdf:li>Places|Beach</rdf:li><rdf:li>Things|Sand|Fine|Too|Deep</rdf:li></rdf:Bag></lr:hierarchicalSubject>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"#;
        let sc = parse(lr).unwrap();
        assert!(!sc.ours, "it was not written by this app, so it must not be overwritten");
        assert_eq!((sc.rating, sc.label.as_deref(), sc.title.as_deref(), sc.creator.as_deref()), (Some(5), Some("green"), Some("Title"), Some("Someone")));
        // too deep a path is left out; flat words that are a level of a path are not repeated; the rest stay
        assert!(sc.keywords.contains(&vec!["Places".to_string(), "Beach".to_string()]));
        assert!(sc.keywords.contains(&vec!["Solo".to_string()]) && sc.keywords.contains(&vec!["Sand".to_string()]));
        assert!(!sc.keywords.contains(&vec!["Beach".to_string()]));
        assert!(sc.keywords.iter().all(|p| p.len() <= 3));
        // the same things as plain elements
        let plain = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/"><xmp:Rating>3</xmp:Rating><xmp:Label>Purple</xmp:Label></rdf:Description></rdf:RDF></x:xmpmeta>"#;
        let p = parse(plain).unwrap();
        assert_eq!((p.rating, p.label.as_deref()), (Some(3), Some("purple")));
    }

    #[test]
    fn nonsense_odd_values_and_dangerous_xml_are_refused_or_ignored() {
        assert!(parse("not xml at all").is_err());
        assert!(parse("<a><b/></a>").unwrap_err().contains("no XMP description"));
        // a document type (where entity tricks live) is refused
        let bomb = r#"<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description>&a;</rdf:Description></rdf:RDF></x:xmpmeta>"#;
        assert!(parse(bomb).is_err());
        // a rating out of range, an unknown label, an unknown flag: ignored
        let odd = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          <rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:lucent="http://ns.lucentraw.app/1.0/" xmp:Rating="99" xmp:Label="To Do" lucent:Flag="maybe"/></rdf:RDF></x:xmpmeta>"#;
        let s = parse(odd).unwrap();
        assert_eq!((s.rating, s.label, s.flag), (None, None, None));
        assert!(s.ours, "the marker is there even when its value is not understood");
        // control characters never reach the file
        let w = write(&Sidecar { title: Some("a\u{0}b\u{7}c".into()), ours: true, ..Default::default() });
        assert!(parse(&w).is_ok() && w.contains("abc"));
    }

    #[test]
    fn a_sidecar_sits_beside_a_raw_file_as_name_xmp_and_beside_anything_else_as_name_ext_xmp() {
        assert_eq!(sidecar_path(Path::new("D:/p/IMG_1.CR2"), true), PathBuf::from("D:/p/IMG_1.xmp"));
        assert_eq!(sidecar_path(Path::new("D:/p/IMG_1.jpg"), false), PathBuf::from("D:/p/IMG_1.jpg.xmp"));
        assert_ne!(sidecar_path(Path::new("D:/p/IMG_1.jpg"), false), sidecar_path(Path::new("D:/p/IMG_1.CR2"), true), "a RAW and a JPEG do not share one");
    }

    #[test]
    fn an_empty_sidecar_still_carries_the_marker_and_a_default_photo_writes_nothing_else() {
        let t = write(&Sidecar { ours: true, ..Default::default() });
        assert!(t.contains("lucent:Flag=\"none\"") && !t.contains("xmp:Rating") && !t.contains("dc:title") && !t.contains("Recipe"));
        let back = parse(&t).unwrap();
        assert!(back.ours && back.keywords.is_empty() && back.recipe.is_none());
    }
}
