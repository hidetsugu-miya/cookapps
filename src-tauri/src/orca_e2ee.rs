//! The client side of the "E2EE v2" framing of Orca's paired connection (a WebSocket to another machine's Orca).
//! Pure: bytes and strings in and out, no I/O. A token or a key is in no error text and no `Debug` output (the types here derive none).
//!
//! The handshake is the client's half of Orca's `PairedE2EEV2ClientSession`: a plain-text hello with the client's public key and nonce,
//! a plain-text ready that must name the pinned desktop key, then every frame is a NaCl secretbox sealed under a key of HKDF over the X25519 secret.
//! The first sealed frame is the token's auth.

use base64::{engine::general_purpose::STANDARD, Engine};
use crypto_secretbox::{
    aead::{generic_array::GenericArray, AeadInPlace, KeyInit},
    Key, Nonce, XSalsa20Poly1305,
};
use hkdf::Hkdf;
use salsa20::{
    cipher::{array::Array, consts::U10},
    hsalsa,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use x25519_dalek::{x25519, X25519_BASEPOINT_BYTES};

const PROTOCOL: &str = "orca-mobile-e2ee";
const TRANSCRIPT_DOMAIN: &str = "orca-mobile-e2ee/v2/transcript";
const SALT_LABEL: &[u8] = b"orca-mobile-e2ee/v2/salt\0";
const INFO_LABEL: &[u8] = b"orca-mobile-e2ee/v2/session\0";
const FRAME_VERSION: u8 = 2;
const NONCE_LENGTH: usize = 24;
const TAG_LENGTH: usize = 16;
const SESSION_ID_LENGTH: usize = 32;
/// Session ID, direction, payload kind and the counter (8 bytes), sealed in front of every payload.
const HEADER_LENGTH: usize = SESSION_ID_LENGTH + 1 + 1 + 8;

#[derive(Clone, Copy, PartialEq)]
enum Direction {
    MobileToDesktop = 0,
    DesktopToMobile = 1,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Text = 0,
    Binary = 1,
}

/// A 32-byte value in canonical padded base64 (`None` for anything else, so one value has one spelling).
fn canonical_32(value: &str) -> Option<[u8; 32]> {
    let bytes = STANDARD.decode(value).ok()?;
    if STANDARD.encode(&bytes) != value {
        return None;
    }
    bytes.try_into().ok()
}

/// NaCl `box.before`: HSalsa20 over the X25519 secret with a zero input.
fn box_before(secret_key: [u8; 32], public_key: [u8; 32]) -> [u8; 32] {
    let shared = x25519(secret_key, public_key);
    let key = Array::from(shared);
    let zero = Array::from([0u8; 16]);
    hsalsa::<U10>(&key, &zero).into()
}

/// What the key schedule gives: a key for each direction, the session ID the frames carry, and the hash the auth frame echoes.
struct KeySchedule {
    mobile_to_desktop: [u8; 32],
    desktop_to_mobile: [u8; 32],
    session_id: [u8; 32],
    transcript_hash: [u8; 32],
}

fn key_schedule(
    shared_secret: &[u8; 32],
    transcript: &[u8],
    client_nonce: &[u8; 32],
    desktop_nonce: &[u8; 32],
) -> KeySchedule {
    let transcript_hash: [u8; 32] = Sha256::digest(transcript).into();
    let salt = Sha256::new()
        .chain_update(SALT_LABEL)
        .chain_update(client_nonce)
        .chain_update(desktop_nonce)
        .finalize();
    let info = [INFO_LABEL, &transcript_hash].concat();
    let mut expanded = [0u8; 96];
    Hkdf::<Sha256>::new(Some(&salt), shared_secret)
        .expand(&info, &mut expanded)
        .expect("96 bytes are within the HKDF limit");
    let part = |from: usize| -> [u8; 32] { expanded[from..from + 32].try_into().unwrap() };
    KeySchedule {
        mobile_to_desktop: part(0),
        desktop_to_mobile: part(32),
        session_id: part(64),
        transcript_hash,
    }
}

fn field(name: &str, value: &[u8]) -> Vec<u8> {
    let length = |bytes: &[u8]| u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes();
    [
        &length(name.as_bytes())[..],
        name.as_bytes(),
        &length(value),
        value,
    ]
    .concat()
}

fn uint32(value: u32) -> [u8; 4] {
    value.to_be_bytes()
}

fn string_list(values: &[&str]) -> Vec<u8> {
    let mut out = uint32(u32::try_from(values.len()).unwrap_or(u32::MAX)).to_vec();
    for value in values {
        out.extend(uint32(u32::try_from(value.len()).unwrap_or(u32::MAX)));
        out.extend(value.as_bytes());
    }
    out
}

/// The two public keys and nonces of a handshake, and the context both sides named (`relay_host_id` is "" for a direct connection).
struct TranscriptParts<'a> {
    client_public_key: &'a [u8; 32],
    client_nonce: &'a [u8; 32],
    desktop_public_key: &'a [u8; 32],
    desktop_nonce: &'a [u8; 32],
    transport: &'a str,
    relay_host_id: &'a str,
}

