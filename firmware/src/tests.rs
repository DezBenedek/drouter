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
fn full_day_sessions_keep_six_hour_settings_access_expiry_replay_and_revocation_guards() {
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
    assert!(auth.elevated(sid, start + 300));
    assert_eq!(crate::auth::SETTINGS_ACCESS_SECONDS, 21600);
    assert!(auth.elevated(sid, start + 21599));
    assert!(!auth.elevated(sid, start + 21600));
    assert!(auth.role(sid, start + 21600).is_ok());
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

struct ManagedDecoder {
    calls: Arc<Mutex<Vec<String>>>,
    stale: bool,
    encoder: bool,
}
impl BirdDog for ManagedDecoder {
    fn request(
        &mut self,
        _: &Receiver,
        method: &str,
        path: &str,
        _: Option<Value>,
    ) -> Result<Value> {
        self.calls.lock().unwrap().push(format!("{method} {path}"));
        match path {
            "/about" => Ok(json!({"FirmwareVersion":"BirdDog managed","HostName":"bird-input"})),
            "/reset" => {
                self.stale = false;
                Ok(json!({}))
            }
            "/List" => Ok(if self.stale {
                json!({"Active":"192.168.1.50:5961","Old":"192.168.1.51"})
            } else {
                json!({"Active":"192.168.1.50:5961"})
            }),
            "/reboot" | "/restart" | "/refresh" => Ok(json!({})),
            p if p.starts_with("/connectTo") && !self.encoder => Ok(json!({"sourceName":"Active"})),
            _ => bail!("Unsupported endpoint"),
        }
    }
}
#[test]
fn birddog_reset_clears_device_cache_and_preserves_saved_configuration() {
    let (_, store) = device();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mut d = Device::new(
        Box::new(store.clone()),
        Box::new(ManagedDecoder {
            calls: calls.clone(),
            stale: true,
            encoder: false,
        }),
        true,
    )
    .unwrap();
    let before = serde_json::to_value(d.config.as_ref().unwrap()).unwrap();
    let fresh = call(&mut d, "birddog.sources.reset", json!({"id":"one"})).unwrap();
    assert_eq!(fresh["sources"].as_array().unwrap().len(), 1);
    assert_eq!(fresh["sources"][0]["ip"], "192.168.1.50");
    assert_eq!(
        &calls.lock().unwrap()[..],
        &["GET /about", "POST /reset", "GET /List"]
    );
    assert_eq!(
        serde_json::to_value(d.config.as_ref().unwrap()).unwrap(),
        before
    );
    assert!(call(&mut d, "birddog.info", json!({"ip":"8.8.8.8"})).is_err());
    assert!(call(
        &mut d,
        "birddog.info",
        json!({"id":"one","ip":"192.168.1.20"})
    )
    .is_err());
    assert!(call(&mut d, "birddog.reboot", json!({"id":"one"})).is_err());
    call(
        &mut d,
        "birddog.restart",
        json!({"id":"one","confirmed":true}),
    )
    .unwrap();
    assert!(calls.lock().unwrap().iter().any(|c| c == "POST /restart"));
}
#[test]
fn birddog_encoder_management_does_not_require_decoder_readback_and_restricts_roles() {
    let (_, store) = device();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let mut d = Device::new(
        Box::new(store),
        Box::new(ManagedDecoder {
            calls: calls.clone(),
            stale: false,
            encoder: true,
        }),
        true,
    )
    .unwrap();
    assert_eq!(
        call(
            &mut d,
            "birddog.info",
            json!({"ip":"192.168.1.50","port":8080})
        )
        .unwrap()["about"]["HostName"],
        "bird-input"
    );
    assert!(!calls
        .lock()
        .unwrap()
        .iter()
        .any(|c| c.contains("connectTo")));
    confirmed(&mut d,"simple.create",json!({"name":"Restricted","password":"restricted-manager","actions":[simple_action("fixed","Active")]})).unwrap();
    let key = login_role(&mut d, "restricted-bird", "restricted-manager");
    for (i, op) in ["birddog.info", "birddog.sources.reset", "birddog.reboot"]
        .iter()
        .enumerate()
    {
        assert_eq!(
            rpc_role(
                &mut d,
                "restricted-bird",
                &key,
                i as u64 + 1,
                op,
                json!({"id":"one","confirmed":true})
            )["ok"],
            false
        );
    }
}

struct RecoveryState {
    active: String,
    cached: Vec<String>,
    failures: std::collections::BTreeMap<String, usize>,
    calls: Vec<String>,
    lag: usize,
    pending: Option<(String, usize)>,
    drop_route_on_reset: bool,
    reset_supported: bool,
    ignore_switches: usize,
    post_reply_lost: bool,
    missing_source: bool,
}
impl Default for RecoveryState {
    fn default() -> Self {
        Self {
            active: "Camera A".into(),
            cached: vec!["Camera A".into(), "Camera B".into()],
            failures: Default::default(),
            calls: vec![],
            lag: 0,
            pending: None,
            drop_route_on_reset: false,
            reset_supported: true,
            ignore_switches: 0,
            post_reply_lost: false,
            missing_source: false,
        }
    }
}
struct RecoveryDecoder(Arc<Mutex<RecoveryState>>);
impl BirdDog for RecoveryDecoder {
    fn request(
        &mut self,
        _: &Receiver,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let mut s = self.0.lock().unwrap();
        let endpoint = path.split('?').next().unwrap();
        let key = format!("{method} {endpoint}");
        s.calls.push(key.clone());
        if let Some(remaining) = s.failures.get_mut(&key) {
            if *remaining > 0 {
                *remaining -= 1;
                bail!("Temporary HTTP failure");
            }
        }
        match (method, endpoint) {
            ("GET", "/connectTo") => {
                if let Some((source, remaining)) = s.pending.take() {
                    if remaining == 0 {
                        s.active = source;
                    } else {
                        s.pending = Some((source, remaining - 1));
                    }
                }
                Ok(json!({"sourceName":s.active}))
            }
            ("POST", "/connectTo") => {
                if s.ignore_switches > 0 {
                    s.ignore_switches -= 1;
                } else {
                    let source = body.unwrap()["sourceName"].as_str().unwrap().to_string();
                    if s.lag > 0 {
                        let lag = s.lag;
                        s.pending = Some((source, lag));
                    } else {
                        s.active = source;
                    }
                }
                if s.post_reply_lost {
                    bail!("POST response timed out after apply");
                }
                Ok(json!({}))
            }
            ("POST", "/refresh" | "/reset") => {
                if endpoint == "/reset" {
                    if !s.reset_supported {
                        bail!("BirdDog HTTP 404");
                    }
                    if s.drop_route_on_reset {
                        s.active = "Camera B".into();
                    }
                }
                s.cached = if s.missing_source {
                    vec!["Camera B".into()]
                } else {
                    vec!["Camera A".into(), "Camera B".into()]
                };
                Ok(json!({}))
            }
            ("GET", "/List") => Ok(json!(s
                .cached
                .iter()
                .map(|n| (n.clone(), "10.0.0.1"))
                .collect::<std::collections::BTreeMap<_, _>>())),
            _ => bail!("Unsupported endpoint"),
        }
    }
}
fn recovery_device(state: RecoveryState) -> (Device, Arc<Mutex<RecoveryState>>, Store) {
    let (_, store) = device();
    let state = Arc::new(Mutex::new(state));
    let d = Device::new(
        Box::new(store.clone()),
        Box::new(RecoveryDecoder(state.clone())),
        true,
    )
    .unwrap();
    (d, state, store)
}
#[test]
fn routing_recovers_discovery_transient_readback_delayed_apply_and_lost_post_reply() {
    let (mut d, state, _) = recovery_device(RecoveryState {
        cached: vec!["Camera A".into()],
        lag: 4,
        failures: [("GET /connectTo".into(), 2)].into(),
        post_reply_lost: true,
        ..Default::default()
    });
    let result = call(
        &mut d,
        "route.set",
        json!({"receiver":"one","source":"Camera B"}),
    )
    .unwrap();
    assert_eq!(result["source"], "Camera B");
    let s = state.lock().unwrap();
    assert!(s.calls.contains(&"POST /refresh".into()));
    assert_eq!(
        s.calls.iter().filter(|p| *p == "POST /connectTo").count(),
        1,
        "A lost reply must not resend a command already confirmed by readback"
    );
}
#[test]
fn routing_retries_a_rejected_switch_and_still_verifies_the_actual_source() {
    let (mut d, state, _) = recovery_device(RecoveryState {
        ignore_switches: 1,
        ..Default::default()
    });
    let result = call(
        &mut d,
        "route.set",
        json!({"receiver":"one","source":"Camera B"}),
    )
    .unwrap();
    assert_eq!(result["source"], "Camera B");
    assert_eq!(
        state
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|p| *p == "POST /connectTo")
            .count(),
        2
    );
}
#[test]
fn staged_repair_recovers_multiple_faults_reports_progress_and_preserves_configuration() {
    let (mut d, state, store) = recovery_device(RecoveryState {
        cached: vec!["Retired source".into()],
        drop_route_on_reset: true,
        failures: [("GET /connectTo".into(), 2), ("POST /refresh".into(), 1)].into(),
        ..Default::default()
    });
    let before = serde_json::to_value(d.config.clone()).unwrap();
    let writes = store.0.lock().unwrap().writes;
    let mut result = call(&mut d, "route.repair", json!({"id":"one","staged":true})).unwrap();
    assert_eq!(result["completed"], 0);
    for phase in 1..=6 {
        result = call(
            &mut d,
            "route.repair",
            json!({"id":"one","token":result["token"]}),
        )
        .unwrap();
        assert_eq!(result["completed"], phase);
        assert_eq!(result["done"], phase == 6);
    }
    assert_eq!(result["verified"], true);
    assert_eq!(result["reset"], true);
    assert_eq!(result["source"], "Camera A");
    assert!(result["notes"].to_string().contains("stale NDI"));
    assert!(result["notes"].to_string().contains("temporary receiver"));
    assert_eq!(state.lock().unwrap().active, "Camera A");
    assert_eq!(serde_json::to_value(d.config.clone()).unwrap(), before);
    assert_eq!(store.0.lock().unwrap().writes, writes);
    assert!(
        call(
            &mut d,
            "route.repair",
            json!({"id":"one","token":result["token"]})
        )
        .is_err(),
        "Completed jobs cannot be replayed"
    );
}
#[test]
fn repair_handles_unsupported_reset_but_never_claims_a_missing_source_is_restored() {
    let (mut d, _, _) = recovery_device(RecoveryState {
        reset_supported: false,
        ..Default::default()
    });
    let result = call(&mut d, "route.repair", json!({"id":"one"})).unwrap();
    assert_eq!(result["verified"], true);
    assert_eq!(result["reset"], false);
    assert!(result["notes"].to_string().contains("404"));
    let (mut d, state, _) = recovery_device(RecoveryState {
        missing_source: true,
        ..Default::default()
    });
    assert!(call(&mut d, "route.repair", json!({"id":"one"})).is_err());
    assert!(
        !state
            .lock()
            .unwrap()
            .calls
            .iter()
            .any(|p| p == "POST /connectTo"),
        "Repair never picks an arbitrary substitute source"
    );
}
#[test]
fn staged_repair_is_session_bound_and_cannot_overwrite_a_newer_route() {
    let (mut d, _, _) = recovery_device(Default::default());
    let key = login_role(&mut d, "repair-admin", "correct horse battery");
    let other = login_role(&mut d, "other-admin", "correct horse battery");
    let start = rpc_role(
        &mut d,
        "repair-admin",
        &key,
        1,
        "route.repair",
        json!({"id":"one","staged":true}),
    );
    let token = start["result"]["token"].clone();
    assert!(token.is_string());
    let foreign = rpc_role(
        &mut d,
        "other-admin",
        &other,
        1,
        "route.repair",
        json!({"id":"one","token":token}),
    );
    assert_eq!(foreign["ok"], false);
    assert!(foreign["error"].to_string().contains("forbidden"));
    assert_eq!(
        rpc_role(
            &mut d,
            "repair-admin",
            &key,
            2,
            "route.repair",
            json!({"id":"one","token":token})
        )["ok"],
        true
    );
    call(
        &mut d,
        "route.set",
        json!({"receiver":"one","source":"Camera B"}),
    )
    .unwrap();
    let cancelled = rpc_role(
        &mut d,
        "repair-admin",
        &key,
        3,
        "route.repair",
        json!({"id":"one","token":token}),
    );
    assert_eq!(cancelled["ok"], false);
    assert!(cancelled["error"].to_string().contains("cancelled"));
    assert_eq!(
        call(&mut d, "route.get", json!({})).unwrap()[0]["source"],
        "Camera B"
    );
}
#[test]
fn empty_routes_are_normalized_and_repair_never_selects_a_default_source() {
    let (mut d, state, _) = recovery_device(RecoveryState {
        active: "None".into(),
        ..Default::default()
    });
    let result = call(&mut d, "route.repair", json!({"id":"one"})).unwrap();
    assert_eq!(result["source"], "");
    assert_eq!(result["restored"], false);
    assert!(!state
        .lock()
        .unwrap()
        .calls
        .iter()
        .any(|p| p == "POST /connectTo"));
}

