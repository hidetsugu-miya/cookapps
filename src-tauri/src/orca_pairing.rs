//! A-12: the pairing of this machine's Orca. Orca's WebSocket takes only the token of a paired device (`validateToken` of its device registry), so the owner makes a pairing link for "This computer" in Orca's settings
//! (`orca://pair?code=...`) and pastes it into the settings of this app. The link is read, its ticket is exchanged for a token of ours as Orca's own client does (`pairing.exchangeTicket`, when the host says `pairing.ticket-exchange.v1`),
//! and the token and the host's public key are kept in the OS keychain, never in a file. Nothing is written to Orca's files.
//! The address is never kept: each connect reads the WebSocket of `orca-runtime.json` (the port can change), and only an address on this machine is used.
//! A token, a key or a link is in no return value, log line or error text (the types that hold one derive no `Debug`).

use std::time::Duration;

use base64::{
    alphabet,
    engine::{
        general_purpose::{GeneralPurpose, NO_PAD},
        Engine,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::time::timeout;
#[cfg(test)]
use ts_rs::TS;
use url::{Host, Url};

use crate::{
    keychain,
    orca::text_of,
    orca_e2ee::Handshake,
    orca_link::{orca_dir, read_json, reason_of, WsLink, RUNTIME_FILE},
};

/// The keychain service and user name of the pairing.
const SERVICE: &str = "jp.mysis.tsunagiai.orca";
const USER: &str = "this-machine";
/// What Orca takes of a link (`mobile-pairing-protocol-limits.js`): the code, the whole input, and the fields of the offer.
const CODE_MAX: usize = 128 * 1024;
const INPUT_MAX: usize = CODE_MAX + 1024;
const ENDPOINT_MAX: usize = 16 * 1024;
const TOKEN_MAX: usize = 64 * 1024;
const KEY_MAX: usize = 4 * 1024;
/// The capability of a host that takes `pairing.exchangeTicket`, and the method.
const TICKET_EXCHANGE: &str = "pairing.ticket-exchange.v1";
/// The time one call of the exchange may take (`EXCHANGE_TIMEOUT_MS` of Orca).
const CALL_TIMEOUT: Duration = Duration::from_secs(10);
/// The message when none is kept.
pub(crate) const NO_PAIRING: &str = "このマシンの Orca とのペアリングがありません";

/// Whether a pairing of this machine's Orca is kept.
#[derive(Serialize, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct OrcaPairing {
    pub paired: bool,
}

/// What the keychain holds: the token of this app as a device of Orca, and the host's public key it is pinned to.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Record {
    device_token: String,
    public_key_b64: String,
}

/// What a link carries, taken as far as it is usable: the address it names (on this machine), the token and the key.
struct Offer {
    url: String,
    record: Record,
}

// ---- the link ----

/// The bytes of a pairing code as Orca reads them (`normalizePairingBase64`): the URL-safe and the standard alphabet alike, with or without the padding, and the unused trailing bits allowed.
fn decode_code(code: &str) -> Result<Vec<u8>, String> {
    const BAD: &str = "ペアリングリンクの形が正しくありません";
    let alphabet_ok = |c: char| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '_' | '-');
    let body = code.trim_end_matches('=');
    if code.len() - body.len() > 2
        || body.is_empty()
        || code.len() > CODE_MAX
        || !body.chars().all(alphabet_ok)
        || body.len() % 4 == 1
    {
        return Err(BAD.into());
    }
    let standard: String = body
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .collect();
    const ENGINE: GeneralPurpose = GeneralPurpose::new(
        &alphabet::STANDARD,
        NO_PAD.with_decode_allow_trailing_bits(true),
    );
    ENGINE.decode(standard).map_err(|_| BAD.into())
}

