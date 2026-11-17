//! The licence: a 30 day trial, then a key bought once.
//!
//! Everything works on this computer with no internet. A key is `LRAW1.<payload>.<signature>`: the payload is a small piece of JSON
//! (who it was issued to, which edition) and the signature is Ed25519, made by a private key that only the seller holds
//! (`tools/licence.mjs`). The program holds only the public key, so it can check a key but cannot make one.
//!
//! A key never expires. It belongs to an edition (the first number of the version it was bought for), and works for every version
//! of that edition and earlier ones. After the trial, editing stops (saving changes to a photo is refused); opening the catalog,
//! browsing, rating, keywording and exporting keep working, so nobody's photos or work are ever locked inside the program.
//!
//! This is honest-person licensing: it does not try to stop a determined person, because anything that runs on a computer with
//! no server can be got round, and fighting that would only make the program worse for the people who paid.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::NaiveDate;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

/// Lucent Raw is free: nothing is locked after the trial, and no key is needed. Set this to false to bring the 30 day trial back.
pub const FREE: bool = true;
pub const TRIAL_DAYS: i64 = 30;
/// The seller's public key (see tools/licence.mjs). Replace it before the first sale if the private key is ever lost or shown.
pub const PUBLIC_KEY: [u8; 32] = [81, 233, 225, 186, 37, 49, 253, 155, 84, 104, 112, 198, 63, 10, 119, 57, 193, 16, 189, 47, 89, 104, 82, 127, 88, 89, 230, 14, 36, 159, 218, 109];

static LOCKED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Serialize, Deserialize, Clone, Default, PartialEq)]
pub struct File {
    /// the day the program was first started on this computer, as 2026-10-19
    pub first_run: String,
    /// the latest day it has seen, so putting the clock back does not give more trial days
    pub last_seen: String,
    pub key: Option<String>,
}

#[derive(Debug, Deserialize, Clone, PartialEq)]
pub struct Payload {
    pub name: String,
    pub email: String,
    pub edition: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// "licensed", "trial" or "expired"
    pub state: String,
    pub days_left: i64,
    pub trial_days: i64,
    /// who the licence is for
    pub name: Option<String>,
    /// said when a key is stored but is not usable (wrong edition, damaged)
    pub problem: Option<String>,
}

/// Check a key against a public key. Returns what it says, or why it is not good.
pub fn verify_with(public: &[u8; 32], key: &str) -> Result<Payload, String> {
    let bad = || "That is not a Lucent Raw licence key. Check that all of it was copied, with nothing added.".to_string();
    let parts: Vec<&str> = key.trim().split('.').collect();
    if parts.len() != 3 || parts[0] != "LRAW1" {
        return Err(bad());
    }
    let sig_bytes = URL_SAFE_NO_PAD.decode(parts[2]).map_err(|_| bad())?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| bad())?;
    let vk = VerifyingKey::from_bytes(public).map_err(|_| bad())?;
    vk.verify(parts[1].as_bytes(), &sig).map_err(|_| "That key was not made by Lucent Raw, or it has been changed.".to_string())?;
    let json = URL_SAFE_NO_PAD.decode(parts[1]).map_err(|_| bad())?;
    serde_json::from_slice::<Payload>(&json).map_err(|_| bad())
}

/// A key of edition N works in every version whose first number is N or less.
pub fn edition_ok(edition: &str, app_version: &str) -> bool {
    let e: u32 = edition.trim().parse().unwrap_or(0);
    let major: u32 = app_version.split('.').next().and_then(|m| m.parse().ok()).unwrap_or(0);
    e >= major.max(1)
}

fn day(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}

