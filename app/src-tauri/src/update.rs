//! Looking for a newer version.
//!
//! When the person leaves it switched on, the program asks GitHub once, as it starts, for the list of Lucent Raw's
//! releases, and says so when one is newer than the one running. That request carries nothing about the person, their
//! photos or their catalog: GitHub sees the computer's internet address and the words "LucentRaw/<version>", as any
//! web site does. Nothing is downloaded or installed here; the person is shown the release page and decides.

use serde::Serialize;

const RELEASES_API: &str = "https://api.github.com/repos/Bennett-ttenneb/lucent-raw/releases?per_page=30";
pub const RELEASES_PAGE: &str = "https://github.com/Bennett-ttenneb/lucent-raw/releases";

/// Where the "Buy the developer a coffee" button goes: a PayPal donation page made from the developer's PayPal address. Making this
/// empty hides the button everywhere. It is a fixed address in the program, never one that anything can hand it.
pub const DONATE_URL: &str = "https://www.paypal.com/donate/?business=bbotnicsindustries%40gmail.com&item_name=Lucent+Raw+%28buy+the+developer+a+coffee%29&no_recurring=0&currency_code=USD";

/// The donation page, or nothing when there is none (empty, or not an https address).
pub fn donate_url() -> Option<&'static str> {
    DONATE_URL.starts_with("https://").then_some(DONATE_URL)
}

/// A version as numbers that sort: major, minor, patch, then the test build number (a finished release, with no
/// "-testN", sorts after every test build of the same version). "v0.1.0-test17" and "0.1.0-test17" are the same.
/// Anything that is not exactly that shape is not a version: it is never put into an address or shown.
pub fn parse_version(v: &str) -> Option<(u32, u32, u32, u32)> {
    let v = v.trim();
    let v = v.strip_prefix('v').unwrap_or(v);
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (v, None),
    };
    let mut parts = core.split('.');
    let mut num = || parts.next().filter(|p| !p.is_empty() && p.len() <= 6 && p.bytes().all(|b| b.is_ascii_digit())).and_then(|p| p.parse::<u32>().ok());
    let (a, b, c) = (num()?, num()?, num()?);
    if parts.next().is_some() {
        return None;
    }
    let test = match pre {
        None => u32::MAX,
        Some(p) => {
            let n = p.strip_prefix("test")?;
            if n.is_empty() || n.len() > 6 || !n.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            n.parse().ok()?
        }
    };
    Some((a, b, c, test))
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    /// The version that is running.
    pub current: String,
    /// The newest version published, when it is newer than the one running.
    pub latest: Option<String>,
    /// The page of that release.
    pub url: Option<String>,
}

/// The page of a release. The version is checked first, so nothing but digits, dots and "-test" can be in the address.
pub fn release_url(version: &str) -> Option<String> {
    parse_version(version)?;
    let v = version.trim();
    Some(format!("{RELEASES_PAGE}/tag/v{}", v.strip_prefix('v').unwrap_or(v)))
}

/// What GitHub's list of releases says about `current`: the newest published version, if it is newer. Drafts are
/// skipped, and so is anything whose name is not a version.
pub fn newest(current: &str, releases_json: &str) -> Result<Update, String> {
    let mine = parse_version(current).ok_or("This copy has no version number to compare.")?;
    let list: serde_json::Value = serde_json::from_str(releases_json).map_err(|_| "The answer from GitHub could not be read.".to_string())?;
    let list = list.as_array().ok_or("The answer from GitHub could not be read.")?;
    let best = list
        .iter()
        .filter(|r| r.get("draft").and_then(|d| d.as_bool()) != Some(true))
        .filter_map(|r| r.get("tag_name").and_then(|t| t.as_str()))
        .filter_map(|t| parse_version(t).map(|v| (v, t)))
        .max_by_key(|(v, _)| *v);
    Ok(match best {
        Some((v, tag)) if v > mine => {
            let tag = tag.trim();
            let version = tag.strip_prefix('v').unwrap_or(tag).to_string();
            Update { current: current.to_string(), url: release_url(&version), latest: Some(version) }
        }
        _ => Update { current: current.to_string(), latest: None, url: None },
    })
}

