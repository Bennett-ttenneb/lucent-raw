//! Smart collections: a collection that fills itself. It is a list of rules ("rating at least 4", "camera contains Canon",
//! "taken in the last 30 days") and whether a photo has to meet all of them or any one; the photos in it are whatever meets the
//! rules now, so it changes as the catalog does.
//!
//! The rules are checked here, and turned into one SQL condition for the catalog's photo list. Every value reaches the database
//! as a bound value, never as part of the SQL text, and only the fields and tests listed below exist.

use rusqlite::types::Value;
use serde::{Deserialize, Serialize};

pub const MAX_RULES: usize = 12;
/// Groups inside groups, at most this deep (the top list is level 1).
pub const MAX_DEPTH: usize = 3;
/// All the rules of a smart collection together, groups included.
pub const MAX_TOTAL_RULES: usize = 30;
const MAX_TEXT: usize = 100;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Rule {
    /// rating, flag, label, keyword, camera, lens, iso, focal, aperture, date, format, edited, text, missing, copy, collection
    pub field: String,
    /// what is tested (">=", "=", "<=", "is", "contains", "after", "before", "on", "last")
    pub op: String,
    /// the value, as text (numbers and dates are read from it)
    pub value: String,
    /// the rule is turned round: "does not meet it" (a photo with nothing to look at, such as no ISO, meets the turned-round rule)
    pub negate: bool,
    /// For a "group" rule: the rules inside it, with their own all or any.
    pub group: Option<Box<SmartRules>>,
}

impl Default for Rule {
    fn default() -> Self {
        Rule { field: "rating".into(), op: ">=".into(), value: "3".into(), negate: false, group: None }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SmartRules {
    /// "all": a photo must meet every rule. "any": one is enough.
    pub mode: String,
    pub rules: Vec<Rule>,
}

impl Default for SmartRules {
    fn default() -> Self {
        SmartRules { mode: "all".into(), rules: vec![] }
    }
}

const NUMBER_OPS: &[&str] = &[">=", "=", "<="];
const FORMATS: &[&str] = &["raw", "dng", "jpeg", "tiff", "png", "heic"];
const LABELS: &[&str] = &["red", "yellow", "green", "blue", "purple"];

/// The tests each field has.
pub fn ops_for(field: &str) -> &'static [&'static str] {
    match field {
        "rating" | "iso" | "focal" | "aperture" => NUMBER_OPS,
        "flag" | "label" | "format" | "edited" | "missing" | "copy" | "collection" => &["is"],
        "keyword" => &["is", "contains"],
        "camera" | "lens" | "text" => &["contains"],
        "date" => &["after", "before", "on", "last"],
        "group" => &["group"],
        _ => &[],
    }
}

fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && s.chars().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) && {
        let (m, d) = (s[5..7].parse::<u32>().unwrap_or(0), s[8..10].parse::<u32>().unwrap_or(0));
        (1..=12).contains(&m) && (1..=31).contains(&d)
    }
}