/// `encodeMobileE2EEV2Transcript`: named, length-prefixed fields of the hello and then the ready.
fn transcript(p: &TranscriptParts) -> Vec<u8> {
    let framing = [uint32(1), uint32(2)].concat();
    let kinds = string_list(&["text", "binary"]);
    let context = |side: &str| -> Vec<u8> {
        [
            field(&format!("{side}.context.protocol"), PROTOCOL.as_bytes()),
            field(&format!("{side}.context.initiator"), b"mobile"),
            field(&format!("{side}.context.responder"), b"desktop"),
            field(&format!("{side}.context.transport"), p.transport.as_bytes()),
            field(
                &format!("{side}.context.relay-host-id"),
                p.relay_host_id.as_bytes(),
            ),
        ]
        .concat()
    };
    [
        field("domain", TRANSCRIPT_DOMAIN.as_bytes()),
        field("mobile-to-desktop.type", b"e2ee_hello"),
        field("mobile-to-desktop.version", &uint32(2)),
        field("mobile-to-desktop.client-public-key", p.client_public_key),
        field("mobile-to-desktop.client-nonce", p.client_nonce),
        field("mobile-to-desktop.capabilities.framing", &framing),
        field("mobile-to-desktop.capabilities.payload-kinds", &kinds),
        context("mobile-to-desktop"),
        field("desktop-to-mobile.type", b"e2ee_ready"),
        field("desktop-to-mobile.version", &uint32(2)),
        field("desktop-to-mobile.desktop-public-key", p.desktop_public_key),
        field("desktop-to-mobile.client-nonce-echo", p.client_nonce),
        field("desktop-to-mobile.desktop-nonce", p.desktop_nonce),
        field("desktop-to-mobile.selection.framing", &uint32(2)),
        field("desktop-to-mobile.selection.payload-kinds", &kinds),
        context("desktop-to-mobile"),
    ]
    .concat()
}

fn nonce_of(session_id: &[u8; 32], direction: Direction, kind: Kind, counter: u64) -> [u8; 24] {
    let mut nonce = [0u8; NONCE_LENGTH];
    nonce[..12].copy_from_slice(&session_id[..12]);
    nonce[12] = FRAME_VERSION;
    nonce[13] = direction as u8;
    nonce[14] = kind as u8;
    nonce[16..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

fn header_of(
    session_id: &[u8; 32],
    direction: Direction,
    kind: Kind,
    counter: u64,
) -> [u8; HEADER_LENGTH] {
    let mut header = [0u8; HEADER_LENGTH];
    header[..SESSION_ID_LENGTH].copy_from_slice(session_id);
    header[SESSION_ID_LENGTH] = direction as u8;
    header[SESSION_ID_LENGTH + 1] = kind as u8;
    header[SESSION_ID_LENGTH + 2..].copy_from_slice(&counter.to_be_bytes());
    header
}

/// A frame: the nonce, then the secretbox (tag first) of the header and the payload.
fn seal_frame(
    key: &[u8; 32],
    session_id: &[u8; 32],
    direction: Direction,
    kind: Kind,
    counter: u64,
    payload: &[u8],
) -> Vec<u8> {
    let nonce = nonce_of(session_id, direction, kind, counter);
    let mut buffer = Vec::with_capacity(TAG_LENGTH + HEADER_LENGTH + payload.len());
    buffer.extend([0u8; TAG_LENGTH]);
    buffer.extend(header_of(session_id, direction, kind, counter));
    buffer.extend(payload);
    let tag = XSalsa20Poly1305::new(Key::from_slice(key))
        .encrypt_in_place_detached(Nonce::from_slice(&nonce), b"", &mut buffer[TAG_LENGTH..])
        .expect("a secretbox seals any length");
    buffer[..TAG_LENGTH].copy_from_slice(&tag);
    [&nonce[..], &buffer].concat()
}

/// The payload of `frame` if it is the frame of exactly this direction, kind and counter; `None` for anything else, including a box that fails its tag.
fn open_frame(
    key: &[u8; 32],
    session_id: &[u8; 32],
    direction: Direction,
    kind: Kind,
    expected_counter: u64,
    frame: &[u8],
) -> Option<Vec<u8>> {
    if frame.len() < NONCE_LENGTH + TAG_LENGTH + HEADER_LENGTH {
        return None;
    }
    let nonce = nonce_of(session_id, direction, kind, expected_counter);
    if !equal(&frame[..NONCE_LENGTH], &nonce) {
        return None;
    }
    let (tag, body) = frame[NONCE_LENGTH..].split_at(TAG_LENGTH);
    let mut plaintext = body.to_vec();
    XSalsa20Poly1305::new(Key::from_slice(key))
        .decrypt_in_place_detached(
            Nonce::from_slice(&nonce),
            b"",
            &mut plaintext,
            GenericArray::from_slice(tag),
        )
        .ok()?;
    let header = header_of(session_id, direction, kind, expected_counter);
    if !equal(&plaintext[..HEADER_LENGTH], &header) {
        return None;
    }
    Some(plaintext.split_off(HEADER_LENGTH))
}

fn equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len() && left.iter().zip(right).fold(0, |d, (l, r)| d | (l ^ r)) == 0
}

// ---- the handshake ----

/// The client's half before the ready: its key pair and nonce, and the desktop key the connection is pinned to.
pub struct Handshake {
    secret_key: [u8; 32],
    public_key: [u8; 32],
    nonce: [u8; 32],
    pinned_desktop_key: [u8; 32],
}

fn is_exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}