/// The code of `orca://pair?code=...` (the host is exactly `pair`, there is no path, and the code is the query's `code` or else the fragment), or the input itself when it is a bare code.
fn code_of(input: &str) -> Result<&str, String> {
    const BAD: &str = "orca://pair のリンクか、ペアリングコードを貼ってください";
    let input = input.trim();
    if input.is_empty() {
        return Err(BAD.into());
    }
    let Some(rest) = input
        .get(..7)
        .filter(|scheme| scheme.eq_ignore_ascii_case("orca://"))
        .map(|_| &input[7..])
    else {
        return Ok(input);
    };
    let (rest, fragment) = rest.split_once('#').unwrap_or((rest, ""));
    let (place, query) = rest.split_once('?').unwrap_or((rest, ""));
    if place != "pair" && place != "pair/" {
        return Err(BAD.into());
    }
    let from_query = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("code="))
        .filter(|code| !code.is_empty());
    from_query
        .or(Some(fragment).filter(|code| !code.is_empty()))
        .ok_or_else(|| BAD.into())
}

/// The address `endpoint` names, when it is on this machine: `ws://` with the host `localhost` or a loopback address (an unspecified address, `0.0.0.0` or `::`, which Orca's server shows when it listens on every address, is this machine too when `wildcard` is set, and is reached as the loopback of its own family) and a port.
/// The frames are end-to-end encrypted, but TLS is not built in, so `wss://` is refused too. The path is dropped.
fn loopback_url(endpoint: &str, wildcard: bool) -> Result<String, String> {
    let url = Url::parse(endpoint.trim()).map_err(|_| "リンクの宛先を読めません".to_owned())?;
    if url.scheme() != "ws" {
        return Err("ws:// 以外の宛先にはつなげません".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        return Err("リンクの宛先を読めません".into());
    }
    let host =
        match url.host() {
            Some(Host::Ipv4(ip)) if ip.is_loopback() => ip.to_string(),
            Some(Host::Ipv4(ip)) if wildcard && ip.is_unspecified() => "127.0.0.1".to_owned(),
            Some(Host::Ipv6(ip)) if ip.is_loopback() => format!("[{ip}]"),
            Some(Host::Ipv6(ip)) if wildcard && ip.is_unspecified() => "[::1]".to_owned(),
            Some(Host::Domain("localhost")) => "localhost".to_owned(),
            Some(_) => return Err(
                "このマシンの Orca のリンクではありません（宛先が「This computer」ではありません）"
                    .into(),
            ),
            None => return Err("リンクの宛先を読めません".into()),
        };
    match url.port_or_known_default() {
        Some(port) if port != 0 => Ok(format!("ws://{host}:{port}")),
        _ => Err("リンクの宛先を読めません".into()),
    }
}

/// A pairing link (or a bare code) as an offer for this machine: the version 2 offer that Orca makes, not a phone's (`scope` `mobile`), with a token, a key that pins a host, and an address on this machine.
fn parse_link(input: &str) -> Result<Offer, String> {
    if input.len() > INPUT_MAX {
        return Err("ペアリングリンクが長すぎます".into());
    }
    let bytes = decode_code(code_of(input)?)?;
    let offer: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "ペアリングリンクの形が正しくありません".to_owned())?;
    if offer["v"] != 2 {
        return Err("このペアリングリンクの版には対応していません".into());
    }
    if offer["scope"] == "mobile" {
        return Err("モバイル専用のリンクです。別のクライアント用のリンクを作ってください".into());
    }
    let field = |key: &str, max: usize| {
        text_of(&offer, key)
            .filter(|s| s.len() <= max)
            .map(str::to_owned)
            .ok_or_else(|| "ペアリングリンクの形が正しくありません".to_owned())
    };
    let url = loopback_url(&field("endpoint", ENDPOINT_MAX)?, false)?;
    let record = Record {
        device_token: field("deviceToken", TOKEN_MAX)?,
        public_key_b64: field("publicKeyB64", KEY_MAX)?,
    };
    // The key that pins the host must be a key.
    Handshake::new(&record.public_key_b64).map_err(str::to_owned)?;
    Ok(Offer { url, record })
}

// ---- the exchange ----

