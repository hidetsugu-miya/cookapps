//! Images in HTML mail: `cid:` references to the message's own parts, and external images fetched on request.

use std::{
    collections::{HashMap, HashSet},
    future::Future,
    net::{IpAddr, Ipv4Addr},
    sync::OnceLock,
    time::Duration,
};

use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use reqwest::{header::CONTENT_TYPE, redirect, Url};
use tokio::task::JoinSet;

const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 20 * 1024 * 1024;
/// URLs fetched per request, and how many are in flight at once (each can hold up to `MAX_IMAGE_BYTES`).
const MAX_FETCHES: usize = 50;
pub(crate) const CONCURRENCY: usize = 6;
/// `cid:` images inlined per thread.
pub(crate) const MAX_INLINE_IMAGES: usize = 50;
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_REDIRECTS: usize = 5;

/// `image/png` and the like, lowercased, without parameters. `None` for anything else: the value ends up inside a data: URI.
pub(crate) fn image_mime(value: &str) -> Option<String> {
    let mime = value.split(';').next()?.trim().to_ascii_lowercase();
    let subtype = mime.strip_prefix("image/")?;
    (!subtype.is_empty()
        && subtype
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)))
    .then_some(mime)
}

/// Counts an image of `size` bytes into `total` when it is within the per-image and the total limit.
fn admit(total: &mut u64, size: u64) -> bool {
    let fits = size <= MAX_IMAGE_BYTES && *total + size <= MAX_TOTAL_BYTES;
    if fits {
        *total += size;
    }
    fits
}

fn data_uri(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", STANDARD.encode(bytes))
}

/// The data: URI of Gmail's base64url `data`. `None` when it is not valid base64 or is over the per-image limit.
pub(crate) fn inline_data_uri(mime: &str, data: &str) -> Option<String> {
    let bytes = URL_SAFE_NO_PAD.decode(data.trim_end_matches('=')).ok()?;
    (bytes.len() as u64 <= MAX_IMAGE_BYTES).then(|| data_uri(mime, &bytes))
}

/// An image part of a message that a `cid:` reference can point at, borrowing from the message.
#[derive(Debug, PartialEq)]
pub(crate) struct InlineImage<'a> {
    /// Content-ID without the angle brackets.
    pub cid: &'a str,
    /// Already checked by `image_mime`.
    pub mime: String,
    pub size: u64,
    /// Set when the data is not in the part itself and `messages.attachments.get` must fetch it.
    pub attachment_id: &'a str,
    /// base64url data of the part, empty with an `attachment_id`.
    pub data: &'a str,
}