fn is_two(value: &Value) -> bool {
    value.as_f64() == Some(2.0)
}

/// The context both hello and ready name on a direct connection.
fn is_direct_context(value: &Value) -> bool {
    is_exact(value, &["protocol", "initiator", "responder", "transport"])
        && value["protocol"] == PROTOCOL
        && value["initiator"] == "mobile"
        && value["responder"] == "desktop"
        && value["transport"] == "direct"
}

fn is_selection(value: &Value) -> bool {
    is_exact(value, &["framing", "payloadKinds"])
        && is_two(&value["framing"])
        && value["payloadKinds"] == json!(["text", "binary"])
}

impl Handshake {
    /// A fresh key pair and nonce for the desktop key `desktop_public_key_b64` (the one pinned in the pairing).
    pub fn new(desktop_public_key_b64: &str) -> Result<Self, &'static str> {
        let mut random = [0u8; 64];
        getrandom::fill(&mut random).map_err(|_| "乱数を作れません")?;
        let secret_key: [u8; 32] = random[..32].try_into().unwrap();
        let nonce: [u8; 32] = random[32..].try_into().unwrap();
        Self::with_parts(desktop_public_key_b64, secret_key, nonce)
    }

    fn with_parts(
        desktop_public_key_b64: &str,
        secret_key: [u8; 32],
        nonce: [u8; 32],
    ) -> Result<Self, &'static str> {
        let pinned_desktop_key = STANDARD
            .decode(desktop_public_key_b64)
            .ok()
            .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
            .ok_or("接続先の公開鍵が正しくありません")?;
        Ok(Self {
            public_key: x25519(secret_key, X25519_BASEPOINT_BYTES),
            secret_key,
            nonce,
            pinned_desktop_key,
        })
    }

    /// The first text frame to send, in the clear.
    pub fn hello_text(&self) -> String {
        json!({
            "type": "e2ee_hello",
            "v": 2,
            "clientPublicKeyB64": STANDARD.encode(self.public_key),
            "clientNonceB64": STANDARD.encode(self.nonce),
            "capabilities": {"framing": [2], "payloadKinds": ["text", "binary"]},
            "context": {
                "protocol": PROTOCOL, "initiator": "mobile",
                "responder": "desktop", "transport": "direct",
            },
        })
        .to_string()
    }

    /// Checks the ready as `validateMobileE2EEV2Handshake` does (exact keys, the nonce echoed, the context equal to the hello's), requires the pinned desktop key, and derives the keys.
    pub fn accept_ready(&self, text: &str) -> Result<Channel, &'static str> {
        const REFUSED: &str = "接続先が想定外の応答をしました";
        let ready: Value = serde_json::from_str(text).map_err(|_| REFUSED)?;
        let desktop_key = ready["desktopPublicKeyB64"].as_str().and_then(canonical_32);
        let desktop_nonce = ready["desktopNonceB64"].as_str().and_then(canonical_32);
        let valid = is_exact(
            &ready,
            &[
                "type",
                "v",
                "desktopPublicKeyB64",
                "clientNonceB64",
                "desktopNonceB64",
                "selection",
                "context",
            ],
        ) && ready["type"] == "e2ee_ready"
            && is_two(&ready["v"])
            && is_selection(&ready["selection"])
            && is_direct_context(&ready["context"])
            && ready["clientNonceB64"] == STANDARD.encode(self.nonce);
        let (true, Some(desktop_key), Some(desktop_nonce)) = (valid, desktop_key, desktop_nonce)
        else {
            return Err(REFUSED);
        };
        if !equal(&desktop_key, &self.pinned_desktop_key) {
            return Err("接続先の鍵が登録したものと違います");
        }
        let transcript = transcript(&TranscriptParts {
            client_public_key: &self.public_key,
            client_nonce: &self.nonce,
            desktop_public_key: &desktop_key,
            desktop_nonce: &desktop_nonce,
            transport: "direct",
            relay_host_id: "",
        });
        let shared = box_before(self.secret_key, self.pinned_desktop_key);
        Ok(Channel {
            schedule: key_schedule(&shared, &transcript, &self.nonce, &desktop_nonce),
            inbound: 0,
            outbound: 0,
        })
    }
}

// ---- the sealed channel ----