#[test]
fn settings_remain_available_after_five_minutes_and_require_login_only_after_six_hours() {
    let (mut d, _) = device();
    let key = login_role(&mut d, "long-settings", "correct horse battery");
    // Move the device clock instead of making a test wait six hours.
    d.boot -= std::time::Duration::from_secs(3600);
    let revision = d.config.as_ref().unwrap().revision;
    let allowed = rpc_role(
        &mut d,
        "long-settings",
        &key,
        1,
        "event.enable",
        json!({"confirmed":true,"expected_revision":revision}),
    );
    assert_eq!(
        allowed["ok"], true,
        "Settings changes still work after one hour"
    );
    d.boot -= std::time::Duration::from_secs(5 * 3600 + 1);
    let revision = d.config.as_ref().unwrap().revision;
    let expired = rpc_role(
        &mut d,
        "long-settings",
        &key,
        2,
        "event.disable",
        json!({"confirmed":true,"expected_revision":revision}),
    );
    assert_eq!(expired["ok"], false);
    assert!(expired["error"]
        .to_string()
        .contains("Reconnect to authorize"));
    assert!(d.config.as_ref().unwrap().event_mode);
    let read = rpc_role(&mut d, "long-settings", &key, 3, "device.info", json!({}));
    assert_eq!(
        read["ok"], true,
        "The ordinary session remains valid after settings access expires"
    );
    d.auth.revoke();
    assert!(
        d.auth.role("long-settings", d.now()).is_err(),
        "Revocation still applies immediately"
    );
}