/// `%40` becomes `@`. A `%` not followed by two hex digits stays as it is.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let (mut out, mut i) = (Vec::with_capacity(bytes.len()), 0);
    while i < bytes.len() {
        let hex = bytes
            .get(i + 1..i + 3)
            .filter(|h| h.iter().all(u8::is_ascii_hexdigit));
        match (bytes[i], hex) {
            (b'%', Some(h)) => {
                // Both bytes are ASCII hex digits, so this is valid UTF-8 and parses.
                out.push(u8::from_str_radix(std::str::from_utf8(h).unwrap(), 16).unwrap());
                i += 3;
            }
            (c, _) => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Every `cid:{id}` in `html` as (start, end, id). The id ends at a quote, `)`, `<`, `>`, a backslash, or whitespace.
/// The id is percent-decoded: HTML may write `cid:foo%40bar` for the Content-ID `foo@bar`.
fn cid_refs(html: &str) -> Vec<(usize, usize, String)> {
    // ASCII lowercasing keeps byte offsets, so positions found here index `html` too.
    let lower = html.to_ascii_lowercase();
    let mut refs = Vec::new();
    let mut from = 0;
    while let Some(i) = lower[from..].find("cid:") {
        let start = from + i;
        let id_start = start + 4;
        let end = html[id_start..]
            .find(|c: char| "\"')<>\\".contains(c) || c.is_whitespace())
            .map_or(html.len(), |n| id_start + n);
        if end > id_start {
            refs.push((start, end, percent_decode(&html[id_start..end])));
        }
        from = end;
    }
    refs
}

/// The images `html` refers to by `cid:` and that may be inlined: each once, in order, at most `max`,
/// within the size limits. `total` counts the bytes already taken, so one budget can span a whole thread.
/// An image over a limit is left out and its reference stays as it is.
pub(crate) fn wanted_images<'a, 'b>(
    html: &str,
    images: &'b [InlineImage<'a>],
    total: &mut u64,
    max: usize,
) -> Vec<&'b InlineImage<'a>> {
    let referred: HashSet<String> = cid_refs(html).into_iter().map(|r| r.2).collect();
    let mut seen = HashSet::new();
    images
        .iter()
        .filter(|i| {
            referred.contains(i.cid)
                && !(i.data.is_empty() && i.attachment_id.is_empty())
                && seen.insert(i.cid)
                && admit(total, i.size)
        })
        .take(max)
        .collect()
}

/// Replaces each `cid:{id}` that has a URI in `uris` (by id); the others stay.
pub(crate) fn replace_cids(html: &str, uris: &HashMap<String, String>) -> String {
    let mut out = String::with_capacity(html.len());
    let mut at = 0;
    for (start, end, id) in cid_refs(html) {
        if let Some(uri) = uris.get(&id) {
            out.push_str(&html[at..start]);
            out.push_str(uri);
            at = end;
        }
    }
    out.push_str(&html[at..]);
    out
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || a == 0 // 0.0.0.0/8
        || a == 100 && b & 0xc0 == 64 // 100.64.0.0/10 shared address space
        || a == 198 && b & 0xfe == 18 // 198.18.0.0/15 benchmarking
        || a >= 240) // 240.0.0.0/4 reserved
}

fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_v4(ip),
        IpAddr::V6(ip) => {
            let s = ip.segments();
            let first = s[0];
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || first & 0xfe00 == 0xfc00 // unique local
                || first & 0xffc0 == 0xfe80 // link local
                || first & 0xffc0 == 0xfec0 // site local
                || s[..2] == [0x64, 0xff9b] && s[2..6] == [0; 4]) // 64:ff9b::/96 NAT64 reaches any IPv4
                // IPv4-mapped and IPv4-compatible addresses are the IPv4 address inside.
                && ip.to_ipv4().is_none_or(is_public_v4)
        }
    }
}

/// Whether an external image may be fetched: https on the default port, no credentials,
/// and a host that is not this machine or the local network.
// shortcut: only host names and IP literals are checked, not what a name resolves to; upgrade with a resolving connector.
fn fetchable(url: &Url) -> bool {
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return false;
    }
    // `localhost.` is the same host as `localhost`.
    let Some(host) = url.host_str().map(|h| h.trim_end_matches('.')) else {
        return false;
    };
    if let Ok(ip) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
        return is_public(ip);
    }
    let host = host.to_ascii_lowercase();
    host.contains('.') && !host.ends_with(".local") && !host.ends_with(".localhost")
}

/// The MIME type of a response worth reading: an image whose declared length is within the limit.
fn response_mime(content_type: Option<&str>, content_length: Option<u64>) -> Option<String> {
    if content_length.is_some_and(|n| n > MAX_IMAGE_BYTES) {
        return None;
    }
    image_mime(content_type?)
}

/// `(url, mime, bytes)`, or `None` for anything that is not a small image fetched over https.
async fn fetch_image(http: reqwest::Client, url: String) -> Option<(String, String, Vec<u8>)> {
    let parsed = Url::parse(&url).ok().filter(fetchable)?;
    let mut res = http
        .get(parsed)
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?;
    let mime = response_mime(
        res.headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        res.content_length(),
    )?;
    let mut bytes = Vec::new();
    while let Some(chunk) = res.chunk().await.ok()? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return None;
        }
    }
    Some((url, mime, bytes))
}