/// What the auth frame was answered with.
#[derive(Debug, PartialEq)]
pub enum AuthReply {
    Authenticated,
    /// The host refused (or answered something else); `code` is the `error.code` it named.
    Rejected {
        code: Option<String>,
    },
}

/// The keyed connection. The counters are per direction and shared by the text and binary kinds.
pub struct Channel {
    schedule: KeySchedule,
    inbound: u64,
    outbound: u64,
}

impl Channel {
    fn seal(&mut self, kind: Kind, payload: &[u8]) -> Vec<u8> {
        let frame = seal_frame(
            &self.schedule.mobile_to_desktop,
            &self.schedule.session_id,
            Direction::MobileToDesktop,
            kind,
            self.outbound,
            payload,
        );
        self.outbound = self.outbound.saturating_add(1);
        frame
    }

    fn open(&mut self, kind: Kind, frame: &[u8]) -> Option<Vec<u8>> {
        let payload = open_frame(
            &self.schedule.desktop_to_mobile,
            &self.schedule.session_id,
            Direction::DesktopToMobile,
            kind,
            self.inbound,
            frame,
        )?;
        self.inbound = self.inbound.saturating_add(1);
        Some(payload)
    }

    /// A text frame to send: the sealed frame in canonical base64.
    pub fn seal_text(&mut self, text: &str) -> String {
        STANDARD.encode(self.seal(Kind::Text, text.as_bytes()))
    }

    /// The text of an inbound text frame (canonical base64 of a sealed frame); `None` when it does not open.
    pub fn open_text(&mut self, frame_b64: &str) -> Option<String> {
        let frame = STANDARD.decode(frame_b64).ok()?;
        if STANDARD.encode(&frame) != frame_b64 {
            return None;
        }
        String::from_utf8(self.open(Kind::Text, &frame)?).ok()
    }

    /// An inbound binary frame. The payload is of no use here, but the frame must be opened: the inbound counter is shared by both kinds.
    pub fn open_binary(&mut self, frame: &[u8]) -> Option<Vec<u8>> {
        self.open(Kind::Binary, frame)
    }

    /// The token auth frame, sealed: exact keys `type`, `v`, `transcriptHashB64`, `deviceToken`.
    pub fn auth_frame(&mut self, device_token: &str) -> String {
        let text = json!({
            "type": "e2ee_auth",
            "v": 2,
            "transcriptHashB64": STANDARD.encode(self.schedule.transcript_hash),
            "deviceToken": device_token,
        })
        .to_string();
        self.seal_text(&text)
    }

    /// `classifyPairedE2EEV2AuthReply`: authenticated only for the exact reply that echoes this session's transcript hash.
    pub fn auth_reply(&self, plaintext: &str) -> AuthReply {
        let reply: Value = serde_json::from_str(plaintext).unwrap_or(Value::Null);
        let authenticated = is_exact(&reply, &["transcriptHashB64", "type", "v"])
            && reply["type"] == "e2ee_authenticated"
            && is_two(&reply["v"])
            && reply["transcriptHashB64"] == STANDARD.encode(self.schedule.transcript_hash);
        if authenticated {
            AuthReply::Authenticated
        } else {
            AuthReply::Rejected {
                code: reply["error"]["code"].as_str().map(str::to_owned),
            }
        }
    }
}