/// The status on `today`, from what is stored. Pure, so it can be tested with any dates.
pub fn status_for(file: &File, today: NaiveDate, public: &[u8; 32], app_version: &str) -> Status {
    let mut problem = None;
    if let Some(k) = &file.key {
        match verify_with(public, k) {
            Ok(p) if edition_ok(&p.edition, app_version) => {
                return Status { state: "licensed".into(), days_left: 0, trial_days: TRIAL_DAYS, name: Some(p.name), problem: None };
            }
            Ok(p) => problem = Some(format!("This key is for version {} and earlier. This is version {app_version}, which needs a newer key.", p.edition)),
            Err(e) => problem = Some(e),
        }
    }
    let start = day(&file.first_run).unwrap_or(today);
    // the clock is never believed if it has gone back
    let now = day(&file.last_seen).map(|s| s.max(today)).unwrap_or(today);
    let used = (now - start).num_days().max(0);
    let left = (TRIAL_DAYS - used).max(0);
    Status { state: if left > 0 { "trial" } else { "expired" }.into(), days_left: left, trial_days: TRIAL_DAYS, name: None, problem }
}

/// Read the stored file, or start one today. Writes the latest day seen back.
pub fn load(path: &Path, today: NaiveDate) -> File {
    let mut f: File = std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if day(&f.first_run).is_none() {
        f.first_run = today.format("%Y-%m-%d").to_string();
    }
    let seen = day(&f.last_seen).map(|s| s.max(today)).unwrap_or(today);
    f.last_seen = seen.format("%Y-%m-%d").to_string();
    save(path, &f);
    f
}

pub fn save(path: &Path, f: &File) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, serde_json::to_string_pretty(f).unwrap_or_default());
}

/// Whether the program enforces the trial. A debug build (the one used while building the program) does not, unless asked to, so
/// the developer is never locked out; every release build does.
pub fn enforced() -> bool {
    !FREE && (!cfg!(debug_assertions) || std::env::var("LUCENT_ENFORCE_LICENCE").map(|v| v == "1").unwrap_or(false))
}

/// Remember whether editing is allowed, for the places that save an edit.
pub fn apply(status: &Status) {
    LOCKED.store(enforced() && status.state == "expired", Ordering::SeqCst);
}

/// Called before an edit to a photo is saved.
pub fn editing_allowed() -> Result<(), String> {
    gate(LOCKED.load(Ordering::SeqCst))
}