/// Runs the futures with at most `limit` in flight, each finishing one letting the next start.
/// Results come in the order they finish; a panicked task is dropped.
pub(crate) async fn run_limited<T, F>(jobs: impl IntoIterator<Item = F>, limit: usize) -> Vec<T>
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    let mut jobs = jobs.into_iter();
    let (mut set, mut out) = (JoinSet::new(), Vec::new());
    loop {
        while set.len() < limit {
            let Some(job) = jobs.next() else { break };
            set.spawn(job);
        }
        let Some(done) = set.join_next().await else {
            return out;
        };
        out.extend(done);
    }
}

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            // A redirect must not lead away from https or to the local network.
            .redirect(redirect::Policy::custom(|attempt| {
                if attempt.previous().len() < MAX_REDIRECTS && fetchable(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .expect("reqwest client")
    })
}

/// Fetches the images at `urls` and returns their data: URIs by URL. An image that cannot be fetched is left out.
#[tauri::command]
pub async fn fetch_images(urls: Vec<String>) -> Result<HashMap<String, String>, String> {
    let mut seen = HashSet::new();
    let urls: Vec<_> = urls
        .into_iter()
        .filter(|u| seen.insert(u.clone()))
        .take(MAX_FETCHES)
        .collect();
    let jobs = urls
        .into_iter()
        .map(|url| fetch_image(http_client().clone(), url));
    let (mut total, mut out) = (0, HashMap::new());
    for (url, mime, bytes) in run_limited(jobs, CONCURRENCY).await.into_iter().flatten() {
        if admit(&mut total, bytes.len() as u64) {
            out.insert(url, data_uri(&mime, &bytes));
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn image(cid: &str, size: u64) -> InlineImage<'_> {
        InlineImage {
            cid,
            mime: "image/png".into(),
            size,
            attachment_id: "att",
            data: "",
        }
    }

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn image_mime_accepts_only_image_types_and_drops_parameters() {
        assert_eq!(image_mime("image/PNG"), Some("image/png".into()));
        assert_eq!(
            image_mime("image/svg+xml; charset=utf-8"),
            Some("image/svg+xml".into())
        );
        assert_eq!(image_mime("text/html"), None);
        assert_eq!(image_mime("image/"), None);
        assert_eq!(image_mime("image/png,text/html"), None);
        assert_eq!(image_mime("image/a b"), None);
    }

    #[test]
    fn admit_enforces_the_image_and_the_total_limit() {
        let mut total = 0;
        assert!(admit(&mut total, MAX_IMAGE_BYTES));
        assert!(!admit(&mut total, MAX_IMAGE_BYTES + 1));
        assert_eq!(total, MAX_IMAGE_BYTES);
        for _ in 0..3 {
            assert!(admit(&mut total, MAX_IMAGE_BYTES));
        }
        assert_eq!(total, MAX_TOTAL_BYTES);
        // The total is full, so even one byte is refused, and a refusal counts nothing.
        assert!(!admit(&mut total, 1));
        assert_eq!(total, MAX_TOTAL_BYTES);
    }

    #[test]
    fn inline_data_uri_converts_base64url_to_base64() {
        // 0xfb 0xff is "-_8" in base64url and "+/8=" in base64.
        assert_eq!(
            inline_data_uri("image/png", "-_8"),
            Some("data:image/png;base64,+/8=".into())
        );
        assert_eq!(
            inline_data_uri("image/png", "-_8="),
            inline_data_uri("image/png", "-_8")
        );
        assert_eq!(inline_data_uri("image/png", "***"), None);
    }

    #[test]
    fn inline_data_uri_refuses_data_over_the_image_limit() {
        let big = URL_SAFE_NO_PAD.encode(vec![0u8; MAX_IMAGE_BYTES as usize + 1]);
        assert_eq!(inline_data_uri("image/png", &big), None);
        let ok = URL_SAFE_NO_PAD.encode(vec![0u8; MAX_IMAGE_BYTES as usize]);
        assert!(inline_data_uri("image/png", &ok).is_some());
    }

    #[test]
    fn cid_refs_finds_attributes_css_and_any_case() {
        let html =
            r#"<img src="cid:a@x"><img src='CID:b'><div style="background:url(cid:c)">cid:d e"#;
        let ids: Vec<_> = cid_refs(html).into_iter().map(|r| r.2).collect();
        assert_eq!(ids, ["a@x", "b", "c", "d"]);
        // HTML may percent-encode the Content-ID; a stray % stays.
        let ids: Vec<_> = cid_refs(r#"cid:foo%40bar cid:50% cid:%zz cid:a%E3%81%82"#)
            .into_iter()
            .map(|r| r.2)
            .collect();
        assert_eq!(ids, ["foo@bar", "50%", "%zz", "aあ"]);
        assert!(cid_refs("<p>no refs, cid: alone</p>").is_empty());
    }

    #[test]
    fn replace_cids_swaps_known_ids_whole_and_keeps_the_rest() {
        let uris = HashMap::from([
            ("a".to_owned(), "data:A".to_owned()),
            ("x@y".to_owned(), "data:X".to_owned()),
        ]);
        // `cid:ab` must not be touched by the id `a`.
        let html =
            r#"<img src="cid:a"> <img src="cid:ab"> <img src="cid:a"> <img src="cid:x%40y">é"#;
        assert_eq!(
            replace_cids(html, &uris),
            r#"<img src="data:A"> <img src="cid:ab"> <img src="data:A"> <img src="data:X">é"#
        );
    }

    #[test]
    fn wanted_images_takes_referred_images_once_within_the_limits() {
        let images = [
            image("a", 10),
            image("a", 10),
            image("unreferred", 10),
            image("big", MAX_IMAGE_BYTES + 1),
            image("b", 10),
        ];
        let html = r#"<img src="cid:a"><img src="cid:big"><img src="cid:b">"#;
        let cids: Vec<_> = wanted_images(html, &images, &mut 0, usize::MAX)
            .into_iter()
            .map(|i| i.cid)
            .collect();
        assert_eq!(cids, ["a", "b"]);
    }

    #[test]
    fn wanted_images_matches_a_percent_encoded_reference() {
        let images = [image("foo@bar", 10)];
        let got = wanted_images(r#"<img src="cid:foo%40bar">"#, &images, &mut 0, usize::MAX);
        assert_eq!(got.len(), 1);
    }

    #[test]
    fn wanted_images_stops_at_the_count_limit() {
        let names: Vec<_> = (0..MAX_INLINE_IMAGES + 5)
            .map(|n| format!("i{n}"))
            .collect();
        let images: Vec<_> = names.iter().map(|n| image(n, 1)).collect();
        let html: String = names.iter().map(|n| format!("cid:{n} ")).collect();
        let got = wanted_images(&html, &images, &mut 0, MAX_INLINE_IMAGES);
        assert_eq!(got.len(), MAX_INLINE_IMAGES);
        assert_eq!(
            got[MAX_INLINE_IMAGES - 1].cid,
            format!("i{}", MAX_INLINE_IMAGES - 1)
        );
        assert!(wanted_images(&html, &images, &mut 0, 0).is_empty());
    }

    #[test]
    fn wanted_images_shares_the_total_limit_across_calls() {
        let images = [image("a", MAX_IMAGE_BYTES)];
        let mut total = MAX_TOTAL_BYTES - MAX_IMAGE_BYTES + 1;
        // An earlier message used the budget up, so this one gets nothing; a fresh budget would admit it.
        assert!(wanted_images("cid:a", &images, &mut total, usize::MAX).is_empty());
        assert_eq!(wanted_images("cid:a", &images, &mut 0, usize::MAX).len(), 1);
    }

    #[test]
    fn wanted_images_stops_at_the_total_limit_but_keeps_smaller_later_ones() {
        let names: Vec<_> = (0..5).map(|n| format!("i{n}")).collect();
        let mut images: Vec<_> = names.iter().map(|n| image(n, MAX_IMAGE_BYTES)).collect();
        images.push(image("small", 1));
        let html: String = images.iter().map(|i| format!("cid:{} ", i.cid)).collect();
        let cids: Vec<_> = wanted_images(&html, &images, &mut 0, usize::MAX)
            .into_iter()
            .map(|i| i.cid)
            .collect();
        // Four 5 MB images fill the 20 MB; the fifth is left out, the 1-byte one no longer fits either.
        assert_eq!(cids, ["i0", "i1", "i2", "i3"]);
    }

    #[test]
    fn wanted_images_skips_a_part_with_no_data_source() {
        let mut empty = image("a", 10);
        empty.attachment_id = "";
        assert!(wanted_images("cid:a", &[empty], &mut 0, usize::MAX).is_empty());
    }

    #[test]
    fn fetchable_allows_only_public_https_without_port_or_credentials() {
        assert!(fetchable(&url("https://example.com/a.png?x=1")));
        assert!(fetchable(&url("https://93.184.216.34/a.png")));
        assert!(fetchable(&url("https://[2606:2800:220:1::1]/a.png")));
        for refused in [
            "http://example.com/a.png",
            "https://example.com:8443/a.png",
            "https://user:pw@example.com/a.png",
            "https://localhost/a.png",
            "https://app.localhost/a.png",
            "https://printer.local/a.png",
            "https://intranet/a.png",
            "https://127.0.0.1/a.png",
            "https://10.0.0.1/a.png",
            "https://192.168.1.1/a.png",
            "https://169.254.169.254/a.png",
            "https://0.0.0.0/a.png",
            "https://0x7f.1/a.png",
            "https://[::1]/a.png",
            "https://[fd00::1]/a.png",
            "https://[fe80::1]/a.png",
            "https://[::ffff:10.0.0.1]/a.png",
            "https://localhost./a.png",
            "https://printer.local./a.png",
            "https://100.64.0.1/a.png",
            "https://198.18.0.1/a.png",
            "https://224.0.0.1/a.png",
            "https://240.0.0.1/a.png",
            "https://[fec0::1]/a.png",
            "https://[ff02::1]/a.png",
            "https://[::10.0.0.1]/a.png",
            "https://[64:ff9b::a00:1]/a.png",
            "data:image/png;base64,AAAA",
            "file:///etc/passwd",
        ] {
            assert!(!fetchable(&url(refused)), "{refused}");
        }
    }

    #[test]
    fn run_limited_keeps_at_most_the_limit_in_flight_and_runs_them_all() {
        use std::sync::atomic::{AtomicUsize, Ordering::SeqCst};
        static RUNNING: AtomicUsize = AtomicUsize::new(0);
        static PEAK: AtomicUsize = AtomicUsize::new(0);
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let jobs = (0..7).map(|n| async move {
            PEAK.fetch_max(RUNNING.fetch_add(1, SeqCst) + 1, SeqCst);
            for _ in 0..3 {
                tokio::task::yield_now().await;
            }
            RUNNING.fetch_sub(1, SeqCst);
            n
        });
        let mut got = rt.block_on(run_limited(jobs, 3));
        got.sort();
        assert_eq!(got, (0..7).collect::<Vec<_>>());
        assert_eq!(PEAK.load(SeqCst), 3);
    }

    #[test]
    fn response_mime_needs_an_image_within_the_declared_length() {
        assert_eq!(
            response_mime(Some("image/jpeg"), Some(MAX_IMAGE_BYTES)),
            Some("image/jpeg".into())
        );
        assert_eq!(
            response_mime(Some("image/gif"), None),
            Some("image/gif".into())
        );
        assert_eq!(
            response_mime(Some("image/jpeg"), Some(MAX_IMAGE_BYTES + 1)),
            None
        );
        assert_eq!(response_mime(Some("text/html"), Some(10)), None);
        assert_eq!(response_mime(None, Some(10)), None);
    }
}