#[test]
fn resume_rekeys_sessions_rotates_tickets_and_preserves_original_six_hour_deadline() {
    use crate::auth::{resume_key, resume_proof};
    let (mut d, _) = device();
    let original = "reload-original";
    let key = login_role(&mut d, original, "correct horse battery");
    let issued = rpc_role(&mut d, original, &key, 1, "auth.resume.create", json!({}));
    assert_eq!(issued["ok"], true);
    let ticket = issued["result"]["ticket"].as_str().unwrap();
    let secret = hex::decode(issued["result"]["secret"].as_str().unwrap()).unwrap();
    let deadline = issued["result"]["expiresIn"].as_u64().unwrap() + d.now();
    d.auth.remove(original); // Relay leave / local detach must preserve the resume credential.
    let now = d.now() + 3600;
    let sid = "reload-new";
    let challenge = d.auth.resume_start(sid, ticket, now).unwrap();
    let nonce = challenge["nonce"].as_str().unwrap();
    assert_eq!(
        challenge["proof"],
        resume_proof(&secret, "server", sid, ticket, nonce).unwrap()
    );
    let proof = resume_proof(&secret, "client", sid, ticket, nonce).unwrap();
    let resumed = d.auth.resume_prove(sid, &proof, now).unwrap();
    assert_eq!(resumed["type"], "auth.resumed");
    assert_eq!(
        resumed["proof"],
        resume_proof(&secret, "accepted", sid, ticket, nonce).unwrap()
    );
    assert!(d.auth.elevated(sid, deadline - 2));
    assert!(!d.auth.elevated(sid, deadline));
    let fresh = d.auth.issue_resume(sid, now).unwrap();
    assert_ne!(fresh["ticket"], ticket);
    assert!(
        fresh["expiresIn"]
            .as_u64()
            .unwrap()
            .abs_diff(deadline - now)
            <= 1
    );
    assert!(d.auth.resume_start("replay", ticket, now).is_err());
    let new_key = resume_key(&secret, sid, ticket, nonce).unwrap();
    assert_ne!(new_key, key);
    let packet = json!({"v":1,"id":"1","op":"device.info","params":{}});
    let frame = json!({"seq":1,"data":hex::encode(crypt(true,&new_key,sid,1,packet.to_string().as_bytes(),false).unwrap())});
    assert_eq!(d.auth.decrypt(sid, &frame, now).unwrap(), packet);
    assert!(d.auth.decrypt(sid, &frame, now).is_err());
    d.auth.logout(sid);
    assert!(d
        .auth
        .resume_start("after-logout", fresh["ticket"].as_str().unwrap(), now)
        .is_err());
}

