use crate::{
    auth::crypt,
    bird_dog::BirdDog,
    config::{Config, Receiver, MAX_WIFI},
    storage::Storage,
    web::{Device, Request},
};
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::{
    net::Ipv4Addr,
    sync::{Arc, Mutex},
};
#[derive(Default)]
struct Memory {
    config: Option<Config>,
    writes: usize,
    fail: bool,
}
#[derive(Clone)]
struct Store(Arc<Mutex<Memory>>);
impl Storage for Store {
    fn load(&self) -> Result<Option<Config>> {
        Ok(self.0.lock().unwrap().config.clone())
    }
    fn save(&mut self, c: &Config) -> Result<()> {
        let mut s = self.0.lock().unwrap();
        if s.fail {
            bail!("Flash failure");
        }
        s.config = Some(c.clone());
        s.writes += 1;
        Ok(())
    }
    fn reset(&mut self) -> Result<()> {
        self.0.lock().unwrap().config = None;
        Ok(())
    }
}
struct Decoder {
    active: String,
    ignore: bool,
    online: bool,
}
impl BirdDog for Decoder {
    fn request(
        &mut self,
        _: &Receiver,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        if !self.online {
            bail!("Receiver offline");
        }
        if path == "/about" {
            return Ok(json!({"FirmwareVersion":"BirdDog test"}));
        }
        if path == "/List" {
            return Ok(json!({"Camera A":"10.0.0.1","Camera B":"10.0.0.2"}));
        }
        if path == "/refresh" {
            return Ok(json!({}));
        }
        if path.starts_with("/connectTo") {
            if method == "POST" && !self.ignore {
                self.active = body.unwrap()["sourceName"].as_str().unwrap().into();
            }
            return Ok(json!({"sourceName":self.active}));
        }
        bail!("Unsupported endpoint")
    }
}
fn receiver() -> Receiver {
    Receiver {
        id: "one".into(),
        label: "Output one".into(),
        ip: Ipv4Addr::new(192, 168, 1, 10),
        port: 8080,
        channel: 1,
    }
}
fn device() -> (Device, Store) {
    let mut c = Config::new("studio-router", "correct horse battery").unwrap();
    c.receivers.push(receiver());
    let store = Store(Arc::new(Mutex::new(Memory {
        config: Some(c),
        ..Default::default()
    })));
    (
        Device::new(
            Box::new(store.clone()),
            Box::new(Decoder {
                active: "Camera A".into(),
                ignore: false,
                online: true,
            }),
            "token".into(),
            true,
        )
        .unwrap(),
        store,
    )
}
fn call(d: &mut Device, op: &str, params: Value) -> Result<Value> {
    d.execute(
        Request {
            v: 1,
            id: "1".into(),
            op: op.into(),
            params,
        },
        true,
        false,
    )
}
#[test]
fn switch_changes_decoder_state_and_verifies() {
    let (mut d, _) = device();
    assert_eq!(
        call(
            &mut d,
            "route.set",
            json!({"receiver":"one","source":"Camera B"})
        )
        .unwrap()["source"],
        "Camera B"
    );
    assert_eq!(
        call(&mut d, "route.get", json!({})).unwrap()[0]["source"],
        "Camera B"
    );
    assert!(call(
        &mut d,
        "route.set",
        json!({"receiver":"one","source":"Unknown"})
    )
    .is_err());
}
#[test]
fn ignored_switch_fails_verification() {
    let (mut d, _) = device();
    d.api = Box::new(Decoder {
        active: "Camera A".into(),
        ignore: true,
        online: true,
    });
    assert!(call(
        &mut d,
        "route.set",
        json!({"receiver":"one","source":"Camera B"})
    )
    .unwrap_err()
    .to_string()
    .contains("confirm"));
}
#[test]
fn offline_receivers_have_no_live_source() {
    let (mut d, _) = device();
    d.api = Box::new(Decoder {
        active: "Camera A".into(),
        ignore: false,
        online: false,
    });
    let routes = call(&mut d, "route.get", json!({})).unwrap();
    assert_eq!(routes[0]["online"], false);
    assert!(routes[0]["source"].is_null());
}
#[test]
fn presets_persist_actual_state_and_report_removed_outputs() {
    let (mut d, store) = device();
    let p = call(&mut d, "presets.create", json!({"name":"Opening"})).unwrap();
    assert_eq!(
        store.0.lock().unwrap().config.as_ref().unwrap().presets[0].routes[0].1,
        "Camera A"
    );
    call(&mut d, "receivers.remove", json!({"id":"one"})).unwrap();
    assert_eq!(
        call(&mut d, "presets.apply", json!({"id":p["id"]})).unwrap()["results"][0]["ok"],
        false
    );
}
#[test]
fn wifi_limits_reorder_and_password_redaction() {
    let (mut d, _) = device();
    for i in 0..MAX_WIFI {
        call(
            &mut d,
            "wifi.add",
            json!({"id":i.to_string(),"ssid":format!("Network {i}"),"password":"secret-password"}),
        )
        .unwrap();
    }
    assert!(call(
        &mut d,
        "wifi.add",
        json!({"id":"extra","ssid":"Extra","password":"secret-password"})
    )
    .is_err());
    assert!(!call(&mut d, "wifi.list", json!({}))
        .unwrap()
        .to_string()
        .contains("secret-password"));
    assert!(call(&mut d, "wifi.reorder", json!({"ids":["0","0"]})).is_err());
    let ids: Vec<_> = (0..MAX_WIFI).rev().map(|i| i.to_string()).collect();
    call(&mut d, "wifi.reorder", json!({"ids":ids})).unwrap();
    assert_eq!(call(&mut d, "wifi.list", json!({})).unwrap()[0]["id"], "7");
}
#[test]
fn no_op_settings_do_not_wear_flash_and_stale_revision_fails() {
    let (mut d, store) = device();
    let revision = d.config.as_ref().unwrap().revision;
    call(
        &mut d,
        "settings.update",
        json!({"expected_revision":revision}),
    )
    .unwrap();
    assert_eq!(store.0.lock().unwrap().writes, 0);
    call(
        &mut d,
        "settings.update",
        json!({"expected_revision":revision,"name":"updated-router"}),
    )
    .unwrap();
    assert_eq!(store.0.lock().unwrap().writes, 1);
    assert!(call(
        &mut d,
        "settings.update",
        json!({"expected_revision":revision})
    )
    .is_err());
}
#[test]
fn flash_failure_rolls_back_live_configuration() {
    let (mut d, store) = device();
    store.0.lock().unwrap().fail = true;
    assert!(call(
        &mut d,
        "wifi.add",
        json!({"id":"x","ssid":"Wifi","password":"secret-password"})
    )
    .is_err());
    assert!(d.config.as_ref().unwrap().wifi.is_empty());
}
#[test]
fn unknown_operations_and_invalid_params_are_rejected() {
    let (mut d, _) = device();
    assert!(call(&mut d, "http.fetch", json!({"url":"http://private"})).is_err());
    assert!(call(&mut d, "device.info", json!({"unexpected":true})).is_err());
    assert!(serde_json::from_str::<Request>("{").is_err());
    assert!(d
        .execute(
            Request {
                v: 2,
                id: "1".into(),
                op: "device.info".into(),
                params: json!({})
            },
            true,
            false
        )
        .is_err());
}
#[test]
fn ethernet_validation_and_local_only_operations() {
    let (mut d, _) = device();
    assert!(call(
        &mut d,
        "settings.update",
        json!({"expected_revision":1,"ethernet":{"address":"192.168.1.10","mask":"255.0.255.0"}})
    )
    .is_err());
    assert!(d
        .execute(
            Request {
                v: 1,
                id: "1".into(),
                op: "factory.reset".into(),
                params: json!({})
            },
            true,
            true
        )
        .is_err());
    assert!(d
        .execute(
            Request {
                v: 1,
                id: "1".into(),
                op: "settings.update".into(),
                params: json!({"expected_revision":1})
            },
            false,
            false
        )
        .is_err());
}
#[test]
fn name_normalization_and_stable_identity() {
    let c = Config::new(" Studio-Router ", "correct horse battery").unwrap();
    assert_eq!(c.name, "studio-router");
    let copy: Config = serde_json::from_slice(&serde_json::to_vec(&c).unwrap()).unwrap();
    assert_eq!(copy.remote_name(), c.remote_name());
    let other = Config::new("studio-router", "correct horse battery").unwrap();
    assert_ne!(other.remote_name(), c.remote_name());
    for n in ["../bad", "ab", "bad--name", "a b", "a/b"] {
        assert!(Config::new(n, "correct horse battery").is_err());
    }
}
#[test]
fn authenticated_encryption_replay_expiry_and_revocation() {
    let (mut d, _) = device();
    let mut login = drouter_auth::Login::new();
    let sid = "012345678901234567890123456789012345";
    let challenge = d.frame(
        sid,
        json!({"type":"auth.start","a":login.public_key()}),
        false,
    );
    let proof = login.respond(
        "correct horse battery",
        challenge["salt"].as_str().unwrap(),
        challenge["b"].as_str().unwrap(),
    );
    let ok = d.frame(sid, json!({"type":"auth.proof","proof":proof}), false);
    let key = hex::decode(login.finish(ok["proof"].as_str().unwrap())).unwrap();
    let packet = json!({"v":1,"id":"1","op":"device.info","params":{}}).to_string();
    let data = hex::encode(crypt(true, &key, sid, 1, packet.as_bytes(), false).unwrap());
    let frame = json!({"type":"rpc","seq":1,"data":data});
    let reply = d.frame(sid, frame.clone(), false);
    assert_eq!(reply["type"], "rpc");
    let plain = crypt(
        false,
        &key,
        sid,
        1,
        &hex::decode(reply["data"].as_str().unwrap()).unwrap(),
        true,
    )
    .unwrap();
    let value: Value = serde_json::from_slice(&plain).unwrap();
    assert_eq!(value["result"]["name"], "studio-router");
    assert_eq!(d.frame(sid, frame.clone(), false)["type"], "error");
    assert!(d
        .auth
        .decrypt(sid, &json!({"seq":2,"data":"00"}), 1801)
        .is_err());
    d.auth.revoke();
    assert_eq!(d.frame(sid, frame, false)["type"], "error");
}
#[test]
fn password_attempts_and_pending_sessions_are_bounded() {
    let credential = drouter_auth::Credential::new("correct horse battery").unwrap();
    let mut auth = crate::auth::Auth::default();
    let login = drouter_auth::Login::new();
    for i in 0..8 {
        auth.start(&i.to_string(), &login.public_key(), &credential, 0)
            .unwrap();
    }
    assert!(auth
        .start("extra", &login.public_key(), &credential, 0)
        .is_err());
    assert!(auth.prove("0", &"00".repeat(32), 31).is_err());
    assert!(auth
        .start("fresh", &login.public_key(), &credential, 61)
        .is_ok());
}
