//! External images on macOS, fetched with NSURLSession. The guards of `images.rs` hold here too:
//! the URL (`fetchable`), public addresses only, redirects checked, image MIME type, size limits and timeout.
//! The session is ephemeral: no cookies, credentials, cache or proxy.

use std::{
    mem,
    net::SocketAddr,
    sync::{Arc, Mutex, MutexGuard, PoisonError},
};

use block2::DynBlock;
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{NSObject, NSObjectProtocol, ProtocolObject},
    AnyThread, DefinedClass,
};
use objc2_foundation::{
    NSData, NSDictionary, NSError, NSHTTPCookieAcceptPolicy, NSHTTPURLResponse,
    NSMutableURLRequest, NSString, NSURLRequest, NSURLRequestCachePolicy, NSURLResponse,
    NSURLSession, NSURLSessionConfiguration, NSURLSessionDataDelegate, NSURLSessionDataTask,
    NSURLSessionDelegate, NSURLSessionResponseDisposition, NSURLSessionTask,
    NSURLSessionTaskDelegate, NSURL,
};
use reqwest::Url;
use tokio::sync::oneshot;

#[cfg(test)]
use super::MAX_TOTAL_BYTES;
use super::{
    failed, fetchable, is_public, response_mime, Budget, Failed, Fetched, FETCH_TIMEOUT,
    MAX_IMAGE_BYTES, MAX_REDIRECTS,
};

/// Whether `addrs` are all public. An empty list is not: the name did not resolve.
fn all_public(addrs: &[SocketAddr]) -> bool {
    !addrs.is_empty() && addrs.iter().all(|a| is_public(a.ip()))
}

/// Whether the host of `url` resolves, and only to public addresses. Blocks while it resolves.
fn resolves_public(url: &Url) -> bool {
    url.socket_addrs(|| None)
        .is_ok_and(|addrs| all_public(&addrs))
}

/// Whether a redirect to `to`, after `followed` redirects, may be followed. The address check is `resolves_public`.
fn redirect_allowed(followed: usize, to: &Url) -> bool {
    followed < MAX_REDIRECTS && fetchable(to)
}

/// One fetch as NSURLSession reports it, and what is kept of it. The judgments are here, apart from Objective-C.
struct Fetch {
    budget: Arc<Budget>,
    /// Bytes taken from `budget` so far.
    taken: u64,
    redirects: usize,
    status: Option<u16>,
    mime: Option<String>,
    body: Vec<u8>,
    /// Why the fetch was stopped on purpose. NSURLSession then only reports "cancelled".
    stopped: Option<String>,
    done: Option<oneshot::Sender<Result<Fetched, Failed>>>,
}

impl Fetch {
    /// Always `false`, to end `return self.stop(..)`. The first reason stays.
    fn stop(&mut self, why: &str) -> bool {
        self.stopped.get_or_insert_with(|| why.to_owned());
        false
    }

    /// Whether to read the body of the response with `status`, `content_type` and the declared `length`.
    fn response(&mut self, status: u16, content_type: Option<&str>, length: Option<u64>) -> bool {
        self.status = Some(status);
        if !(200..300).contains(&status) {
            return self.stop("unexpected status");
        }
        let Some(mime) = response_mime(content_type, length) else {
            return self.stop("not an image, or over the size limit");
        };
        if length.is_some_and(|n| !self.budget.has(n)) {
            return self.stop("total size limit reached");
        }
        self.mime = Some(mime);
        true
    }

    /// Whether to go on after one more chunk of the body.
    fn data(&mut self, chunk: &[u8]) -> bool {
        let n = chunk.len() as u64;
        if self.body.len() as u64 + n > MAX_IMAGE_BYTES || !self.budget.take(n) {
            return self.stop("body over the size limit");
        }
        self.taken += n;
        self.body.extend_from_slice(chunk);
        true
    }

