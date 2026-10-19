use crate::config::{WifiPolicy, WifiProfile};
use serde::Serialize;
#[derive(Default, Clone, Serialize)]
pub struct WifiState {
    pub active: Option<String>,
    pub connected: bool,
    pub connected_since: u64,
    pub next_attempt: u64,
    pub last_preferred_check: u64,
    #[serde(skip)]
    candidate: Option<(String, u8)>,
    #[serde(skip)]
    requested: Option<String>,
}
impl WifiState {
    pub fn choose(
        &mut self,
        profiles: &[WifiProfile],
        available: &[String],
        policy: &WifiPolicy,
        now: u64,
        busy: bool,
    ) -> Option<String> {
        let is_available = |id: &str| {
            profiles
                .iter()
                .any(|p| p.id == id && available.contains(&p.ssid))
        };
        if self.active.as_deref().is_some_and(|a| !is_available(a)) {
            self.active = None;
            self.next_attempt = now + policy.retry_secs;
            self.candidate = None;
        }
        if self.active.is_none() {
            if now < self.next_attempt {
                return None;
            }
            self.next_attempt = now + policy.retry_secs;
            let requested = self.requested.take();
            let preferred = profiles
                .iter()
                .find(|p| Some(&p.id) == requested.as_ref() && available.contains(&p.ssid));
            if let Some(p) =
                preferred.or_else(|| profiles.iter().find(|p| available.contains(&p.ssid)))
            {
                self.active = Some(p.id.clone());
                self.connected_since = now;
                return self.active.clone();
            }
            return None;
        }
        if !policy.prefer_higher
            || busy
            || now.saturating_sub(self.last_preferred_check) < policy.preferred_check_secs
            || now.saturating_sub(self.connected_since) < policy.preferred_check_secs
        {
            return None;
        }
        self.last_preferred_check = now;
        let preferred = profiles
            .iter()
            .take_while(|p| Some(&p.id) != self.active.as_ref())
            .find(|p| available.contains(&p.ssid));
        if let Some(p) = preferred {
            let count = if self.candidate.as_ref().is_some_and(|(id, _)| id == &p.id) {
                self.candidate.as_ref().unwrap().1 + 1
            } else {
                1
            };
            self.candidate = Some((p.id.clone(), count));
            if count >= 2 {
                self.active = Some(p.id.clone());
                self.connected_since = now;
                self.candidate = None;
                return self.active.clone();
            }
        } else {
            self.candidate = None;
        }
        None
    }
    pub fn request(&mut self, id: String) {
        self.active = None;
        self.connected = false;
        self.next_attempt = 0;
        self.requested = Some(id);
    }
    pub fn disconnected(&mut self, now: u64, policy: &WifiPolicy) {
        self.active = None;
        self.connected = false;
        self.next_attempt = now + policy.retry_secs;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn profiles() -> Vec<WifiProfile> {
        ["School", "Studio", "Backup"]
            .iter()
            .map(|s| WifiProfile {
                id: s.to_string(),
                ssid: s.to_string(),
                password: "password12".into(),
            })
            .collect()
    }
    #[test]
    fn fallback_hysteresis_and_busy() {
        let p = profiles();
        let policy = WifiPolicy::default();
        let mut w = WifiState::default();
        assert_eq!(
            w.choose(&p, &["Backup".into()], &policy, 0, false),
            Some("Backup".into())
        );
        assert_eq!(
            w.choose(&p, &["School".into(), "Backup".into()], &policy, 300, true),
            None
        );
        assert_eq!(
            w.choose(&p, &["School".into(), "Backup".into()], &policy, 301, false),
            None
        );
        assert_eq!(
            w.choose(&p, &["School".into(), "Backup".into()], &policy, 601, false),
            Some("School".into())
        );
        assert_eq!(w.choose(&p, &["Backup".into()], &policy, 602, false), None);
        assert_eq!(
            w.choose(&p, &["Backup".into()], &policy, 617, false),
            Some("Backup".into())
        );
    }
}
