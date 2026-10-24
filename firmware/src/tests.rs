use crate::{
    auth::crypt,
    bird_dog::BirdDog,
    config::{Config, Receiver},
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
    for i in 0..16 {
        call(
            &mut d,
            "wifi.add",
            json!({"id":i.to_string(),"ssid":format!("Network {i}"),"password":"secret-password"}),
        )
        .unwrap();
    }
    assert!(!call(&mut d, "wifi.list", json!({}))
        .unwrap()
        .to_string()
        .contains("secret-password"));
    assert!(call(&mut d, "wifi.reorder", json!({"ids":["0","0"]})).is_err());
    let ids: Vec<_> = (0..16).rev().map(|i| i.to_string()).collect();
    call(&mut d, "wifi.reorder", json!({"ids":ids})).unwrap();
    assert_eq!(call(&mut d, "wifi.list", json!({})).unwrap()[0]["id"], "15");
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
    assert_eq!(copy.device_id(), c.device_id());
    let other = Config::new("studio-router", "correct horse battery").unwrap();
    assert_ne!(other.device_id(), c.device_id());
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
        .decrypt(
            sid,
            &json!({"seq":2,"data":"00"}),
            crate::auth::SESSION_SECONDS
        )
        .is_err());
    d.auth.revoke();
    assert_eq!(d.frame(sid, frame, false)["type"], "error");
}
#[test]
fn full_day_sessions_keep_expiry_elevation_replay_and_revocation_guards() {
    let credential = drouter_auth::Credential::new("correct horse battery").unwrap();
    let mut auth = crate::auth::Auth::default();
    let mut login = drouter_auth::Login::new();
    let sid = "012345678901234567890123456789012345";
    let start = 100;
    let challenge = auth
        .start(sid, &login.public_key(), &credential, start)
        .unwrap();
    let proof = login.respond(
        "correct horse battery",
        challenge["salt"].as_str().unwrap(),
        challenge["b"].as_str().unwrap(),
    );
    let ok = auth.prove(sid, &proof, start).unwrap();
    assert_eq!(ok["expiresIn"], 86400);
    let key = hex::decode(login.finish(ok["proof"].as_str().unwrap())).unwrap();
    assert!(auth.elevated(sid, start + 299));
    assert!(!auth.elevated(sid, start + 300));
    let packet = json!({"v":1,"id":"1","op":"device.info","params":{}});
    let frame = json!({"seq":1,"data":hex::encode(crypt(true, &key, sid, 1, packet.to_string().as_bytes(), false).unwrap())});
    assert_eq!(auth.decrypt(sid, &frame, start + 3600).unwrap(), packet);
    assert!(auth.decrypt(sid, &frame, start + 3601).is_err());
    assert!(auth.role(sid, start + 86399).unwrap() == crate::auth::Role::Admin);
    assert!(auth.role(sid, start + 86400).is_err());
    let next = json!({"seq":2,"data":hex::encode(crypt(true, &key, sid, 2, packet.to_string().as_bytes(), false).unwrap())});
    assert!(auth.decrypt(sid, &next, start + 86400).is_err());
    auth.revoke();
    assert!(auth.role(sid, start + 3600).is_err());
    assert!(auth.decrypt(sid, &next, start + 3600).is_err());
}
#[test]
fn remote_retry_tracks_connection_changes_and_distinguishes_registration_errors() {
    use crate::remote::{registration_error, registration_failed, same_connection};
    let config = Config::new("studio-router", "correct horse battery").unwrap();
    let mut changed = config.clone();
    assert!(same_connection(&config, &changed));
    changed.name = "renamed-router".into();
    assert!(!same_connection(&config, &changed));
    changed = config.clone();
    changed.server = "https://another.example".into();
    assert!(!same_connection(&config, &changed));
    changed = config.clone();
    changed.cloud_enabled = !config.cloud_enabled;
    assert!(!same_connection(&config, &changed));
    for (code, expected) in [
        ("name_unavailable", "name_unavailable"),
        ("identity_in_use", "identity_in_use"),
        ("invalid_identity", "identity_rejected"),
        ("storage_error", "registry_unavailable"),
    ] {
        assert_eq!(registration_error(code), expected);
        assert!(registration_failed(expected));
    }
    assert!(!registration_failed("connected"));
}
#[test]
fn password_attempts_and_pending_sessions_are_bounded() {
    let credential = drouter_auth::Credential::new("correct horse battery").unwrap();
    let mut auth = crate::auth::Auth::default();
    let login = drouter_auth::Login::new();
    for i in 0..5 {
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
#[test]
fn wifi_edit_toggle_capacity_and_remote_disconnect_guard() {
    let (mut d, _) = device();
    call(
        &mut d,
        "wifi.add",
        json!({"id":"a","ssid":"School","password":"password12"}),
    )
    .unwrap();
    call(
        &mut d,
        "wifi.add",
        json!({"id":"a","ssid":"School renamed"}),
    )
    .unwrap();
    assert_eq!(d.config.as_ref().unwrap().wifi[0].password, "password12");
    d.network.wifi.active = Some("a".into());
    let execute = |d: &mut Device, op: &str, p: Value| {
        d.execute(
            Request {
                v: 1,
                id: "guard".into(),
                op: op.into(),
                params: p,
            },
            true,
            true,
        )
    };
    assert!(execute(
        &mut d,
        "wifi.set_enabled",
        json!({"id":"a","enabled":false})
    )
    .is_err());
    assert!(execute(&mut d, "wifi.remove", json!({"id":"a"})).is_err());
    assert!(execute(
        &mut d,
        "wifi.add",
        json!({"id":"a","ssid":"School renamed","password":"changed-pass"})
    )
    .is_err());
    execute(
        &mut d,
        "wifi.set_enabled",
        json!({"id":"a","enabled":false,"confirm_disconnect":true}),
    )
    .unwrap();
    assert_eq!(
        call(&mut d, "wifi.list", json!({})).unwrap()[0]["enabled"],
        false
    );
    let mut rejected = false;
    for i in 0..200 {
        if call(&mut d,"wifi.add",json!({"id":format!("profile-{i}"),"ssid":"A network with a long name","password":"a very long wifi password for capacity testing"})).is_err(){rejected=true;break;}
    }
    assert!(rejected);
    assert!(d.config.as_ref().unwrap().wifi.len() > 8);
    assert!(
        serde_json::to_vec(d.config.as_ref().unwrap())
            .unwrap()
            .len()
            <= 24576
    );
}
#[test]
fn schema_one_migration_preserves_identity_password_and_wifi_order() {
    let (mut d, store) = device();
    call(
        &mut d,
        "wifi.add",
        json!({"id":"one","ssid":"School","password":"password12"}),
    )
    .unwrap();
    let config = d.config.as_ref().unwrap();
    let id = config.device_id();
    let verifier = config.credential.verifier.clone();
    let mut old = serde_json::to_value(config).unwrap();
    old["schema"] = json!(1);
    for w in old["wifi"].as_array_mut().unwrap() {
        w.as_object_mut().unwrap().remove("enabled");
        w.as_object_mut().unwrap().remove("priority");
    }
    store.0.lock().unwrap().config = Some(serde_json::from_value(old).unwrap());
    let loaded = Device::new(
        Box::new(store),
        Box::new(Decoder {
            active: "Camera A".into(),
            ignore: false,
            online: true,
        }),
        true,
    )
    .unwrap();
    let migrated = loaded.config.unwrap();
    assert_eq!(migrated.schema, 3);
    assert_eq!(migrated.device_id(), id);
    assert_eq!(migrated.credential.verifier, verifier);
    assert!(migrated.wifi[0].enabled);
    assert_eq!(migrated.wifi[0].priority, 0);
}
#[test]
fn identity_recovery_is_local_elevated_and_restores_stable_id() {
    let (mut d, _) = device();
    let recovery = call(&mut d, "identity.export", json!({})).unwrap();
    let other = Config::new("other-device", "another long password").unwrap();
    let remote = d.execute(
        Request {
            v: 1,
            id: "r".into(),
            op: "identity.export".into(),
            params: json!({}),
        },
        true,
        true,
    );
    assert!(remote.is_err());
    let revision = d.config.as_ref().unwrap().revision;
    call(&mut d,"identity.restore",json!({"identity":other.identity,"name":"other-device","password":"new long password","expected_revision":revision})).unwrap();
    assert_eq!(d.config.as_ref().unwrap().device_id(), other.device_id());
    assert_ne!(
        d.config.as_ref().unwrap().device_id(),
        recovery["device_id"]
    );
    assert_eq!(d.config.as_ref().unwrap().receivers.len(), 1);
}

#[test]
fn first_setup_needs_no_token_and_cannot_overwrite_an_existing_device() {
    let (_, store) = device();
    store.0.lock().unwrap().config = None;
    let mut d = Device::new(
        Box::new(store),
        Box::new(Decoder {
            active: "Camera A".into(),
            ignore: false,
            online: true,
        }),
        true,
    )
    .unwrap();
    assert!(d.setup_network().is_ok());
    let params = json!({"name":"new-router","password":"a new admin password","ethernet":{},"cloud_enabled":false});
    d.setup(serde_json::from_value(params.clone()).unwrap())
        .unwrap();
    assert!(d.setup_network().is_err());
    assert!(d.setup(serde_json::from_value(params).unwrap()).is_err());
    assert_eq!(d.config.as_ref().unwrap().name, "new-router");
}
fn confirmed(d: &mut Device, op: &str, mut params: Value) -> Result<Value> {
    params["confirmed"] = json!(true);
    params["expected_revision"] = json!(d.config.as_ref().unwrap().revision);
    call(d, op, params)
}
fn simple_action(id: &str, source: &str) -> Value {
    json!({"id":id,"label":"Teacher PC","icon":null,"receiver":"one","source":source,"enabled":true,"order":0})
}
fn login_role(d: &mut Device, sid: &str, password: &str) -> Vec<u8> {
    let mut login = drouter_auth::Login::new();
    let challenge = d.frame(
        sid,
        json!({"type":"auth.start","a":login.public_key(),"multi":true}),
        false,
    );
    assert_eq!(challenge["type"], "auth.challenge");
    let mut proofs = vec![login.respond(
        password,
        challenge["salt"].as_str().unwrap(),
        challenge["b"].as_str().unwrap(),
    )];
    for c in challenge["alternatives"].as_array().unwrap() {
        proofs.push(login.respond(
            password,
            c["salt"].as_str().unwrap(),
            c["b"].as_str().unwrap(),
        ));
    }
    let reply = d.frame(
        sid,
        json!({"type":"auth.proof","proof":proofs[0],"proofs":proofs}),
        false,
    );
    assert_eq!(reply["type"], "auth.ok");
    hex::decode(login.finish(reply["proof"].as_str().unwrap())).unwrap()
}
fn rpc_role(d: &mut Device, sid: &str, key: &[u8], seq: u64, op: &str, params: Value) -> Value {
    let bytes =
        serde_json::to_vec(&json!({"v":1,"id":seq.to_string(),"op":op,"params":params})).unwrap();
    let data = crypt(true, key, sid, seq, &bytes, false).unwrap();
    let reply = d.frame(
        sid,
        json!({"type":"rpc","seq":seq,"data":hex::encode(data)}),
        false,
    );
    let data = hex::decode(reply["data"].as_str().unwrap()).unwrap();
    serde_json::from_slice(
        &crypt(false, key, sid, reply["seq"].as_u64().unwrap(), &data, true).unwrap(),
    )
    .unwrap()
}
#[test]
fn saved_sources_confirm_rename_reorder_remove_and_restart() {
    let (mut d, store) = device();
    assert!(call(&mut d, "sources.saved.add", json!({"source":"Camera A"})).is_err());
    confirmed(
        &mut d,
        "sources.saved.add",
        json!({"source":"Camera A","display_name":"Teacher"}),
    )
    .unwrap();
    confirmed(
        &mut d,
        "sources.saved.add",
        json!({"source":"Camera B","display_name":"Stage"}),
    )
    .unwrap();
    let saved = d.config.as_ref().unwrap().saved_sources.clone();
    assert_eq!(saved[0].source, "Camera A");
    let unchanged = serde_json::to_value(d.config.as_ref().unwrap()).unwrap();
    assert!(call(
        &mut d,
        "sources.saved.remove",
        json!({"id":saved[0].id,"confirmed":false,"expected_revision":unchanged["revision"]})
    )
    .is_err());
    assert_eq!(
        unchanged,
        serde_json::to_value(d.config.as_ref().unwrap()).unwrap()
    );
    confirmed(
        &mut d,
        "sources.saved.update",
        json!({"id":saved[0].id,"display_name":"Presenter"}),
    )
    .unwrap();
    confirmed(
        &mut d,
        "sources.saved.reorder",
        json!({"ids":[saved[1].id,saved[0].id]}),
    )
    .unwrap();
    assert!(confirmed(
        &mut d,
        "sources.saved.reorder",
        json!({"ids":[saved[1].id,saved[1].id]})
    )
    .is_err());
    assert_eq!(
        store.load().unwrap().unwrap().saved_sources[1].display_name,
        "Presenter"
    );
    confirmed(&mut d, "sources.saved.remove", json!({"id":saved[1].id})).unwrap();
    let restored = store.load().unwrap().unwrap();
    assert_eq!(restored.saved_sources.len(), 1);
    assert_eq!(restored.saved_sources[0].original_name, "Camera A");
    assert_eq!(
        call(&mut d, "route.get", json!({})).unwrap()[0]["source"],
        "Camera A"
    );
}
#[test]
fn unicode_passwords_count_scalar_values_and_use_unique_salts() {
    use drouter_auth::Credential;
    for password in ["abc", "😀😀😀", "a\u{301}"] {
        assert!(Credential::new(password).is_err());
    }
    for password in ["1234", "árví", "😀😀😀😀", "a\u{301}bc"] {
        let a = Credential::new(password).unwrap();
        let b = Credential::new(password).unwrap();
        assert_ne!(a.salt, b.salt);
        assert_ne!(a.verifier, b.verifier);
        assert!(a.matches(password));
    }
}
#[test]
fn restricted_sessions_fixed_actions_event_override_and_admin_authorization() {
    let (mut d, store) = device();
    confirmed(&mut d,"simple.create",json!({"name":"Classroom","password":"1234","actions":[simple_action("teacher","Camera B")]})).unwrap();
    confirmed(
        &mut d,
        "simple.create",
        json!({"name":"Stage","password":"5678","actions":[simple_action("stage","Camera A")]}),
    )
    .unwrap();
    assert!(confirmed(
        &mut d,
        "simple.create",
        json!({"name":"Duplicate","password":"1234","actions":[simple_action("other","Camera A")]})
    )
    .is_err());
    assert!(confirmed(&mut d,"simple.create",json!({"name":"Admin duplicate","password":"correct horse battery","actions":[simple_action("other","Camera A")]})).is_err());
    assert!(confirmed(
        &mut d,
        "simple.create",
        json!({"name":"Empty","password":"abcd","actions":[]})
    )
    .is_err());
    let profile_id = d.config.as_ref().unwrap().simple_profiles[0].id.clone();
    let key = login_role(&mut d, "simple", "1234");
    let second = login_role(&mut d, "stage", "5678");
    assert_eq!(
        rpc_role(&mut d, "simple", &key, 1, "auth.session", json!({}))["result"]["profile_id"],
        profile_id
    );
    assert_eq!(
        rpc_role(
            &mut d,
            "stage",
            &second,
            1,
            "simple.actions.list",
            json!({})
        )["result"]["name"],
        "Stage"
    );
    for (index, op) in [
        "settings.update",
        "wifi.list",
        "route.set",
        "sources.saved.list",
        "simple.list",
        "event.disable",
    ]
    .iter()
    .enumerate()
    {
        assert_eq!(
            rpc_role(&mut d, "simple", &key, index as u64 + 2, op, json!({}))["ok"],
            false
        );
    }
    assert_eq!(
        rpc_role(
            &mut d,
            "simple",
            &key,
            8,
            "simple.action.execute",
            json!({"id":"teacher","source":"Camera A","receiver":"one"})
        )["ok"],
        false
    );
    assert_eq!(
        rpc_role(
            &mut d,
            "simple",
            &key,
            9,
            "simple.action.execute",
            json!({"id":"stage"})
        )["ok"],
        false
    );
    assert_eq!(
        rpc_role(
            &mut d,
            "simple",
            &key,
            10,
            "simple.action.execute",
            json!({"id":"teacher"})
        )["result"]["source"],
        "Camera B"
    );
    assert_eq!(
        rpc_role(
            &mut d,
            "simple",
            &key,
            11,
            "simple.action.execute",
            json!({"id":"teacher"})
        )["ok"],
        false
    );
    confirmed(&mut d, "event.enable", json!({})).unwrap();
    assert!(store.load().unwrap().unwrap().event_mode);
    assert_eq!(
        rpc_role(
            &mut d,
            "simple",
            &key,
            12,
            "simple.action.execute",
            json!({"id":"teacher"})
        )["error"]["code"],
        "event_locked"
    );
    let locked = login_role(&mut d, "new", "5678");
    assert_eq!(
        rpc_role(&mut d, "new", &locked, 1, "simple.actions.list", json!({}))["result"]["locked"],
        true
    );
    assert_eq!(
        rpc_role(
            &mut d,
            "new",
            &locked,
            2,
            "simple.action.execute",
            json!({"id":"stage"})
        )["ok"],
        false
    );
    assert!(call(
        &mut d,
        "route.set",
        json!({"receiver":"one","source":"Camera A"})
    )
    .is_ok());
    confirmed(&mut d, "event.disable", json!({})).unwrap();
    assert_eq!(
        rpc_role(
            &mut d,
            "stage",
            &second,
            2,
            "simple.action.execute",
            json!({"id":"stage"})
        )["result"]["source"],
        "Camera A"
    );
    call(&mut d, "receivers.remove", json!({"id":"one"})).unwrap();
    d.last_simple_action.clear();
    assert_eq!(
        rpc_role(
            &mut d,
            "stage",
            &second,
            3,
            "simple.action.execute",
            json!({"id":"stage"})
        )["error"]["code"],
        "invalid_target"
    );
    confirmed(&mut d, "simple.delete", json!({"id":profile_id})).unwrap();
    assert_eq!(
        rpc_role(&mut d, "simple", &key, 13, "simple.actions.list", json!({}))["ok"],
        false
    );
    assert!(store.load().unwrap().unwrap().simple_profiles.len() == 1);
}

#[test]
fn missing_event_state_is_locked_and_failed_logins_back_off() {
    let (d, _) = device();
    let mut serialized = serde_json::to_value(d.config.unwrap()).unwrap();
    serialized.as_object_mut().unwrap().remove("event_mode");
    let recovered: Config = serde_json::from_value(serialized).unwrap();
    assert!(recovered.event_mode);
    let mut auth = crate::auth::Auth::default();
    let login = drouter_auth::Login::new();
    auth.start("bad", &login.public_key(), &recovered.credential, 0)
        .unwrap();
    assert!(auth.prove("bad", &"00".repeat(32), 0).is_err());
    assert!(auth
        .start("early", &login.public_key(), &recovered.credential, 1)
        .is_err());
    auth.start("later", &login.public_key(), &recovered.credential, 2)
        .unwrap();
    assert!(auth.prove("later", &"00".repeat(32), 2).is_err());
    assert!(auth
        .start("early", &login.public_key(), &recovered.credential, 5)
        .is_err());
    assert!(auth
        .start("later", &login.public_key(), &recovered.credential, 6)
        .is_ok());
}

#[test]
fn receiver_order_is_validated_persisted_and_atomic() {
    let (mut d, store) = device();
    let mut second = receiver();
    second.id = "two".into();
    second.label = "Output two".into();
    call(&mut d, "receivers.add", json!(second)).unwrap();
    for ids in [
        json!(["one"]),
        json!(["one", "one"]),
        json!(["one", "missing"]),
    ] {
        assert!(call(&mut d, "receivers.reorder", json!({"ids":ids})).is_err());
        assert_eq!(d.config.as_ref().unwrap().receivers[0].id, "one");
    }
    call(&mut d, "receivers.reorder", json!({"ids":["two","one"]})).unwrap();
    assert_eq!(
        store.0.lock().unwrap().config.as_ref().unwrap().receivers[0].id,
        "two"
    );
    store.0.lock().unwrap().fail = true;
    assert!(call(&mut d, "receivers.reorder", json!({"ids":["one","two"]})).is_err());
    assert_eq!(d.config.as_ref().unwrap().receivers[0].id, "two");
}

struct RepairDecoder {
    decoder: Decoder,
    switches: Arc<Mutex<usize>>,
}
impl BirdDog for RepairDecoder {
    fn request(
        &mut self,
        r: &Receiver,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        if path == "/refresh" {
            // A refresh can lose the decoder's route. The repair must restore and verify it.
            self.decoder.active = "Camera B".into();
        }
        if method == "POST" && path.starts_with("/connectTo") {
            *self.switches.lock().unwrap() += 1;
        }
        self.decoder.request(r, method, path, body)
    }
}

#[test]
fn auto_fix_verifies_restoration_and_restricts_profile_targets() {
    let (_, store) = device();
    let switches = Arc::new(Mutex::new(0));
    let make = |ignore| {
        Device::new(
            Box::new(store.clone()),
            Box::new(RepairDecoder {
                decoder: Decoder {
                    active: "Camera A".into(),
                    ignore,
                    online: true,
                },
                switches: switches.clone(),
            }),
            true,
        )
        .unwrap()
    };
    let mut d = make(false);
    let result = call(&mut d, "route.repair", json!({"id":"one"})).unwrap();
    assert_eq!(result["restored"], true);
    assert_eq!(
        call(&mut d, "route.get", json!({})).unwrap()[0]["source"],
        "Camera A"
    );
    let mut failing = make(true);
    assert!(call(&mut failing, "route.repair", json!({"id":"one"})).is_err());
    assert!(call(&mut d, "route.repair", json!({"id":"missing"})).is_err());
    confirmed(&mut d, "simple.create", json!({"name":"Repair profile","password":"repair-password","actions":[simple_action("fixed","Camera B")]})).unwrap();
    confirmed(&mut d, "event.disable", json!({})).unwrap();
    let key = login_role(&mut d, "repair-user", "repair-password");
    let before = *switches.lock().unwrap();
    let result = rpc_role(
        &mut d,
        "repair-user",
        &key,
        1,
        "simple.repair",
        json!({"id":"one"}),
    );
    assert_eq!(result["ok"], false);
    assert!(result["error"].to_string().contains("forbidden"));
    assert_eq!(
        *switches.lock().unwrap(),
        before,
        "Unassigned sources must never be switched by a restricted user"
    );
    assert_eq!(
        rpc_role(
            &mut d,
            "repair-user",
            &key,
            2,
            "simple.repair",
            json!({"id":"missing"})
        )["ok"],
        false
    );
    assert_eq!(
        rpc_role(
            &mut d,
            "repair-user",
            &key,
            3,
            "route.repair",
            json!({"id":"one"})
        )["ok"],
        false
    );
    call(
        &mut d,
        "route.set",
        json!({"receiver":"one","source":"Camera B"}),
    )
    .unwrap();
    d.last_simple_action.clear();
    assert_eq!(
        rpc_role(
            &mut d,
            "repair-user",
            &key,
            4,
            "simple.repair",
            json!({"id":"one"})
        )["result"]["restored"],
        true
    );
    assert_eq!(
        rpc_role(
            &mut d,
            "repair-user",
            &key,
            5,
            "simple.repair",
            json!({"id":"one"})
        )["ok"],
        false,
        "Repair is rate limited"
    );
    confirmed(&mut d, "event.enable", json!({})).unwrap();
    d.last_simple_action.clear();
    let locked = rpc_role(
        &mut d,
        "repair-user",
        &key,
        6,
        "simple.repair",
        json!({"id":"one"}),
    );
    assert_eq!(locked["ok"], false);
    assert!(locked["error"].to_string().contains("event_locked"));
}