    /// Hands the result over once. A failed image gives its bytes back to the budget.
    fn finish(&mut self, error: Option<String>) {
        let Some(done) = self.done.take() else { return };
        let result = match (self.stopped.take(), error, self.mime.take()) {
            (Some(why), ..) | (None, Some(why), _) => Err(why),
            (None, None, Some(mime)) => Ok((mime, mem::take(&mut self.body))),
            (None, None, None) => Err("no response".to_owned()),
        };
        if result.is_err() {
            self.budget.give_back(self.taken);
        }
        let _ = done.send(result.map_err(|why| (self.status, why)));
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = Mutex<Fetch>]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl NSURLSessionDelegate for Delegate {}

    unsafe impl NSURLSessionTaskDelegate for Delegate {
        #[unsafe(method(URLSession:task:willPerformHTTPRedirection:newRequest:completionHandler:))]
        fn redirect(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionTask,
            _response: &NSHTTPURLResponse,
            request: &NSURLRequest,
            handler: &DynBlock<dyn Fn(*mut NSURLRequest)>,
        ) {
            let to = request
                .URL()
                .and_then(|u| u.absoluteString())
                .and_then(|u| Url::parse(&u.to_string()).ok());
            let followed = self.fetch().redirects;
            // The name is resolved outside the lock: it can take a while.
            let follow = to
                .as_ref()
                .is_some_and(|to| redirect_allowed(followed, to) && resolves_public(to));
            if follow {
                self.fetch().redirects += 1;
                handler.call((std::ptr::from_ref(request).cast_mut(),));
            } else {
                // The redirect response itself then arrives as the response, and `response` ends the fetch.
                self.fetch().stop("redirect refused");
                handler.call((std::ptr::null_mut(),));
            }
        }

        #[unsafe(method(URLSession:task:didCompleteWithError:))]
        fn complete(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionTask,
            error: Option<&NSError>,
        ) {
            self.fetch()
                .finish(error.map(|e| e.localizedDescription().to_string()));
        }
    }

    unsafe impl NSURLSessionDataDelegate for Delegate {
        #[unsafe(method(URLSession:dataTask:didReceiveResponse:completionHandler:))]
        fn response(
            &self,
            _session: &NSURLSession,
            _task: &NSURLSessionDataTask,
            response: &NSURLResponse,
            handler: &DynBlock<dyn Fn(NSURLSessionResponseDisposition)>,
        ) {
            let go = match response.downcast_ref::<NSHTTPURLResponse>() {
                Some(http) => {
                    let content_type = http
                        .valueForHTTPHeaderField(&NSString::from_str("Content-Type"))
                        .map(|v| v.to_string());
                    // -1 is "unknown".
                    let length = u64::try_from(http.expectedContentLength()).ok();
                    self.fetch().response(
                        http.statusCode().try_into().unwrap_or(0),
                        content_type.as_deref(),
                        length,
                    )
                }
                None => self.fetch().stop("not an HTTP response"),
            };
            handler.call((if go {
                NSURLSessionResponseDisposition::Allow
            } else {
                NSURLSessionResponseDisposition::Cancel
            },));
        }

        #[unsafe(method(URLSession:dataTask:didReceiveData:))]
        fn data(&self, _session: &NSURLSession, task: &NSURLSessionDataTask, data: &NSData) {
            if !self.fetch().data(&data.to_vec()) {
                task.cancel();
            }
        }
    }
);

