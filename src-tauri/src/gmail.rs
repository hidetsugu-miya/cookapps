use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, State};
use tokio::task::JoinSet;

use crate::auth::Auth;

const THREADS_URL: &str = "https://gmail.googleapis.com/gmail/v1/users/me/threads";
const METADATA_QUERY: [(&str, &str); 4] = [
    ("format", "metadata"),
    ("metadataHeaders", "From"),
    ("metadataHeaders", "Subject"),
    ("metadataHeaders", "Date"),
];
// Keeps the burst of threads.get calls small enough for Gmail's per-second quota.
const CONCURRENCY: usize = 10;

#[derive(Deserialize)]
struct ThreadList {
    #[serde(default)]
    threads: Vec<ThreadRef>,
}

#[derive(Deserialize)]
struct ThreadRef {
    id: String,
}

#[derive(Deserialize)]
struct Thread {
    id: String,
    #[serde(default)]
    snippet: String,
    #[serde(default)]
    messages: Vec<Message>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Message {
    #[serde(default)]
    label_ids: Vec<String>,
    #[serde(default)]
    internal_date: String,
    #[serde(default)]
    payload: Payload,
}

#[derive(Deserialize, Default)]
struct Payload {
    #[serde(default)]
    headers: Vec<Header>,
}

#[derive(Deserialize)]
struct Header {
    name: String,
    value: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ThreadItem {
    id: String,
    from: String,
    subject: String,
    snippet: String,
    date_ms: i64,
    unread: bool,
}

fn header(message: &Message, name: &str) -> String {
    message
        .payload
        .headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case(name))
        .map(|h| h.value.clone())
        .unwrap_or_default()
}

impl From<Thread> for ThreadItem {
    /// Subject comes from the first message, sender and date from the latest one.
    fn from(t: Thread) -> Self {
        let first = t.messages.first();
        let last = t.messages.last();
        Self {
            subject: first.map(|m| header(m, "Subject")).unwrap_or_default(),
            from: last.map(|m| header(m, "From")).unwrap_or_default(),
            date_ms: last.and_then(|m| m.internal_date.parse().ok()).unwrap_or(0),
            unread: t
                .messages
                .iter()
                .any(|m| m.label_ids.iter().any(|l| l == "UNREAD")),
            id: t.id,
            snippet: t.snippet,
        }
    }
}

/// `Ok(None)` means the token was rejected with 401.
async fn get_json<T: DeserializeOwned>(
    http: &reqwest::Client,
    token: &str,
    url: &str,
    query: &[(&str, &str)],
) -> Result<Option<T>, String> {
    let res = http
        .get(url)
        .bearer_auth(token)
        .query(query)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(None);
    }
    if !status.is_success() {
        let body = res.text().await.unwrap_or_default();
        return Err(format!("Gmail API が {status} を返しました: {body}"));
    }
    res.json().await.map(Some).map_err(|e| e.to_string())
}

/// `Ok(None)` means login is required.
#[tauri::command]
pub async fn inbox(
    app: AppHandle,
    auth: State<'_, Auth>,
) -> Result<Option<Vec<ThreadItem>>, String> {
    let http = auth.http();
    let Some(mut token) = auth.token(&app).await? else {
        return Ok(None);
    };
    let list_query = [("labelIds", "INBOX"), ("maxResults", "50")];
    let list: ThreadList = match get_json(http, &token, THREADS_URL, &list_query).await? {
        Some(list) => list,
        None => {
            let Some(refreshed) = auth.refresh(&app).await? else {
                return Ok(None);
            };
            token = refreshed;
            get_json(http, &token, THREADS_URL, &list_query)
                .await?
                .ok_or("認証に失敗しました")?
        }
    };

    let mut items = Vec::with_capacity(list.threads.len());
    for chunk in list.threads.chunks(CONCURRENCY) {
        let mut set = JoinSet::new();
        for t in chunk {
            let (http, token, url) = (http.clone(), token.clone(), format!("{THREADS_URL}/{}", t.id));
            set.spawn(async move { get_json::<Thread>(&http, &token, &url, &METADATA_QUERY).await });
        }
        while let Some(res) = set.join_next().await {
            let thread = res.map_err(|e| e.to_string())??.ok_or("認証に失敗しました")?;
            items.push(ThreadItem::from(thread));
        }
    }
    items.sort_by_key(|i| std::cmp::Reverse(i.date_ms));
    Ok(Some(items))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_metadata_thread_to_item() {
        let json = r#"{
            "id": "t1",
            "snippet": "latest reply",
            "messages": [
                {"id": "m1", "labelIds": ["INBOX"], "internalDate": "1000",
                 "payload": {"headers": [
                    {"name": "From", "value": "Alice <a@example.com>"},
                    {"name": "Subject", "value": "Hello"},
                    {"name": "Date", "value": "Thu, 1 Jan 1970 00:00:01 +0000"}]}},
                {"id": "m2", "labelIds": ["INBOX", "UNREAD"], "internalDate": "2000",
                 "payload": {"headers": [
                    {"name": "from", "value": "Bob <b@example.com>"},
                    {"name": "Subject", "value": "Re: Hello"}]}}
            ]
        }"#;
        let item = ThreadItem::from(serde_json::from_str::<Thread>(json).unwrap());
        assert_eq!(
            item,
            ThreadItem {
                id: "t1".into(),
                from: "Bob <b@example.com>".into(),
                subject: "Hello".into(),
                snippet: "latest reply".into(),
                date_ms: 2000,
                unread: true,
            }
        );
    }

    #[test]
    fn read_thread_without_headers_gets_defaults() {
        let json = r#"{"id": "t2", "messages": [{"id": "m1", "labelIds": ["INBOX"]}]}"#;
        let item = ThreadItem::from(serde_json::from_str::<Thread>(json).unwrap());
        assert_eq!(item.subject, "");
        assert_eq!(item.from, "");
        assert_eq!(item.date_ms, 0);
        assert!(!item.unread);
    }

    #[test]
    fn empty_list_response_has_no_threads() {
        let list: ThreadList = serde_json::from_str(r#"{"resultSizeEstimate": 0}"#).unwrap();
        assert!(list.threads.is_empty());
    }
}
