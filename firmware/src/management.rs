use crate::{
    config::*,
    web::{Device, Request},
};
use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::{json, Value};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Change {
    confirmed: bool,
    expected_revision: u64,
    id: Option<String>,
    profile_id: Option<String>,
    source: Option<String>,
    display_name: Option<String>,
    name: Option<String>,
    description: Option<String>,
    password: Option<String>,
    enabled: Option<bool>,
    order: Option<u32>,
    actions: Option<Vec<SimpleAction>>,
    action: Option<SimpleAction>,
    ids: Option<Vec<String>>,
}
fn required<T>(v: Option<T>) -> Result<T> {
    v.ok_or_else(|| anyhow::anyhow!("invalid_request: Missing field"))
}
fn reorder<T>(items: &mut [T], ids: &[String], key: impl Fn(&T) -> &str) -> Result<()> {
    if items.len() != ids.len()
        || ids.iter().collect::<std::collections::BTreeSet<_>>().len() != ids.len()
        || items.iter().any(|x| !ids.iter().any(|id| id == key(x)))
    {
        bail!("invalid_request: Order must include every ID exactly once");
    }
    items.sort_by_key(|x| ids.iter().position(|id| id == key(x)).unwrap());
    Ok(())
}
impl Device {
    pub(crate) fn unique_password(&self, password: &str, except: Option<&str>) -> Result<()> {
        let c = self.config.as_ref().unwrap();
        if except.is_some() && c.credential.matches(password)
            || c.simple_profiles
                .iter()
                .filter(|p| Some(p.id.as_str()) != except)
                .any(|p| p.credential.matches(password))
        {
            bail!("duplicate_password: Choose a distinct password for each profile and the administrator");
        }
        Ok(())
    }
    pub(crate) fn management(&mut self, r: &Request, c: &mut Config) -> Result<Option<Value>> {
        match r.op.as_str() {
            "event.status" => return Ok(Some(json!({"enabled":c.event_mode}))),
            "sources.saved.list" => return Ok(Some(json!(c.saved_sources))),
            "simple.list" => {
                return Ok(Some(json!(c
                    .simple_profiles
                    .iter()
                    .map(SimpleProfile::public)
                    .collect::<Vec<_>>())))
            }
            "simple.actions.list" => {
                let id = r.params["profile_id"].as_str().unwrap_or("");
                return Ok(Some(json!(
                    c.simple_profiles
                        .iter()
                        .find(|p| p.id == id)
                        .ok_or_else(|| anyhow::anyhow!("Unknown profile"))?
                        .actions
                )));
            }
            _ => {}
        }
        if !(r.op.starts_with("sources.saved.")
            || r.op.starts_with("simple.")
            || r.op.starts_with("event.")
            || r.op == "auth.password.change")
        {
            return Ok(None);
        }
        let change: Change = serde_json::from_value(r.params.clone())?;
        if !change.confirmed {
            bail!("confirmation_required: Confirm the configuration change before saving");
        }
        if change.expected_revision != c.revision {
            bail!("revision_conflict: Configuration changed; refresh and retry");
        }
        let validate_actions = r.op == "simple.create"
            || r.op == "simple.update" && change.actions.is_some()
            || matches!(
                r.op.as_str(),
                "simple.actions.create" | "simple.actions.update"
            );
        let target_profile = if r.op.starts_with("simple.actions.") {
            change.profile_id.clone()
        } else {
            change.id.clone()
        };
        let password_changed = r.op == "simple.update" && change.password.is_some();
        let new_order = change.order;
        let id = change.id.unwrap_or_default();
        match r.op.as_str() {
            "sources.saved.add" => {
                let source = required(change.source)?;
                let mut original = None;
                for receiver in &c.receivers {
                    if let Ok(sources) = self.api.sources(receiver, false) {
                        if let Some(s) = sources.into_iter().find(|s| s.name == source) {
                            original = Some(s.name);
                            break;
                        }
                    }
                }
                let original = original.ok_or_else(|| {
                    anyhow::anyhow!("invalid_target: Discover the source before saving it")
                })?;
                c.saved_sources.push(SavedSource {
                    id: drouter_auth::random_hex(8),
                    source,
                    original_name: original.clone(),
                    display_name: change.display_name.unwrap_or(original),
                    order: c.saved_sources.len() as u32,
                    available: true,
                });
            }
            "sources.saved.update" => {
                let s = c
                    .saved_sources
                    .iter_mut()
                    .find(|s| s.id == id)
                    .ok_or_else(|| anyhow::anyhow!("Unknown saved source"))?;
                s.display_name = required(change.display_name)?;
            }
            "sources.saved.remove" => {
                c.saved_sources.retain(|s| s.id != id);
            }
            "sources.saved.reorder" => {
                reorder(&mut c.saved_sources, &required(change.ids)?, |s| &s.id)?;
            }
            "simple.create" => {
                let password = required(change.password)?;
                self.unique_password(&password, Some(""))?;
                c.simple_profiles.push(SimpleProfile {
                    id: drouter_auth::random_hex(8),
                    name: required(change.name)?,
                    description: change.description.unwrap_or_default(),
                    enabled: change.enabled.unwrap_or(true),
                    order: change.order.unwrap_or(c.simple_profiles.len() as u32),
                    credential: drouter_auth::Credential::new(&password)?,
                    actions: required(change.actions)?,
                });
            }
            "simple.update" => {
                let credential = if let Some(password) = change.password {
                    self.unique_password(&password, Some(&id))?;
                    Some(drouter_auth::Credential::new(&password)?)
                } else {
                    None
                };
                let profile = c
                    .simple_profiles
                    .iter_mut()
                    .find(|p| p.id == id)
                    .ok_or_else(|| anyhow::anyhow!("Unknown profile"))?;
                if let Some(n) = change.name {
                    profile.name = n;
                }
                if let Some(n) = change.description {
                    profile.description = n;
                }
                if let Some(n) = change.enabled {
                    profile.enabled = n;
                }
                if let Some(n) = change.order {
                    profile.order = n;
                }
                if let Some(n) = credential {
                    profile.credential = n;
                }
                if let Some(n) = change.actions {
                    profile.actions = n;
                }
            }
            "simple.delete" => {
                c.simple_profiles.retain(|p| p.id != id);
            }
            "simple.actions.create"
            | "simple.actions.update"
            | "simple.actions.delete"
            | "simple.actions.reorder" => {
                let profile_id = required(change.profile_id)?;
                let profile = c
                    .simple_profiles
                    .iter_mut()
                    .find(|p| p.id == profile_id)
                    .ok_or_else(|| anyhow::anyhow!("Unknown profile"))?;
                match r.op.as_str() {
                    "simple.actions.create" => {
                        profile.actions.push(required(change.action)?);
                    }
                    "simple.actions.update" => {
                        let action = required(change.action)?;
                        let action_id = action.id.clone();
                        *profile
                            .actions
                            .iter_mut()
                            .find(|a| a.id == action_id)
                            .ok_or_else(|| anyhow::anyhow!("Unknown action"))? = action;
                    }
                    "simple.actions.delete" => {
                        profile.actions.retain(|a| a.id != id);
                    }
                    _ => {
                        reorder(&mut profile.actions, &required(change.ids)?, |a| &a.id)?;
                    }
                }
            }
            "event.enable" | "event.disable" => {
                c.event_mode = r.op == "event.enable";
            }
            "auth.password.change" => {
                let password = required(change.password)?;
                self.unique_password(&password, None)?;
                c.credential = drouter_auth::Credential::new(&password)?;
            }
            _ => bail!("Unknown operation"),
        }
        for (i, s) in c.saved_sources.iter_mut().enumerate() {
            s.order = i as u32;
        }
        if r.op == "simple.update" {
            if let Some(order) = new_order {
                let index = c.simple_profiles.iter().position(|p| p.id == id).unwrap();
                let profile = c.simple_profiles.remove(index);
                c.simple_profiles
                    .insert((order as usize).min(c.simple_profiles.len()), profile);
            }
        }
        for (index, profile) in c.simple_profiles.iter_mut().enumerate() {
            profile.order = index as u32;
        }
        for p in &mut c.simple_profiles {
            for (i, a) in p.actions.iter_mut().enumerate() {
                a.order = i as u32;
            }
        }
        if validate_actions {
            for profile in c.simple_profiles.iter().filter(|p| {
                target_profile.as_ref().map_or_else(
                    || Some(p.id.as_str()) == c.simple_profiles.last().map(|p| p.id.as_str()),
                    |id| p.id == *id,
                )
            }) {
                for action in &profile.actions {
                    let receiver = c
                        .receivers
                        .iter()
                        .find(|r| r.id == action.receiver)
                        .ok_or_else(|| anyhow::anyhow!("invalid_target: Unknown output"))?;
                    if !c.saved_sources.iter().any(|s| s.source == action.source)
                        && !self
                            .api
                            .sources(receiver, false)?
                            .iter()
                            .any(|s| s.name == action.source)
                    {
                        bail!("invalid_target: Source unavailable on this output");
                    }
                }
            }
        }
        self.commit(c.clone())?;
        if password_changed {
            self.auth.revoke_profile(&id);
        } else if r.op == "simple.delete"
            || (r.op == "simple.update"
                && c.simple_profiles.iter().any(|p| p.id == id && !p.enabled))
        {
            self.auth.revoke_resume_profile(&id);
        }
        if r.op.starts_with("event.")
            || r.op.starts_with("simple.")
            || r.op == "auth.password.change"
        {
            if self.access_log.len() == 32 {
                self.access_log.pop_front();
            }
            self.access_log
                .push_back(json!({"operation":r.op,"uptime":self.now()}));
        }
        Ok(Some(
            json!({"saved":true,"reauthenticate":r.op == "auth.password.change"}),
        ))
    }
}