/// A token that Orca takes for an exchange: 24 random bytes in hex, 48 characters.
fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|_| "乱数を作れません".to_owned())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// Whether the host (the `result` of `status.get`) is of a phone's grant (`deviceScope` `mobile`), which is no use here.
fn is_mobile_only(status: &Value) -> bool {
    status["deviceScope"] == "mobile"
}

/// Whether the host takes `pairing.exchangeTicket`.
fn takes_exchange(status: &Value) -> bool {
    status["capabilities"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|c| c == TICKET_EXCHANGE)
}

async fn call(link: &mut WsLink, method: &str, params: Value) -> Result<Value, String> {
    timeout(CALL_TIMEOUT, link.request(method, params))
        .await
        .map_err(|_| "接続先が時間内に応答しませんでした".to_owned())?
        .map_err(reason_of)
}

/// The record to keep for the offer, as Orca's own client does (`exchangeRemotePairingTicket`): connect with the link's token, ask `status.get`, and, when the host takes it, swap the link's token for one made here, which only this app holds,
/// then sign in once with it so that the host retires the link. A host that does not take the exchange, or that refuses it, leaves the link's own token to be kept; any failure of the exchange does.
async fn exchange(url: &str, record: Record) -> Result<Record, String> {
    let mut link = WsLink::connect(url, &record.device_token, &record.public_key_b64).await?;
    let status = call(&mut link, "status.get", json!({})).await?;
    if is_mobile_only(&status) {
        return Err("モバイル専用のリンクです。別のクライアント用のリンクを作ってください".into());
    }
    if !takes_exchange(&status) {
        return Ok(record);
    }
    let token = new_token()?;
    if call(
        &mut link,
        "pairing.exchangeTicket",
        json!({"deviceToken": token}),
    )
    .await
    .is_err()
    {
        return Ok(record);
    }
    // The host already stored the token: a failure here still leaves it working.
    if let Ok(mut signed_in) = WsLink::connect(url, &token, &record.public_key_b64).await {
        let _ = call(&mut signed_in, "status.get", json!({})).await;
    }
    Ok(Record {
        device_token: token,
        public_key_b64: record.public_key_b64,
    })
}

// ---- the keychain ----

fn read_record() -> Result<Option<Record>, String> {
    keychain::read(SERVICE, USER)?
        .map(|text| {
            serde_json::from_str(&text).map_err(|_| "保存したペアリングを読めません".to_owned())
        })
        .transpose()
}

fn write_record(record: &Record) -> Result<(), String> {
    let text = serde_json::to_string(record).map_err(|_| "ペアリングを保存できません")?;
    keychain::write(SERVICE, USER, &text)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}

fn status_of(record: Option<&Record>) -> OrcaPairing {
    OrcaPairing {
        paired: record.is_some(),
    }
}

// ---- the connection ----

/// Where this machine's stream connects and with what: the pairing kept, and the WebSocket of `orca-runtime.json` (`runtime`, or why it could not be read). The route is none without a pairing, without a WebSocket
/// in the runtime file, or when the address is not on this machine; the stream then does not run and the screen goes on with the CLI and the mirror (A-6, A-8).
fn local_route(
    record: Option<Record>,
    runtime: Result<Value, String>,
) -> Result<(String, Record), String> {
    let record = record.ok_or(NO_PAIRING)?;
    let runtime = runtime?;
    let endpoint = runtime["transports"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t["kind"] == "websocket")
        .and_then(|t| text_of(t, "endpoint"))
        .ok_or("Orca の接続情報に WebSocket の宛先がありません")?;
    Ok((loopback_url(endpoint, true)?, record))
}

/// A WebSocket to this machine's Orca, with the pairing read from the keychain and the address read from Orca's file now (A-12 streams the Orca screen over it).
pub(crate) async fn connect_local() -> Result<WsLink, String> {
    let (url, record) = blocking(|| {
        let runtime = orca_dir()
            .ok_or_else(|| "設定フォルダが見つかりません".to_owned())
            .and_then(|dir| {
                read_json(
                    &dir.join(RUNTIME_FILE),
                    "Orca が起動していません（orca-runtime.json がありません）",
                )
            });
        local_route(read_record()?, runtime)
    })
    .await?;
    WsLink::connect(&url, &record.device_token, &record.public_key_b64).await
}