/// The desktop's half of a handshake, for the tests of the code that talks to Orca over a local socket.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    pub struct Desktop {
        secret_key: [u8; 32],
        schedule: Option<KeySchedule>,
        inbound: u64,
        outbound: u64,
    }

    impl Desktop {
        pub fn new(secret_key: [u8; 32]) -> Self {
            Self {
                secret_key,
                schedule: None,
                inbound: 0,
                outbound: 0,
            }
        }

        pub fn public_key_b64(&self) -> String {
            STANDARD.encode(x25519(self.secret_key, X25519_BASEPOINT_BYTES))
        }

        /// The ready for a client's hello; keys the desktop's side.
        pub fn ready_for(&mut self, hello_text: &str) -> String {
            let hello: Value = serde_json::from_str(hello_text).unwrap();
            let client_key = canonical_32(hello["clientPublicKeyB64"].as_str().unwrap()).unwrap();
            let client_nonce = canonical_32(hello["clientNonceB64"].as_str().unwrap()).unwrap();
            let desktop_key = x25519(self.secret_key, X25519_BASEPOINT_BYTES);
            let desktop_nonce = [6u8; 32];
            let transcript = transcript(&TranscriptParts {
                client_public_key: &client_key,
                client_nonce: &client_nonce,
                desktop_public_key: &desktop_key,
                desktop_nonce: &desktop_nonce,
                transport: "direct",
                relay_host_id: "",
            });
            let shared = box_before(self.secret_key, client_key);
            self.schedule = Some(key_schedule(
                &shared,
                &transcript,
                &client_nonce,
                &desktop_nonce,
            ));
            json!({
                "type": "e2ee_ready", "v": 2,
                "desktopPublicKeyB64": STANDARD.encode(desktop_key),
                "clientNonceB64": STANDARD.encode(client_nonce),
                "desktopNonceB64": STANDARD.encode(desktop_nonce),
                "selection": {"framing": 2, "payloadKinds": ["text", "binary"]},
                "context": {
                    "protocol": "orca-mobile-e2ee", "initiator": "mobile",
                    "responder": "desktop", "transport": "direct",
                },
            })
            .to_string()
        }

        pub fn transcript_hash_b64(&self) -> String {
            STANDARD.encode(self.schedule.as_ref().unwrap().transcript_hash)
        }

        /// The text of a client's frame (canonical base64); `None` when it does not open as the next one.
        pub fn open_text(&mut self, frame_b64: &str) -> Option<String> {
            let schedule = self.schedule.as_ref()?;
            let frame = STANDARD.decode(frame_b64).ok()?;
            let payload = open_frame(
                &schedule.mobile_to_desktop,
                &schedule.session_id,
                Direction::MobileToDesktop,
                Kind::Text,
                self.inbound,
                &frame,
            )?;
            self.inbound += 1;
            String::from_utf8(payload).ok()
        }

        fn seal(&mut self, kind: Kind, payload: &[u8]) -> Vec<u8> {
            let schedule = self.schedule.as_ref().unwrap();
            let frame = seal_frame(
                &schedule.desktop_to_mobile,
                &schedule.session_id,
                Direction::DesktopToMobile,
                kind,
                self.outbound,
                payload,
            );
            self.outbound += 1;
            frame
        }

        pub fn seal_text(&mut self, text: &str) -> String {
            STANDARD.encode(self.seal(Kind::Text, text.as_bytes()))
        }

        pub fn seal_binary(&mut self, payload: &[u8]) -> Vec<u8> {
            self.seal(Kind::Binary, payload)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn unhex(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
            .collect()
    }

    fn key32(text: &str) -> [u8; 32] {
        unhex(text).try_into().unwrap()
    }

    /// `MOBILE_E2EE_V2_VECTOR` of Orca's `mobile-e2ee-v2-fixtures.ts`: a relay context with repeated bytes.
    #[test]
    fn the_transcript_and_the_keys_match_orcas_vector() {
        let relay = "AbCdEf0123_-xyZ9";
        let bytes = transcript(&TranscriptParts {
            client_public_key: &[1; 32],
            client_nonce: &[2; 32],
            desktop_public_key: &[3; 32],
            desktop_nonce: &[4; 32],
            transport: "relay",
            relay_host_id: relay,
        });
        assert_eq!(bytes.len(), 1347);
        let schedule = key_schedule(&[5; 32], &bytes, &[2; 32], &[4; 32]);
        assert_eq!(
            hex(&schedule.transcript_hash),
            "ca6385f8bbf64a223fdd59587bfb67e2373891ce9e6d85ab41df8b7a20a168e3"
        );
        assert_eq!(
            hex(&schedule.mobile_to_desktop),
            "df17ff534df77fd3a30999f4e6200c8fcedefbb15d369301ca62c3cdfea9559a"
        );
        assert_eq!(
            hex(&schedule.desktop_to_mobile),
            "71365fcf8212a6d63caf909ee28de3c8f689682ef298a374136055e0ab1cde4a"
        );
        assert_eq!(
            hex(&schedule.session_id),
            "339ae1f2bdff63481857d2813c2f19dd1f5aa4824705d5e5daeb25dae7b9196e"
        );
    }

    #[test]
    fn box_before_matches_the_nacl_vector() {
        let alice_secret =
            key32("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
        let bob_public = key32("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
        assert_eq!(
            hex(&box_before(alice_secret, bob_public)),
            "1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389"
        );
    }

    const KEY: [u8; 32] = [7; 32];

    fn session_id() -> [u8; 32] {
        std::array::from_fn(|i| u8::try_from(i).unwrap())
    }

    // Generated with tweetnacl 1.x (`nacl.secretbox`) over the same layout as `sealMobileE2EEV2Frame`.
    const TEXT_D2M_3: &str = "000102030405060708090a0b02010000000000000000000317627b13f584248ae01e4bc929a756221e0d6045ef24e2056ce6a9557f5640729c09083de80279c0602a073dbcf55a200337d395a9cb1bd454339d370b08553746800fc1";
    const BINARY_D2M_0: &str = "000102030405060708090a0b020101000000000000000000cb48cebe921cf86bb6ed7f5bf8a4fadb7850e62b05c418585118f3978b85e0f27f1e2fe7c7b37223727eff7273d80cc2aea1b76bf851d1b59d9eab82ce";
    const TEXT_M2D_0: &str = "000102030405060708090a0b02000000000000000000000077a9cabfaa6cbe0f176e5ddba2f5811b9b982119ab455cc8825fba72ac96584e64c310589135160a758c2b7426f541eacc1007ce862bedf705a6d53c30566af9f0";

    #[test]
    fn a_frame_matches_the_tweetnacl_vector() {
        let sid = session_id();
        let seal = |dir, kind, counter, payload: &[u8]| {
            hex(&seal_frame(&KEY, &sid, dir, kind, counter, payload))
        };
        assert_eq!(
            seal(Direction::DesktopToMobile, Kind::Text, 3, b"hello orca"),
            TEXT_D2M_3
        );
        assert_eq!(
            seal(Direction::DesktopToMobile, Kind::Binary, 0, &[1, 2, 3]),
            BINARY_D2M_0
        );
        assert_eq!(
            seal(Direction::MobileToDesktop, Kind::Text, 0, b"{\"a\":1}"),
            TEXT_M2D_0
        );
        // And the other way: tweetnacl's frames open.
        let open = |dir, kind, counter, frame: &str| {
            open_frame(&KEY, &sid, dir, kind, counter, &unhex(frame))
        };
        assert_eq!(
            open(Direction::DesktopToMobile, Kind::Text, 3, TEXT_D2M_3).unwrap(),
            b"hello orca"
        );
        assert_eq!(
            open(Direction::MobileToDesktop, Kind::Text, 0, TEXT_M2D_0).unwrap(),
            b"{\"a\":1}"
        );
    }

    #[test]
    fn a_frame_opens_only_as_what_it_was_sealed_for() {
        let sid = session_id();
        let frame = seal_frame(
            &KEY,
            &sid,
            Direction::DesktopToMobile,
            Kind::Text,
            5,
            b"payload",
        );
        let open = |key: &[u8; 32], sid: &[u8; 32], dir, kind, counter, frame: &[u8]| {
            open_frame(key, sid, dir, kind, counter, frame)
        };
        assert_eq!(
            open(
                &KEY,
                &sid,
                Direction::DesktopToMobile,
                Kind::Text,
                5,
                &frame
            )
            .unwrap(),
            b"payload"
        );
        // A wrong counter, direction or kind, key or session.
        assert!(open(
            &KEY,
            &sid,
            Direction::DesktopToMobile,
            Kind::Text,
            4,
            &frame
        )
        .is_none());
        assert!(open(
            &KEY,
            &sid,
            Direction::DesktopToMobile,
            Kind::Text,
            6,
            &frame
        )
        .is_none());
        assert!(open(
            &KEY,
            &sid,
            Direction::MobileToDesktop,
            Kind::Text,
            5,
            &frame
        )
        .is_none());
        assert!(open(
            &KEY,
            &sid,
            Direction::DesktopToMobile,
            Kind::Binary,
            5,
            &frame
        )
        .is_none());
        assert!(open(
            &[8; 32],
            &sid,
            Direction::DesktopToMobile,
            Kind::Text,
            5,
            &frame
        )
        .is_none());
        assert!(open(
            &KEY,
            &[9; 32],
            Direction::DesktopToMobile,
            Kind::Text,
            5,
            &frame
        )
        .is_none());
        // A flipped bit anywhere, and a frame too short to hold a box.
        for at in [0, 12, 24, 30, frame.len() - 1] {
            let mut bad = frame.clone();
            bad[at] ^= 1;
            assert!(
                open(&KEY, &sid, Direction::DesktopToMobile, Kind::Text, 5, &bad).is_none(),
                "{at}"
            );
        }
        for len in [0, 23, 24, 82, 88] {
            assert!(open(
                &KEY,
                &sid,
                Direction::DesktopToMobile,
                Kind::Text,
                5,
                &frame[..len.min(frame.len())]
            )
            .is_none());
        }
        // An empty payload is a frame like any other.
        let empty = seal_frame(&KEY, &sid, Direction::DesktopToMobile, Kind::Text, 0, b"");
        assert_eq!(empty.len(), NONCE_LENGTH + TAG_LENGTH + HEADER_LENGTH);
        assert_eq!(
            open(
                &KEY,
                &sid,
                Direction::DesktopToMobile,
                Kind::Text,
                0,
                &empty
            )
            .unwrap(),
            b""
        );
    }

    /// A client and the desktop's half of a handshake, built from fixed secrets.
    struct Pair {
        client: Handshake,
        desktop_secret: [u8; 32],
        desktop_nonce: [u8; 32],
    }

    fn pair() -> Pair {
        let desktop_secret = [11; 32];
        let desktop_public = x25519(desktop_secret, X25519_BASEPOINT_BYTES);
        Pair {
            client: Handshake::with_parts(&STANDARD.encode(desktop_public), [3; 32], [4; 32])
                .unwrap(),
            desktop_secret,
            desktop_nonce: [5; 32],
        }
    }

    impl Pair {
        fn ready(&self) -> Value {
            json!({
                "type": "e2ee_ready", "v": 2,
                "desktopPublicKeyB64": STANDARD.encode(x25519(self.desktop_secret, X25519_BASEPOINT_BYTES)),
                "clientNonceB64": STANDARD.encode(self.client.nonce),
                "desktopNonceB64": STANDARD.encode(self.desktop_nonce),
                "selection": {"framing": 2, "payloadKinds": ["text", "binary"]},
                "context": {
                    "protocol": "orca-mobile-e2ee", "initiator": "mobile",
                    "responder": "desktop", "transport": "direct",
                },
            })
        }

        /// The desktop derives its keys from its own secret and the client's public key, as Orca does.
        fn desktop_schedule(&self) -> KeySchedule {
            let desktop_public = x25519(self.desktop_secret, X25519_BASEPOINT_BYTES);
            let transcript = transcript(&TranscriptParts {
                client_public_key: &self.client.public_key,
                client_nonce: &self.client.nonce,
                desktop_public_key: &desktop_public,
                desktop_nonce: &self.desktop_nonce,
                transport: "direct",
                relay_host_id: "",
            });
            let shared = box_before(self.desktop_secret, self.client.public_key);
            key_schedule(
                &shared,
                &transcript,
                &self.client.nonce,
                &self.desktop_nonce,
            )
        }
    }

    #[test]
    fn the_hello_is_the_one_orca_expects() {
        let hello: Value = serde_json::from_str(&pair().client.hello_text()).unwrap();
        assert!(is_exact(
            &hello,
            &[
                "type",
                "v",
                "clientPublicKeyB64",
                "clientNonceB64",
                "capabilities",
                "context"
            ]
        ));
        assert_eq!(hello["type"], "e2ee_hello");
        assert_eq!(hello["v"], 2);
        assert_eq!(hello["capabilities"]["framing"], json!([2]));
        assert_eq!(
            hello["capabilities"]["payloadKinds"],
            json!(["text", "binary"])
        );
        assert!(is_direct_context(&hello["context"]));
        assert_eq!(
            canonical_32(hello["clientPublicKeyB64"].as_str().unwrap()),
            Some(pair().client.public_key)
        );
        assert_eq!(
            canonical_32(hello["clientNonceB64"].as_str().unwrap()),
            Some([4; 32])
        );
    }

    #[test]
    fn both_sides_agree_on_the_keys_and_frames_pass_both_ways() {
        let p = pair();
        let mut channel = p.client.accept_ready(&p.ready().to_string()).unwrap();
        let desktop = p.desktop_schedule();
        assert_eq!(channel.schedule.session_id, desktop.session_id);
        assert_eq!(channel.schedule.transcript_hash, desktop.transcript_hash);
        // The client's auth frame opens on the desktop's side with the client-to-desktop key.
        let frame = STANDARD.decode(channel.auth_frame("secret-token")).unwrap();
        let auth = open_frame(
            &desktop.mobile_to_desktop,
            &desktop.session_id,
            Direction::MobileToDesktop,
            Kind::Text,
            0,
            &frame,
        )
        .unwrap();
        let auth: Value = serde_json::from_slice(&auth).unwrap();
        assert!(is_exact(
            &auth,
            &["type", "v", "transcriptHashB64", "deviceToken"]
        ));
        assert_eq!(auth["type"], "e2ee_auth");
        assert_eq!(auth["deviceToken"], "secret-token");
        assert_eq!(
            auth["transcriptHashB64"],
            STANDARD.encode(desktop.transcript_hash)
        );
        // The second text frame uses the next counter.
        let next = STANDARD
            .decode(channel.seal_text("{\"id\":\"1\"}"))
            .unwrap();
        assert!(open_frame(
            &desktop.mobile_to_desktop,
            &desktop.session_id,
            Direction::MobileToDesktop,
            Kind::Text,
            1,
            &next
        )
        .is_some());
        // The desktop's reply opens on the client.
        let reply = json!({
            "type": "e2ee_authenticated", "v": 2,
            "transcriptHashB64": STANDARD.encode(desktop.transcript_hash),
        })
        .to_string();
        let sealed = seal_frame(
            &desktop.desktop_to_mobile,
            &desktop.session_id,
            Direction::DesktopToMobile,
            Kind::Text,
            0,
            reply.as_bytes(),
        );
        let opened = channel.open_text(&STANDARD.encode(sealed)).unwrap();
        assert_eq!(channel.auth_reply(&opened), AuthReply::Authenticated);
    }

    #[test]
    fn a_ready_that_is_not_exactly_the_expected_one_is_refused() {
        let p = pair();
        let with = |edit: &dyn Fn(&mut Value)| {
            let mut ready = p.ready();
            edit(&mut ready);
            p.client.accept_ready(&ready.to_string()).is_err()
        };
        assert!(!with(&|_| {}));
        assert!(with(&|r| r["extra"] = json!(1)));
        assert!(with(&|r| {
            r.as_object_mut().unwrap().remove("selection");
        }));
        assert!(with(&|r| r["type"] = json!("e2ee_hello")));
        assert!(with(&|r| r["v"] = json!(1)));
        assert!(with(&|r| r["selection"]["framing"] = json!(1)));
        assert!(with(
            &|r| r["selection"]["payloadKinds"] = json!(["binary", "text"])
        ));
        assert!(with(&|r| r["context"]["transport"] = json!("relay")));
        assert!(with(&|r| r["context"]["initiator"] = json!("desktop")));
        assert!(with(
            &|r| r["context"]["relayHostId"] = json!("AbCdEf0123_-xyZ9")
        ));
        assert!(with(
            &|r| r["clientNonceB64"] = json!(STANDARD.encode([9; 32]))
        ));
        assert!(with(&|r| r["desktopNonceB64"] = json!("AAAA")));
        // A spelling that is not canonical (a trailing bit set in the last character).
        let nonce = STANDARD.encode([5; 32]);
        assert!(with(
            &|r| r["desktopNonceB64"] = json!(nonce.replace("BQU=", "BQV="))
        ));
        assert!(p.client.accept_ready("not json").is_err());
        assert!(p.client.accept_ready("[]").is_err());
    }

    #[test]
    fn a_ready_with_another_desktop_key_is_refused() {
        let p = pair();
        let mut ready = p.ready();
        ready["desktopPublicKeyB64"] =
            json!(STANDARD.encode(x25519([12; 32], X25519_BASEPOINT_BYTES)));
        let error = p.client.accept_ready(&ready.to_string()).err().unwrap();
        assert!(error.contains("鍵"));
    }

    #[test]
    fn the_pinned_key_must_be_32_bytes_of_base64() {
        for bad in ["", "AAAA", "not base64!", &STANDARD.encode([1; 31])] {
            assert!(
                Handshake::with_parts(bad, [1; 32], [2; 32]).is_err(),
                "{bad}"
            );
        }
        assert!(Handshake::new(&STANDARD.encode([1; 32])).is_ok());
    }

    fn channel() -> (Channel, KeySchedule) {
        let p = pair();
        (
            p.client.accept_ready(&p.ready().to_string()).unwrap(),
            p.desktop_schedule(),
        )
    }

    fn from_desktop(desktop: &KeySchedule, kind: Kind, counter: u64, payload: &[u8]) -> Vec<u8> {
        seal_frame(
            &desktop.desktop_to_mobile,
            &desktop.session_id,
            Direction::DesktopToMobile,
            kind,
            counter,
            payload,
        )
    }

    #[test]
    fn a_binary_frame_moves_the_counter_both_kinds_share() {
        let (mut channel, desktop) = channel();
        // Counter 0 is a binary frame, 1 a text frame: the text frame opens only after the binary one was.
        let text = STANDARD.encode(from_desktop(&desktop, Kind::Text, 1, b"after"));
        assert!(channel.open_text(&text).is_none());
        let binary = from_desktop(&desktop, Kind::Binary, 0, &[1, 2, 3]);
        assert_eq!(channel.open_binary(&binary).unwrap(), [1, 2, 3]);
        assert_eq!(channel.open_text(&text).unwrap(), "after");
        // A frame is opened once: the same one again is behind the counter.
        assert!(channel.open_text(&text).is_none());
    }

    #[test]
    fn an_inbound_text_must_be_canonical_base64_that_opens() {
        let (mut channel, desktop) = channel();
        let frame = from_desktop(&desktop, Kind::Text, 0, b"hi!");
        let encoded = STANDARD.encode(&frame);
        for bad in [
            format!(" {encoded}"),
            format!("{encoded}\n"),
            encoded.trim_end_matches('=').to_owned(),
            "!!!!".to_owned(),
            String::new(),
        ] {
            assert!(channel.open_text(&bad).is_none(), "{bad}");
        }
        // A failure moves nothing: the frame still opens.
        assert_eq!(channel.open_text(&encoded).unwrap(), "hi!");
        // A binary frame is not a text frame.
        let binary = STANDARD.encode(from_desktop(&desktop, Kind::Binary, 1, b"x"));
        assert!(channel.open_text(&binary).is_none());
    }

    #[test]
    fn only_the_exact_authenticated_reply_authenticates() {
        let (channel, desktop) = channel();
        let hash = STANDARD.encode(desktop.transcript_hash);
        let ok = json!({"type": "e2ee_authenticated", "v": 2, "transcriptHashB64": hash});
        assert!(channel.auth_reply(&ok.to_string()) == AuthReply::Authenticated);
        let mut extra = ok.clone();
        extra["more"] = json!(1);
        let mut other_hash = ok.clone();
        other_hash["transcriptHashB64"] = json!(STANDARD.encode([0; 32]));
        let mut old = ok.clone();
        old["v"] = json!(1);
        for bad in [
            extra,
            other_hash,
            old,
            json!({"type": "e2ee_authenticated"}),
        ] {
            assert!(
                channel.auth_reply(&bad.to_string()) != AuthReply::Authenticated,
                "{bad}"
            );
        }
        let refused = json!({"type": "error", "error": {"code": "unauthorized", "message": "x"}});
        assert!(
            channel.auth_reply(&refused.to_string())
                == AuthReply::Rejected {
                    code: Some("unauthorized".into())
                }
        );
        assert!(channel.auth_reply("junk") == AuthReply::Rejected { code: None });
    }
}