#[test]
fn resume_rejects_wrong_proof_replays_expired_challenges_and_revoked_credentials() {
    use crate::auth::resume_proof;
    let (mut d, _) = device();
    let key = login_role(&mut d, "resume-user", "correct horse battery");
    let issued = rpc_role(
        &mut d,
        "resume-user",
        &key,
        1,
        "auth.resume.create",
        json!({}),
    )["result"]
        .clone();
    let ticket = issued["ticket"].as_str().unwrap();
    let secret = hex::decode(issued["secret"].as_str().unwrap()).unwrap();
    let challenge = d.auth.resume_start("wrong-proof", ticket, 100).unwrap();
    let nonce = challenge["nonce"].as_str().unwrap();
    // Server proof is never valid as a client proof, nor on a different session.
    assert!(d
        .auth
        .resume_prove("wrong-proof", challenge["proof"].as_str().unwrap(), 100)
        .is_err());
    let challenge = d.auth.resume_start("expired", ticket, 200).unwrap();
    let proof = resume_proof(
        &secret,
        "client",
        "expired",
        ticket,
        challenge["nonce"].as_str().unwrap(),
    )
    .unwrap();
    assert!(d.auth.resume_prove("expired", &proof, 231).is_err());
    d.auth.resume_start("other-session", ticket, 300).unwrap();
    let wrong = resume_proof(&secret, "client", "wrong-proof", ticket, nonce).unwrap();
    assert!(d.auth.resume_prove("other-session", &wrong, 300).is_err());
    assert!(
        d.auth.role("resume-user", 300).is_ok(),
        "A failed resume cannot destroy the original authenticated session"
    );
    let good = d.auth.resume_start("good", ticket, 400).unwrap();
    let proof = resume_proof(
        &secret,
        "client",
        "good",
        ticket,
        good["nonce"].as_str().unwrap(),
    )
    .unwrap();
    assert!(d.auth.resume_prove("good", &proof, 400).is_ok());
    let rotated = d.auth.issue_resume("good", 400).unwrap();
    d.auth.revoke();
    assert!(d
        .auth
        .resume_start("revoked", rotated["ticket"].as_str().unwrap(), 401)
        .is_err());
    assert!(d.auth.resume_prove("good", &proof, 401).is_err());
}