/// Whether a pairing of this machine's Orca is kept.
pub(crate) async fn is_paired() -> Result<bool, String> {
    blocking(|| Ok(read_record()?.is_some())).await
}

// ---- the commands ----

/// Whether a pairing is kept. It asks Orca nothing.
#[tauri::command]
pub async fn orca_pairing_status() -> Result<OrcaPairing, String> {
    blocking(|| Ok(status_of(read_record()?.as_ref()))).await
}

/// Keeps the pairing of a link made for "This computer" in Orca's settings: the link is read, its ticket exchanged with Orca (which must be running), and the token and the key stored in the keychain, replacing a pairing kept before.
#[tauri::command]
pub async fn orca_pairing_save(link: String) -> Result<OrcaPairing, String> {
    let Offer { url, record } = parse_link(&link)?;
    let record = exchange(&url, record).await?;
    blocking(move || {
        write_record(&record)?;
        Ok(status_of(Some(&record)))
    })
    .await
}

/// Forgets the pairing: the keychain's item is deleted. Orca keeps the device in its own list, where it is revoked.
#[tauri::command]
pub async fn orca_pairing_revoke() -> Result<OrcaPairing, String> {
    blocking(|| {
        keychain::delete(SERVICE, USER)?;
        Ok(status_of(None))
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        orca_e2ee::testing::Desktop,
        orca_link::ws_testing::{bind, FakeDesktop},
    };
    use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};

    const SECRET: [u8; 32] = [7u8; 32];

    fn key() -> String {
        Desktop::new(SECRET).public_key_b64()
    }

    fn offer_json(endpoint: &str) -> Value {
        json!({"v": 2, "endpoint": endpoint, "deviceToken": "link-token", "publicKeyB64": key()})
    }

    fn code_of_json(offer: &Value) -> String {
        URL_SAFE_NO_PAD.encode(offer.to_string())
    }

    fn link(offer: &Value) -> String {
        format!("orca://pair?code={}", code_of_json(offer))
    }

    fn refused(input: &str) -> String {
        match parse_link(input) {
            Ok(_) => panic!("accepted"),
            Err(e) => e,
        }
    }

    #[test]
    fn a_link_for_this_computer_gives_its_address_token_and_key() {
        let offer = parse_link(&link(&offer_json("ws://127.0.0.1:6768"))).unwrap();
        assert_eq!(offer.url, "ws://127.0.0.1:6768");
        assert_eq!(offer.record.device_token, "link-token");
        assert_eq!(offer.record.public_key_b64, key());
    }

    #[test]
    fn a_bare_code_a_fragment_and_the_standard_alphabet_are_read_as_orca_reads_them() {
        let offer = offer_json("ws://localhost:1");
        let code = code_of_json(&offer);
        assert!(parse_link(&code).is_ok());
        assert!(parse_link(&format!("  {code}\n")).is_ok());
        assert!(parse_link(&format!("ORCA://pair#{code}")).is_ok());
        assert!(parse_link(&format!("orca://pair/?x=1&code={code}")).is_ok());
        // The code with the padding and with the standard alphabet.
        let standard = STANDARD.encode(offer.to_string());
        assert!(parse_link(&standard).is_ok());
        assert!(parse_link(&format!("orca://pair?code={standard}")).is_ok());
    }

    #[test]
    fn a_link_that_is_not_one_is_refused_with_its_reason() {
        let good = code_of_json(&offer_json("ws://127.0.0.1:6768"));
        for input in [
            "",
            "   ",
            "orca://pair",
            "orca://pair?code=",
            "orca://pairing?code=abc",
            "orca://pair/extra?code=abc",
            "orca://other?code=abc",
            "not base64 !!",
            "abcde",
            "a",
        ] {
            assert!(parse_link(input).is_err(), "{input}");
        }
        // Not JSON, and a version other than 2.
        assert!(parse_link(&URL_SAFE_NO_PAD.encode("hello")).is_err());
        let mut old = offer_json("ws://127.0.0.1:1");
        old["v"] = json!(1);
        assert!(refused(&link(&old)).contains("版"));
        // A phone's grant.
        let mut mobile = offer_json("ws://127.0.0.1:1");
        mobile["scope"] = json!("mobile");
        assert!(refused(&link(&mobile)).contains("モバイル"));
        // A runtime scope is fine.
        let mut runtime = offer_json("ws://127.0.0.1:1");
        runtime["scope"] = json!("runtime");
        assert!(parse_link(&link(&runtime)).is_ok());
        // Fields missing, blank or too long, and a key that is no key.
        for key in ["endpoint", "deviceToken", "publicKeyB64"] {
            let mut missing = offer_json("ws://127.0.0.1:1");
            missing.as_object_mut().unwrap().remove(key);
            assert!(parse_link(&link(&missing)).is_err(), "{key}");
            let mut blank = offer_json("ws://127.0.0.1:1");
            blank[key] = json!("  ");
            assert!(parse_link(&link(&blank)).is_err(), "{key}");
        }
        let mut long = offer_json("ws://127.0.0.1:1");
        long["deviceToken"] = json!("a".repeat(TOKEN_MAX + 1));
        assert!(parse_link(&link(&long)).is_err());
        let mut bad_key = offer_json("ws://127.0.0.1:1");
        bad_key["publicKeyB64"] = json!("AAAA");
        assert!(refused(&link(&bad_key)).contains("公開鍵"));
        assert!(refused(&format!("{good}{good}{}", "A".repeat(INPUT_MAX))).contains("長すぎ"));
    }

    #[test]
    fn only_a_link_to_an_address_on_this_machine_is_taken_and_none_of_its_secrets_reach_the_error()
    {
        for (endpoint, wanted) in [
            ("ws://127.0.0.1:6768", "ws://127.0.0.1:6768"),
            ("WS://127.9.9.9:1/path", "ws://127.9.9.9:1"),
            ("ws://localhost:80", "ws://localhost:80"),
            ("ws://LOCALHOST", "ws://localhost:80"),
            ("ws://[::1]:6768", "ws://[::1]:6768"),
        ] {
            assert_eq!(loopback_url(endpoint, false).unwrap(), wanted, "{endpoint}");
        }
        // Another machine, an unspecified address, another scheme, a user, a fragment and no port.
        for endpoint in [
            "ws://192.168.1.20:6768",
            "ws://100.64.0.1:6768",
            "ws://studio.example:6768",
            "ws://x.localhost:6768",
            "ws://0.0.0.0:6768",
            "ws://[::]:6768",
            "wss://127.0.0.1:6768",
            "http://127.0.0.1:6768",
            "ws://user:pass@127.0.0.1:6768",
            "ws://127.0.0.1:6768#frag",
            "ws://127.0.0.1:0",
            "ws://",
            "127.0.0.1:6768",
            "",
        ] {
            assert!(loopback_url(endpoint, false).is_err(), "{endpoint}");
        }
        let other = refused(&link(&offer_json("ws://192.168.1.20:6768")));
        assert!(other.contains("This computer"));
        for text in [&other, &refused(&link(&offer_json("wss://127.0.0.1:1")))] {
            assert!(!text.contains("link-token") && !text.contains(&key()));
        }
    }

    #[test]
    fn the_runtime_files_wildcard_address_is_this_machine_and_a_non_loopback_one_is_not() {
        for (endpoint, wanted) in [
            ("ws://127.0.0.1:6768", "ws://127.0.0.1:6768"),
            ("ws://0.0.0.0:6768", "ws://127.0.0.1:6768"),
            ("ws://[::]:6768", "ws://[::1]:6768"),
        ] {
            assert_eq!(loopback_url(endpoint, true).unwrap(), wanted, "{endpoint}");
        }
        assert!(loopback_url("ws://192.168.1.20:6768", true).is_err());
        assert!(loopback_url("ws://0.0.0.0:0", true).is_err());
    }

    #[test]
    fn the_route_needs_a_pairing_and_a_websocket_on_this_machine() {
        let record = || Record {
            device_token: "tok".into(),
            public_key_b64: "key".into(),
        };
        let runtime =
            |transports: Value| json!({"transports": transports, "authToken": "unix-token"});
        let both = runtime(json!([
            {"kind": "unix", "endpoint": "/tmp/o.sock"},
            {"kind": "websocket", "endpoint": "ws://0.0.0.0:6768"},
        ]));
        let (url, kept) = local_route(Some(record()), Ok(both.clone())).unwrap();
        assert_eq!(url, "ws://127.0.0.1:6768");
        assert_eq!(
            (kept.device_token.as_str(), kept.public_key_b64.as_str()),
            ("tok", "key")
        );
        // No pairing says so, whatever the runtime file holds.
        assert_eq!(local_route(None, Ok(both)).err().unwrap(), NO_PAIRING);
        // The runtime file cannot be read: its reason.
        assert_eq!(
            local_route(Some(record()), Err("Orca が起動していません".into()))
                .err()
                .unwrap(),
            "Orca が起動していません"
        );
        // No WebSocket, an empty or odd transport, and an address that is not this machine's.
        for transports in [
            json!([{"kind": "unix", "endpoint": "/tmp/o.sock"}]),
            json!([{"kind": "websocket"}]),
            json!([{"kind": "websocket", "endpoint": "  "}]),
            json!([{"kind": "websocket", "endpoint": "ws://10.0.0.5:6768"}]),
            json!([{"kind": "websocket", "endpoint": "wss://127.0.0.1:6768"}]),
            json!("none"),
            Value::Null,
        ] {
            assert!(
                local_route(Some(record()), Ok(runtime(transports.clone()))).is_err(),
                "{transports}"
            );
        }
        assert!(local_route(Some(record()), Ok(Value::Null)).is_err());
        // The unix token of the runtime file is never the one used.
        assert_ne!(kept.device_token, "unix-token");
    }

    #[test]
    fn a_new_token_is_48_lowercase_hex_characters_and_never_twice_the_same() {
        let (a, b) = (new_token().unwrap(), new_token().unwrap());
        for token in [&a, &b] {
            assert_eq!(token.len(), 48);
            assert!(token.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
        }
        assert_ne!(a, b);
    }

    #[test]
    fn the_host_status_says_a_phone_only_grant_and_the_exchange() {
        assert!(is_mobile_only(&json!({"deviceScope": "mobile"})));
        assert!(!is_mobile_only(&json!({"deviceScope": "runtime"})));
        assert!(!is_mobile_only(&json!({})));
        assert!(takes_exchange(
            &json!({"capabilities": ["a", TICKET_EXCHANGE]})
        ));
        assert!(!takes_exchange(&json!({"capabilities": ["a"]})));
        assert!(!takes_exchange(&json!({"capabilities": "x"})));
        assert!(!takes_exchange(&json!({})));
    }

    #[test]
    fn the_record_is_one_json_entry_and_a_stored_value_that_is_none_is_an_error() {
        let record = Record {
            device_token: "tok".into(),
            public_key_b64: "key".into(),
        };
        let text = serde_json::to_string(&record).unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&text).unwrap(),
            json!({"deviceToken": "tok", "publicKeyB64": "key"})
        );
        let back: Record = serde_json::from_str(&text).unwrap();
        assert_eq!(back.device_token, "tok");
        assert!(serde_json::from_str::<Record>("{}").is_err());
        assert_eq!(
            serde_json::to_value(status_of(Some(&record))).unwrap(),
            json!({"paired": true})
        );
        assert_eq!(
            serde_json::to_value(status_of(None)).unwrap(),
            json!({"paired": false})
        );
    }

    /// A stand-in Orca that takes the link's token, answers `status.get` with `status`, and, when `exchange` is `Some`, takes (`true`) or refuses (`false`) `pairing.exchangeTicket` and then takes a connection with the new token.
    /// Answers the token the client exchanged to, if it asked.
    async fn host(
        listener: tokio::net::TcpListener,
        status: Value,
        exchange: Option<bool>,
    ) -> Option<String> {
        let mut server =
            FakeDesktop::accept(&listener, Desktop::new(SECRET), "link-token", None).await;
        let request = server.request().await;
        assert_eq!(request["method"], "status.get");
        server
            .send(json!({"id": request["id"], "ok": true, "result": status}))
            .await;
        let accepted = exchange?;
        let request = server.request().await;
        assert_eq!(request["method"], "pairing.exchangeTicket");
        let token = request["params"]["deviceToken"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(request["params"].as_object().unwrap().len(), 1);
        if !accepted {
            server
                .send(json!({"id": request["id"], "ok": false, "error": {"code": "unauthorized", "message": "no"}}))
                .await;
            return Some(token);
        }
        server
            .send(json!({"id": request["id"], "ok": true, "result": {}}))
            .await;
        // The client signs in once with the new token.
        let mut again = FakeDesktop::accept(&listener, Desktop::new(SECRET), &token, None).await;
        let request = again.request().await;
        assert_eq!(request["method"], "status.get");
        again
            .send(json!({"id": request["id"], "ok": true, "result": {}}))
            .await;
        Some(token)
    }

    fn offered() -> Record {
        Record {
            device_token: "link-token".into(),
            public_key_b64: key(),
        }
    }

    #[tokio::test]
    async fn the_link_token_is_swapped_for_one_of_ours_when_the_host_takes_the_exchange() {
        let (listener, url) = bind().await;
        let served = tokio::spawn(host(
            listener,
            json!({"capabilities": [TICKET_EXCHANGE], "deviceScope": "runtime"}),
            Some(true),
        ));
        let kept = exchange(&url, offered()).await.unwrap();
        let exchanged = served.await.unwrap().unwrap();
        assert_eq!(kept.device_token, exchanged);
        assert_ne!(kept.device_token, "link-token");
        assert_eq!(kept.device_token.len(), 48);
        assert_eq!(kept.public_key_b64, key());
    }

    #[tokio::test]
    async fn the_link_token_is_kept_when_the_host_has_no_exchange_or_refuses_it() {
        let (listener, url) = bind().await;
        let served = tokio::spawn(host(listener, json!({"capabilities": []}), None));
        let kept = exchange(&url, offered()).await.unwrap();
        assert_eq!(kept.device_token, "link-token");
        assert!(served.await.unwrap().is_none());

        let (listener, url) = bind().await;
        let served = tokio::spawn(host(
            listener,
            json!({"capabilities": [TICKET_EXCHANGE]}),
            Some(false),
        ));
        let kept = exchange(&url, offered()).await.unwrap();
        assert_eq!(kept.device_token, "link-token");
        assert!(served.await.unwrap().is_some());
    }

    #[tokio::test]
    async fn a_phone_only_host_and_a_refused_token_end_the_save_with_a_reason_and_no_secret() {
        let (listener, url) = bind().await;
        let served = tokio::spawn(host(
            listener,
            json!({"capabilities": [TICKET_EXCHANGE], "deviceScope": "mobile"}),
            None,
        ));
        let e = exchange(&url, offered()).await.err().unwrap();
        served.await.unwrap();
        assert!(e.contains("モバイル"));

        // The host refuses the link's token.
        let (listener, url) = bind().await;
        let refusing = tokio::spawn(async move {
            FakeDesktop::accept(
                &listener,
                Desktop::new(SECRET),
                "link-token",
                Some(json!({"type": "e2ee_error", "v": 2})),
            )
            .await;
        });
        let e = exchange(&url, offered()).await.err().unwrap();
        refusing.await.unwrap();
        assert!(!e.contains("link-token") && !e.contains(&key()));

        // Nothing listens.
        let (listener, url) = bind().await;
        drop(listener);
        let e = exchange(&url, offered()).await.err().unwrap();
        assert!(!e.contains("link-token"));
    }
}