/// Ask GitHub. Fails (with words for the person) when there is no internet or GitHub does not answer in a few seconds.
pub fn check(current: &str) -> Result<Update, String> {
    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(8)).redirects(0).build();
    let answer = agent
        .get(RELEASES_API)
        .set("User-Agent", &format!("LucentRaw/{current}"))
        .set("Accept", "application/vnd.github+json")
        .call()
        .map_err(|_| "GitHub could not be reached. Check your internet connection and try again.".to_string())?;
    // the list is a few thousand characters; a megabyte is far more than it could honestly be
    let mut text = String::new();
    use std::io::Read;
    answer.into_reader().take(1024 * 1024).read_to_string(&mut text).map_err(|_| "The answer from GitHub could not be read.".to_string())?;
    newest(current, &text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_donate_address_is_a_secure_address_on_a_payment_site_or_there_is_none() {
        match donate_url() {
            None => assert!(DONATE_URL.is_empty()),
            Some(u) => {
                let host = u.trim_start_matches("https://").split(['/', '?']).next().unwrap();
                assert!(["www.paypal.com", "paypal.me", "www.buymeacoffee.com", "buymeacoffee.com", "ko-fi.com"].contains(&host), "{host}");
                assert!(!u.contains(' ') && !u.contains('"'), "an address with no stray characters");
            }
        }
    }

    #[test]
    fn versions_sort_by_number_and_a_finished_release_beats_its_test_builds() {
        assert_eq!(parse_version("v0.1.0-test17"), Some((0, 1, 0, 17)));
        assert_eq!(parse_version("0.1.0-test17"), parse_version("v0.1.0-test17"));
        assert!(parse_version("0.1.0-test9") < parse_version("0.1.0-test17"), "17 is after 9, not before it");
        assert!(parse_version("0.1.0-test99") < parse_version("0.1.0"));
        assert!(parse_version("0.1.0") < parse_version("0.2.0-test1"));
        assert!(parse_version("1.0.0") > parse_version("0.9.9"));
    }

    #[test]
    fn anything_that_is_not_a_version_is_refused() {
        for bad in ["", "v", "model-assets", "1.0", "1.0.0.0", "1.0.0-beta", "1.0.0-test", "1.0.0-test1x", "1.0.x", "v1.0.0/../../evil", "1.0.0-test1?x=1", "９.0.0", "1.0.0-test-1", "9999999.0.0"] {
            assert_eq!(parse_version(bad), None, "{bad:?}");
            assert_eq!(release_url(bad), None, "{bad:?}");
        }
        assert_eq!(release_url("0.1.0-test18").as_deref(), Some("https://github.com/Bennett-ttenneb/lucent-raw/releases/tag/v0.1.0-test18"));
    }

    #[test]
    fn the_newest_release_is_offered_only_when_it_is_newer_and_drafts_and_other_tags_are_skipped() {
        let list = r#"[
            {"tag_name": "v0.1.0-test16", "draft": false, "prerelease": true, "html_url": "https://evil.example/x"},
            {"tag_name": "v0.1.0-test18", "draft": false, "prerelease": true},
            {"tag_name": "v0.1.0-test30", "draft": true},
            {"tag_name": "model-assets", "draft": false},
            {"tag_name": "v9.9.9/../../x", "draft": false},
            {"name": "no tag"}
        ]"#;
        let u = newest("0.1.0-test17", list).unwrap();
        assert_eq!(u.latest.as_deref(), Some("0.1.0-test18"));
        // the address is built here from the checked version, never taken from the answer
        assert_eq!(u.url.as_deref(), Some("https://github.com/Bennett-ttenneb/lucent-raw/releases/tag/v0.1.0-test18"));
        assert_eq!(newest("0.1.0-test18", list).unwrap().latest, None, "already on the newest");
        assert_eq!(newest("0.1.0", list).unwrap().latest, None, "a finished release is newer than its test builds");
        assert!(newest("0.1.0-test17", "<html>not json</html>").is_err());
        assert!(newest("0.1.0-test17", r#"{"message": "rate limit"}"#).is_err());
        assert_eq!(newest("0.1.0-test17", "[]").unwrap().latest, None);
    }
}