#[test]
fn profile_resume_credentials_are_revoked_by_password_change_disable_delete_and_restart() {
    for change in ["password", "disable", "delete", "restart"] {
        let (mut d, store) = device();
        confirmed(&mut d,"simple.create",json!({"name":"Reload profile","password":"resume-simple","actions":[simple_action("one","Camera A")]})).unwrap();
        let id = d.config.as_ref().unwrap().simple_profiles[0].id.clone();
        let key = login_role(&mut d, "simple-resume", "resume-simple");
        let issued = rpc_role(
            &mut d,
            "simple-resume",
            &key,
            1,
            "auth.resume.create",
            json!({}),
        )["result"]
            .clone();
        assert!(issued["ticket"].is_string());
        d.auth.remove("simple-resume");
        match change {
            "password" => {
                confirmed(
                    &mut d,
                    "simple.update",
                    json!({"id":id,"password":"replacement-resume"}),
                )
                .unwrap();
            }
            "disable" => {
                confirmed(&mut d, "simple.update", json!({"id":id,"enabled":false})).unwrap();
            }
            "delete" => {
                confirmed(&mut d, "simple.delete", json!({"id":id})).unwrap();
            }
            _ => {
                d = Device::new(
                    Box::new(store),
                    Box::new(Decoder {
                        active: "Camera A".into(),
                        online: true,
                        ignore: false,
                    }),
                    true,
                )
                .unwrap();
            }
        }
        assert!(
            d.auth
                .resume_start("not-allowed", issued["ticket"].as_str().unwrap(), d.now())
                .is_err(),
            "{change} must invalidate stored resume credentials"
        );
    }
}