fn like(s: &str) -> String {
    format!("%{}%", s.trim().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

impl Rule {
    /// Is this rule one the catalog can answer? The reason in words, if not.
    pub fn check(&self) -> Result<(), String> {
        if self.field == "group" {
            return Ok(()); // what is inside is checked with the rules around it
        }
        let ops = ops_for(&self.field);
        if ops.is_empty() {
            return Err(format!("\"{}\" is not something a rule can look at.", self.field));
        }
        if !ops.contains(&self.op.as_str()) {
            return Err(format!("A rule on {} cannot use \"{}\".", self.field, self.op));
        }
        let v = self.value.trim();
        let bad = |what: &str| Err(format!("The value for {} must be {what}.", self.field));
        if v.chars().count() > MAX_TEXT {
            return bad("100 letters at most");
        }
        match self.field.as_str() {
            "rating" if !matches!(v.parse::<i64>(), Ok(0..=5)) => bad("a number from 0 to 5"),
            "iso" if !matches!(v.parse::<i64>(), Ok(1..=10_000_000)) => bad("a whole number"),
            "focal" | "aperture" if !v.parse::<f64>().map(|n| n.is_finite() && n > 0.0 && n < 100_000.0).unwrap_or(false) => bad("a number above 0"),
            "flag" if !["pick", "reject", "unflagged"].contains(&v) => bad("pick, reject or unflagged"),
            "label" if !(LABELS.contains(&v) || v == "none") => bad("a colour label or none"),
            "format" if !FORMATS.contains(&v) => bad("a file type such as raw, jpeg or png"),
            "edited" | "missing" | "copy" if !["yes", "no"].contains(&v) => bad("yes or no"),
            "collection" if !matches!(v.parse::<i64>(), Ok(1..=i64::MAX)) => bad("a collection"),
            "date" if self.op == "last" && !matches!(v.parse::<i64>(), Ok(1..=36_500)) => bad("a number of days"),
            "date" if self.op != "last" && !is_day(v) => bad("a date like 2026-10-18"),
            "keyword" | "camera" | "lens" | "text" if v.is_empty() => bad("some text"),
            _ => Ok(()),
        }
    }
}

impl SmartRules {
    /// Every rule checked, with the number of the first one that is wrong.
    pub fn validate(&self) -> Result<(), String> {
        let mut total = 0;
        self.validate_at(1, "", &mut total)
    }

    /// `depth` is how many lists down this is, `path` names the rule it sits in ("2." for a group that is rule 2).
    fn validate_at(&self, depth: usize, path: &str, total: &mut usize) -> Result<(), String> {
        if self.mode != "all" && self.mode != "any" {
            return Err("Say whether a photo must meet all of the rules or any of them.".into());
        }
        if self.rules.is_empty() {
            return Err(if depth == 1 { "Add at least one rule.".into() } else { format!("Rule {}: a group needs at least one rule in it.", path.trim_end_matches('.')) });
        }
        if self.rules.len() > MAX_RULES {
            return Err(format!("A list of rules can have {MAX_RULES} rules at most."));
        }
        for (i, r) in self.rules.iter().enumerate() {
            *total += 1;
            if *total > MAX_TOTAL_RULES {
                return Err(format!("A smart collection can have {MAX_TOTAL_RULES} rules in all, groups included."));
            }
            let here = format!("{path}{}", i + 1);
            if r.field == "group" {
                let Some(g) = &r.group else { return Err(format!("Rule {here}: a group has no rules in it.")) };
                if depth >= MAX_DEPTH {
                    return Err(format!("Rule {here}: groups can only go {MAX_DEPTH} deep."));
                }
                g.validate_at(depth + 1, &format!("{here}."), total)?;
                continue;
            }
            r.check().map_err(|e| format!("Rule {here}: {e}"))?;
        }
        Ok(())
    }

    /// The condition as SQL for a query that has `photo p` and `exif e` in it, with its bound values. The rules must be valid.
    pub fn to_sql(&self, camera_sql: &str, day_sql: &str) -> (String, Vec<Value>) {
        let mut parts: Vec<String> = vec![];
        let mut args: Vec<Value> = vec![];
        for r in &self.rules {
            let before = parts.len();
            let v = r.value.trim();
            let num = |column: &str, args: &mut Vec<Value>, parts: &mut Vec<String>| {
                let n: f64 = v.parse().unwrap_or(0.0);
                let op = r.op.as_str();
                if op == "=" && (column == "e.focal_mm" || column == "e.aperture") {
                    let slack = if column == "e.focal_mm" { 0.5 } else { 0.05 };
                    parts.push(format!("abs({column} - ?) <= {slack}"));
                } else {
                    parts.push(format!("{column} {op} ?"));
                }
                args.push(Value::Real(n));
            };
            match r.field.as_str() {
                "rating" => {
                    parts.push(format!("p.rating {} ?", r.op));
                    args.push(Value::Integer(v.parse().unwrap_or(0)));
                }
                "iso" => {
                    parts.push(format!("e.iso {} ?", r.op));
                    args.push(Value::Integer(v.parse().unwrap_or(0)));
                }
                "focal" => num("e.focal_mm", &mut args, &mut parts),
                "aperture" => num("e.aperture", &mut args, &mut parts),
                "flag" => parts.push(match v {
                    "pick" => "p.flag = 1".into(),
                    "reject" => "p.flag = -1".into(),
                    _ => "p.flag = 0".into(),
                }),
                "label" => {
                    if v == "none" {
                        parts.push("p.color_label is null".into());
                    } else {
                        parts.push("p.color_label = ?".into());
                        args.push(Value::Text(v.into()));
                    }
                }
                "keyword" if r.op == "is" => {
                    // the keyword and everything below it
                    parts.push(
                        "p.id in (select photo_id from photo_keyword where keyword_id in (
                            with recursive sub(id) as (
                                select id from keyword where name = ? collate nocase
                                union all
                                select k.id from keyword k join sub on k.parent_id = sub.id
                            ) select id from sub))"
                            .into(),
                    );
                    args.push(Value::Text(v.into()));
                }
                "keyword" => {
                    parts.push("p.id in (select pk.photo_id from photo_keyword pk join keyword k on k.id = pk.keyword_id where k.name like ? escape '\\')".into());
                    args.push(Value::Text(like(v)));
                }
                "camera" => {
                    parts.push(format!("{camera_sql} like ? escape '\\'"));
                    args.push(Value::Text(like(v)));
                }
                "lens" => {
                    parts.push("e.lens like ? escape '\\'".into());
                    args.push(Value::Text(like(v)));
                }
                "date" => match r.op.as_str() {
                    "after" => (parts.push(format!("{day_sql} > ?")), args.push(Value::Text(v.into()))).0,
                    "before" => (parts.push(format!("{day_sql} < ?")), args.push(Value::Text(v.into()))).0,
                    "on" => (parts.push(format!("{day_sql} = ?")), args.push(Value::Text(v.into()))).0,
                    _ => (parts.push(format!("{day_sql} >= date('now', 'localtime', ?)")), args.push(Value::Text(format!("-{} days", v.parse::<i64>().unwrap_or(1))))).0,
                },
                "format" => {
                    parts.push("p.format = ?".into());
                    args.push(Value::Text(v.into()));
                }
                "edited" => parts.push(format!("{}exists(select 1 from develop_settings d where d.photo_id = p.id)", if v == "yes" { "" } else { "not " })),
                "missing" => parts.push(format!("p.missing = {}", if v == "yes" { 1 } else { 0 })),
                "copy" => parts.push(format!("p.master_id is {}null", if v == "yes" { "not " } else { "" })),
                "collection" => {
                    parts.push("p.id in (select photo_id from collection_photo where collection_id = ?)".into());
                    args.push(Value::Integer(v.parse().unwrap_or(0)));
                }
                "text" => {
                    parts.push(
                        "((p.base_name || '.' || p.ext) like ? escape '\\' or exists(select 1 from iptc i where i.photo_id = p.id and
                            (i.title like ? escape '\\' or i.caption like ? escape '\\' or i.creator like ? escape '\\' or i.copyright like ? escape '\\')))"
                            .into(),
                    );
                    for _ in 0..5 {
                        args.push(Value::Text(like(v)));
                    }
                }
                "group" => {
                    if let Some(g) = &r.group {
                        let (sql, a) = g.to_sql(camera_sql, day_sql);
                        parts.push(sql);
                        args.extend(a);
                    }
                }
                _ => {}
            }
            // "does not meet": turned round, where a photo with nothing to look at counts as not meeting the rule
            if r.negate && parts.len() > before {
                let last = parts.pop().unwrap_or_default();
                parts.push(format!("not coalesce(({last}), 0)"));
            }
        }
        let joiner = if self.mode == "any" { " or " } else { " and " };
        (format!("({})", parts.join(joiner)), args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(field: &str, op: &str, value: &str) -> Rule {
        Rule { field: field.into(), op: op.into(), value: value.into(), ..Default::default() }
    }

    #[test]
    fn every_field_has_its_tests_and_a_made_up_one_has_none() {
        for f in ["rating", "flag", "label", "keyword", "camera", "lens", "iso", "focal", "aperture", "date", "format", "edited", "text", "missing", "copy", "collection"] {
            assert!(!ops_for(f).is_empty(), "{f}");
        }
        assert!(ops_for("password").is_empty() && ops_for("").is_empty() && ops_for("p.id; drop table photo").is_empty());
    }

    #[test]
    fn rules_are_checked_and_the_first_wrong_one_is_named_in_words() {
        let ok = SmartRules { mode: "all".into(), rules: vec![rule("rating", ">=", "4"), rule("date", "last", "30"), rule("camera", "contains", "Canon"), rule("label", "is", "none"), rule("edited", "is", "yes")] };
        assert!(ok.validate().is_ok());
        let bad = |r: Rule| SmartRules { mode: "all".into(), rules: vec![rule("rating", ">=", "1"), r] }.validate().unwrap_err();
        assert!(bad(rule("rating", ">=", "9")).starts_with("Rule 2:") && bad(rule("rating", ">=", "9")).contains("0 to 5"));
        assert!(bad(rule("rating", "contains", "3")).contains("cannot use"));
        assert!(bad(rule("nothing", "is", "x")).contains("not something"));
        assert!(bad(rule("date", "on", "18/10/2026")).contains("a date like"));
        assert!(bad(rule("date", "last", "0")).contains("number of days"));
        assert!(bad(rule("date", "on", "2026-13-40")).contains("a date like"));
        assert!(bad(rule("flag", "is", "maybe")).contains("pick, reject"));
        assert!(bad(rule("keyword", "is", "  ")).contains("some text"));
        assert!(bad(rule("camera", "contains", &"x".repeat(101))).contains("100 letters"));
        assert!(bad(rule("iso", ">=", "1.5")).contains("whole number"));
        assert!(bad(rule("aperture", "=", "-2")).contains("above 0"));
        assert!(SmartRules { mode: "all".into(), rules: vec![] }.validate().unwrap_err().contains("at least one"));
        assert!(SmartRules { mode: "some".into(), rules: vec![rule("rating", ">=", "1")] }.validate().unwrap_err().contains("all of the rules or any"));
        assert!(SmartRules { mode: "all".into(), rules: vec![rule("rating", ">=", "1"); 13] }.validate().unwrap_err().contains("12 rules"));
    }

    #[test]
    fn values_are_always_bound_never_part_of_the_sql_and_all_or_any_joins_the_rules() {
        let nasty = "x'; drop table photo; --";
        let r = SmartRules { mode: "any".into(), rules: vec![rule("camera", "contains", nasty), rule("rating", ">=", "4"), rule("text", "contains", "50%_off")] };
        let (sql, args) = r.to_sql("CAM", "DAY");
        assert!(!sql.contains("drop") && !sql.contains(nasty) && sql.contains(" or "), "{sql}");
        assert!(sql.starts_with('(') && sql.ends_with(')'));
        assert_eq!(args.len(), 1 + 1 + 5);
        assert!(matches!(&args[0], Value::Text(t) if t.contains("drop table")), "the text is a value");
        assert!(matches!(&args[2], Value::Text(t) if t == "%50\\%\\_off%"), "like characters are escaped: {:?}", args[2]);
        let all = SmartRules { mode: "all".into(), rules: r.rules.clone() }.to_sql("CAM", "DAY").0;
        assert!(all.contains(" and ") && !all.contains(" or exists") || all.contains(" and "));
    }

    fn group(mode: &str, rules: Vec<Rule>) -> Rule {
        Rule { field: "group".into(), op: "group".into(), value: String::new(), negate: false, group: Some(Box::new(SmartRules { mode: mode.into(), rules })) }
    }

    #[test]
    fn a_rule_can_be_turned_round_and_rules_can_be_grouped_inside_each_other() {
        let not = Rule { negate: true, ..rule("label", "is", "red") };
        let r = SmartRules { mode: "all".into(), rules: vec![not, group("any", vec![rule("rating", ">=", "4"), rule("flag", "is", "pick")])] };
        assert!(r.validate().is_ok());
        let (sql, args) = r.to_sql("CAM", "DAY");
        assert!(sql.contains("not coalesce((p.color_label = ?), 0)") && sql.contains(" or ") && sql.contains(" and "), "{sql}");
        assert_eq!(args.len(), 2, "the label and the rating: the pick has no value");
        // a group with nothing in it, a group that is too deep, and too many rules in all are refused in words
        assert!(SmartRules { mode: "all".into(), rules: vec![group("any", vec![])] }.validate().unwrap_err().contains("Rule 1: a group needs at least one rule"));
        let deep = group("all", vec![group("all", vec![group("all", vec![rule("rating", ">=", "1")])])]);
        assert!(SmartRules { mode: "all".into(), rules: vec![deep] }.validate().unwrap_err().contains("3 deep"));
        let many = SmartRules { mode: "all".into(), rules: (0..4).map(|_| group("all", vec![rule("rating", ">=", "1"); 8])).collect() };
        assert!(many.validate().unwrap_err().contains("30 rules in all"));
        assert!(SmartRules { mode: "all".into(), rules: vec![Rule { field: "group".into(), op: "group".into(), ..Default::default() }] }.validate().unwrap_err().contains("no rules in it"));
        // an error inside a group names it by its place
        let bad = SmartRules { mode: "all".into(), rules: vec![rule("rating", ">=", "1"), group("any", vec![rule("rating", ">=", "1"), rule("rating", ">=", "9")])] };
        assert!(bad.validate().unwrap_err().starts_with("Rule 2.2:"));
        // older rules without the new fields still load
        let old: SmartRules = serde_json::from_str("{\"mode\":\"all\",\"rules\":[{\"field\":\"rating\",\"op\":\">=\",\"value\":\"2\"}]}").unwrap();
        assert!(!old.rules[0].negate && old.rules[0].group.is_none());
    }

    #[test]
    fn json_round_trips_and_a_short_one_gets_defaults() {
        let r = SmartRules { mode: "any".into(), rules: vec![rule("keyword", "is", "Places")] };
        let j = serde_json::to_string(&r).unwrap();
        assert!(j.contains("\"mode\":\"any\"") && j.contains("\"field\":\"keyword\""));
        assert_eq!(serde_json::from_str::<SmartRules>(&j).unwrap(), r);
        let s: SmartRules = serde_json::from_str("{}").unwrap();
        assert_eq!((s.mode.as_str(), s.rules.len()), ("all", 0));
    }
}
