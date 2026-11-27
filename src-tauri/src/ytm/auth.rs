use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

use super::ORIGIN;

/// Browser session lifted out of the embedded Google sign-in webview. InnerTube
/// accepts it the same way it accepts the browser's own requests: the account's
/// cookies plus a SAPISIDHASH authorization header. This is how ytmusicapi's
/// browser auth works, and unlike OAuth device tokens these sessions are
/// accepted by every YouTube Music endpoint.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Session {
    /// Cookie name to value, as served for https://music.youtube.com/.
    pub cookies: BTreeMap<String, String>,
}

impl Session {
    /// Returns a session only when it carries everything a signed-in request
    /// needs: SAPISID signs the authorization header, the PSID cookies carry
    /// the account.
    pub fn from_cookies(cookies: BTreeMap<String, String>) -> Option<Session> {
        let session = Session { cookies };
        if session.is_complete() {
            Some(session)
        } else {
            None
        }
    }

    pub fn is_complete(&self) -> bool {
        self.sapisid().is_some()
            && ["__Secure-1PSID", "__Secure-3PSID"].iter().any(|name| {
                self.cookies
                    .get(*name)
                    .is_some_and(|value| !value.is_empty())
            })
    }

    /// SAPISID and __Secure-3PAPISID hold the same value; YouTube serves both
    /// under different names depending on the page, so accept any of them.
    fn sapisid(&self) -> Option<&String> {
        ["SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID"]
            .iter()
            .find_map(|name| self.cookies.get(*name).filter(|value| !value.is_empty()))
    }

    pub fn cookie_header(&self) -> String {
        self.cookies
            .iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// `SAPISIDHASH <unix time>_<sha1(time + " " + sapisid + " " + origin)>`,
    /// exactly what the web player sends with every request.
    pub fn authorization_header(&self) -> Option<String> {
        let sapisid = self.sapisid()?;
        let now = chrono::Utc::now().timestamp();
        use sha1::Digest;
        let digest = sha1::Sha1::digest(format!("{now} {sapisid} {ORIGIN}").as_bytes());
        let hash = digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        Some(format!("SAPISIDHASH {now}_{hash}"))
    }

    pub fn save(&self, path: &Path) -> crate::error::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(self)?;
        std::fs::write(path, text)?;
        Ok(())
    }

    pub fn load(path: &Path) -> Option<Session> {
        let text = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&text).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_with(names: &[&str]) -> Session {
        let cookies = names
            .iter()
            .map(|name| (name.to_string(), "value".to_string()))
            .collect();
        Session { cookies }
    }

    #[test]
    fn complete_session_needs_sapisid_and_a_psid() {
        assert!(!session_with(&["SID"]).is_complete());
        assert!(!session_with(&["SAPISID"]).is_complete());
        assert!(session_with(&["SAPISID", "__Secure-1PSID"]).is_complete());
        assert!(session_with(&["__Secure-3PAPISID", "__Secure-3PSID"]).is_complete());
    }

    #[test]
    fn cookie_header_joins_all_cookies() {
        let session = session_with(&["SID", "SAPISID"]);
        let header = session.cookie_header();
        assert!(header.contains("SID=value"), "{header}");
        assert!(header.contains("SAPISID=value"), "{header}");
        assert_eq!(header.matches("; ").count(), 1);
    }

    #[test]
    fn empty_cookie_values_are_not_a_session() {
        let cookies = [
            ("SAPISID".into(), "".into()),
            ("__Secure-1PSID".into(), "".into()),
        ]
        .into();
        assert!(Session::from_cookies(cookies).is_none());
    }

    #[test]
    fn authorization_header_is_sapisidhash() {
        let session = session_with(&["SAPISID"]);
        let header = session.authorization_header().expect("header");
        let now = chrono::Utc::now().timestamp();
        use sha1::Digest;
        let expected = sha1::Sha1::digest(format!("{now} value {ORIGIN}").as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(header, format!("SAPISIDHASH {now}_{expected}"));
    }
}