fn gate(locked: bool) -> Result<(), String> {
    if locked {
        Err("Your 30 day trial has ended, so edits cannot be saved. Enter a licence key in Preferences to carry on. Everything else, including opening your catalog and exporting, still works.".into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }
    fn make(seed: u8, edition: &str) -> (String, [u8; 32]) {
        let sk = SigningKey::from_bytes(&[seed; 32]);
        let payload = URL_SAFE_NO_PAD.encode(format!(r#"{{"v":1,"name":"Ada","email":"ada@example.com","edition":"{edition}","issued":"2026-10-19"}}"#));
        let sig = sk.sign(payload.as_bytes());
        (format!("LRAW1.{payload}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes())), sk.verifying_key().to_bytes())
    }
    fn file(first: &str, seen: &str, key: Option<&str>) -> File {
        File { first_run: first.into(), last_seen: seen.into(), key: key.map(String::from) }
    }

    /// Run with LUCENT_TEST_KEY set to a key made by tools/licence.mjs to prove the tool and the program agree. (A real key is never stored in the project.)
    #[test]
    fn a_key_made_by_the_tool_is_accepted_by_the_built_in_public_key() {
        if let Ok(k) = std::env::var("LUCENT_TEST_KEY") {
            assert!(verify_with(&PUBLIC_KEY, &k).is_ok());
        }
    }

    #[test]
    fn the_built_in_public_key_is_a_valid_point() {
        assert!(VerifyingKey::from_bytes(&PUBLIC_KEY).is_ok());
    }

    #[test]
    fn a_trial_lasts_thirty_days_counting_from_the_first_start_then_stops() {
        let pk = [0u8; 32];
        let f = file("2026-10-01", "2026-10-01", None);
        assert_eq!(status_for(&f, d("2026-10-01"), &pk, "1.0.0").days_left, 30);
        assert_eq!(status_for(&f, d("2026-10-30"), &pk, "1.0.0").days_left, 1);
        assert_eq!(status_for(&f, d("2026-10-30"), &pk, "1.0.0").state, "trial");
        let over = status_for(&f, d("2026-10-31"), &pk, "1.0.0");
        assert_eq!((over.state.as_str(), over.days_left), ("expired", 0));
    }

    #[test]
    fn putting_the_clock_back_does_not_give_more_days() {
        let pk = [0u8; 32];
        let f = file("2026-10-01", "2026-11-15", None);
        assert_eq!(status_for(&f, d("2026-10-02"), &pk, "1.0.0").state, "expired");
    }

    #[test]
    fn a_good_key_licenses_for_ever_and_a_changed_or_foreign_one_does_not() {
        let (key, pk) = make(1, "1");
        let p = verify_with(&pk, &key).unwrap();
        assert_eq!((p.name.as_str(), p.edition.as_str()), ("Ada", "1"));
        let s = status_for(&file("2020-01-01", "2020-01-01", Some(&key)), d("2040-01-01"), &pk, "1.4.2");
        assert_eq!((s.state.as_str(), s.name.as_deref()), ("licensed", Some("Ada")), "no expiry");
        // one letter of the payload changed
        let mut parts: Vec<String> = key.split('.').map(String::from).collect();
        let swap = if &parts[1][5..6] == "A" { "B" } else { "A" };
        parts[1].replace_range(5..6, swap);
        assert!(verify_with(&pk, &parts.join(".")).is_err());
        // a key made by someone else's private key
        let (other, _) = make(2, "1");
        assert!(verify_with(&pk, &other).unwrap_err().contains("not made by Lucent Raw"));
        for junk in ["", "LRAW1", "hello world", "LRAW1.a.b", "LRAW2.a.b"] {
            assert!(verify_with(&pk, junk).is_err(), "{junk}");
        }
        // spaces and a line break round it (as pasted from an email) are fine
        assert!(verify_with(&pk, &format!("  {key}\n")).is_ok());
    }

    #[test]
    fn a_key_for_version_one_works_in_every_one_x_and_not_in_two() {
        assert!(edition_ok("1", "0.1.0") && edition_ok("1", "1.0.0") && edition_ok("1", "1.9.3"));
        assert!(!edition_ok("1", "2.0.0"));
        assert!(edition_ok("2", "1.5.0") && edition_ok("2", "2.1.0"));
        let (key, pk) = make(1, "1");
        let s = status_for(&file("2026-01-01", "2026-01-01", Some(&key)), d("2026-10-19"), &pk, "2.0.0");
        assert_eq!(s.state, "expired");
        assert!(s.problem.unwrap().contains("needs a newer key"));
    }

    #[test]
    fn the_stored_file_is_made_on_first_start_and_remembers_the_latest_day() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("licence.json");
        let f = load(&p, d("2026-10-19"));
        assert_eq!((f.first_run.as_str(), f.last_seen.as_str()), ("2026-10-19", "2026-10-19"));
        let later = load(&p, d("2026-10-25"));
        assert_eq!((later.first_run.as_str(), later.last_seen.as_str()), ("2026-10-19", "2026-10-25"));
        let back = load(&p, d("2026-10-20"));
        assert_eq!(back.last_seen, "2026-10-25", "never goes back");
        std::fs::write(&p, "not json").unwrap();
        assert_eq!(load(&p, d("2027-01-01")).first_run, "2027-01-01", "a damaged file starts again rather than failing");
    }

    #[test]
    fn once_the_trial_is_over_saving_an_edit_is_refused_with_words_and_a_licence_lifts_it() {
        assert!(gate(false).is_ok());
        assert!(gate(true).unwrap_err().contains("30 day trial has ended"));
        // a debug build is not locked unless asked (so building the program never locks the developer out)
        assert_eq!(enforced(), !FREE && (!cfg!(debug_assertions) || std::env::var("LUCENT_ENFORCE_LICENCE").map(|v| v == "1").unwrap_or(false)));
        // the program is free: nothing is ever locked, whatever the trial says
        assert!(FREE && !enforced());
    }
}