impl Delegate {
    fn fetch(&self) -> MutexGuard<'_, Fetch> {
        self.ivars().lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Starts the request. The result arrives on the returned channel when NSURLSession is done.
fn start(
    url: &Url,
    budget: Arc<Budget>,
) -> Result<oneshot::Receiver<Result<Fetched, Failed>>, Failed> {
    let ns_url = NSURL::URLWithString(&NSString::from_str(url.as_str()))
        .ok_or_else(|| failed("not a URL"))?;
    let request = NSMutableURLRequest::requestWithURL(&ns_url);
    request.setHTTPShouldHandleCookies(false);

    let config = NSURLSessionConfiguration::ephemeralSessionConfiguration();
    config.setHTTPShouldSetCookies(false);
    config.setHTTPCookieAcceptPolicy(NSHTTPCookieAcceptPolicy::Never);
    config.setHTTPCookieStorage(None);
    config.setURLCredentialStorage(None);
    config.setURLCache(None);
    config.setRequestCachePolicy(NSURLRequestCachePolicy::ReloadIgnoringLocalCacheData);
    config.setTimeoutIntervalForRequest(FETCH_TIMEOUT.as_secs_f64());
    config.setTimeoutIntervalForResource(FETCH_TIMEOUT.as_secs_f64());
    // An empty dictionary turns the system's proxy settings off: a proxy would resolve the host itself.
    // Safety: the dictionary is empty, so its key and value types do not matter.
    unsafe { config.setConnectionProxyDictionary(Some(&NSDictionary::new())) };

    let (tx, rx) = oneshot::channel();
    let delegate = Delegate::alloc().set_ivars(Mutex::new(Fetch {
        budget,
        taken: 0,
        redirects: 0,
        status: None,
        mime: None,
        body: Vec::new(),
        stopped: None,
        done: Some(tx),
    }));
    let delegate: Retained<Delegate> = unsafe { msg_send![super(delegate), init] };
    // Safety: with no queue given, the session runs the delegate's methods one at a time on a queue of its own.
    let session = unsafe {
        NSURLSession::sessionWithConfiguration_delegate_delegateQueue(
            &config,
            Some(ProtocolObject::from_ref(&*delegate)),
            None,
        )
    };
    session.dataTaskWithRequest(&request).resume();
    // The session lives until the task is done, then lets go of the delegate.
    session.finishTasksAndInvalidate();
    Ok(rx)
}

/// Fetches one image whose URL passed `fetchable`.
///
/// shortcut: the name is resolved here to check the addresses and again by NSURLSession to connect, so a name that
/// changes its answer in between (DNS rebinding) can still reach a private address with this one GET, whose response
/// is then read. Upgrade by checking `NSURLSessionTaskTransactionMetrics.remoteAddress` before reading the body.
pub(super) async fn get(url: Url, budget: &Arc<Budget>) -> Result<Fetched, Failed> {
    let checked = url.clone();
    if !tokio::task::spawn_blocking(move || resolves_public(&checked))
        .await
        .unwrap_or(false)
    {
        return Err(failed("host does not resolve to public addresses only"));
    }
    start(&url, budget.clone())?
        .await
        .unwrap_or_else(|_| Err(failed("session ended without a result")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    fn fetch(budget: u64) -> (Fetch, oneshot::Receiver<Result<Fetched, Failed>>) {
        let (tx, rx) = oneshot::channel();
        let f = Fetch {
            budget: Arc::new(Budget(AtomicU64::new(budget))),
            taken: 0,
            redirects: 0,
            status: None,
            mime: None,
            body: Vec::new(),
            stopped: None,
            done: Some(tx),
        };
        (f, rx)
    }

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn a_small_image_is_kept_and_its_bytes_stay_taken() {
        let (mut f, mut rx) = fetch(100);
        assert!(f.response(200, Some("image/PNG; x=y"), Some(6)));
        assert!(f.data(b"abc") && f.data(b"def"));
        f.finish(None);
        assert_eq!(
            rx.try_recv().unwrap(),
            Ok(("image/png".to_owned(), b"abcdef".to_vec()))
        );
        assert!(!f.budget.has(95));
    }

    #[test]
    fn a_response_that_is_not_a_small_image_is_stopped() {
        for (status, content_type, length, why) in [
            (404, Some("image/png"), Some(1), "unexpected status"),
            (301, Some("image/png"), None, "unexpected status"),
            (
                200,
                Some("text/html"),
                Some(1),
                "not an image, or over the size limit",
            ),
            (200, None, None, "not an image, or over the size limit"),
            (
                200,
                Some("image/png"),
                Some(MAX_IMAGE_BYTES + 1),
                "not an image, or over the size limit",
            ),
            (200, Some("image/png"), Some(11), "total size limit reached"),
        ] {
            let (mut f, mut rx) = fetch(10);
            assert!(!f.response(status, content_type, length));
            // NSURLSession then reports a cancelled task, which must not hide the reason.
            f.finish(Some("cancelled".into()));
            assert_eq!(rx.try_recv().unwrap(), Err((Some(status), why.to_owned())));
        }
    }

    #[test]
    fn a_body_over_the_limit_is_stopped_and_gives_its_bytes_back() {
        let (mut f, mut rx) = fetch(10);
        assert!(f.response(200, Some("image/gif"), None));
        assert!(f.data(&[0; 8]));
        assert!(!f.budget.has(3));
        // 8 + 8 is over what the budget holds.
        assert!(!f.data(&[0; 8]));
        f.finish(Some("cancelled".into()));
        assert_eq!(
            rx.try_recv().unwrap(),
            Err((Some(200), "body over the size limit".to_owned()))
        );
        assert!(f.budget.has(10));

        let (mut f, _rx) = fetch(MAX_TOTAL_BYTES);
        assert!(f.data(&vec![0; MAX_IMAGE_BYTES as usize]));
        assert!(!f.data(&[0]));
    }

    #[test]
    fn a_transport_error_without_a_stop_reports_the_error() {
        let (mut f, mut rx) = fetch(10);
        f.finish(Some("The request timed out.".into()));
        assert_eq!(
            rx.try_recv().unwrap(),
            Err((None, "The request timed out.".to_owned()))
        );
        // Finishing again sends nothing.
        f.finish(None);
    }

    #[test]
    fn redirects_stop_at_the_limit_and_must_stay_on_public_https() {
        assert!(redirect_allowed(0, &url("https://example.com/a.png")));
        assert!(!redirect_allowed(
            MAX_REDIRECTS,
            &url("https://example.com/a.png")
        ));
        assert!(!redirect_allowed(0, &url("http://example.com/a.png")));
        assert!(!redirect_allowed(0, &url("https://10.0.0.1/a.png")));
        assert!(!redirect_allowed(0, &url("https://localhost/a.png")));
    }

    #[test]
    fn all_public_refuses_any_private_address_and_an_empty_list() {
        let addr = |s: &str| s.parse::<SocketAddr>().unwrap();
        assert!(all_public(&[
            addr("93.184.216.34:443"),
            addr("[2606:2800:220:1::1]:443")
        ]));
        assert!(!all_public(&[
            addr("93.184.216.34:443"),
            addr("10.0.0.1:443")
        ]));
        assert!(!all_public(&[]));
    }

    #[test]
    fn names_that_point_at_this_machine_are_refused_before_any_request() {
        let budget = Arc::new(Budget(AtomicU64::new(MAX_IMAGE_BYTES)));
        for refused in ["https://localhost/a.png", "https://127.0.0.1/a.png"] {
            let got = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(get(url(refused), &budget));
            assert!(got.is_err(), "{refused}");
        }
    }

    /// Needs the network: `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn fetches_a_real_image_through_nsurlsession() {
        let budget = Arc::new(Budget(AtomicU64::new(MAX_IMAGE_BYTES)));
        let (mime, bytes) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(get(
                url("https://booking.flypeach.com/images/email/default/new_img/logo-peach.png"),
                &budget,
            ))
            .unwrap();
        println!("{mime} {} bytes", bytes.len());
        assert_eq!(mime, "image/png");
        assert!(bytes.starts_with(b"\x89PNG"));
    }
}
