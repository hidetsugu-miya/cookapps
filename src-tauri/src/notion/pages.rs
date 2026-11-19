//! What the lists of Notion's tools hold, read as plain functions: the favorites, the teamspaces and the pages of a teamspace.
//! A tool's reply is JSON wrapped in a string, and its shape is Notion's, so what a reply lacks is skipped, not guessed.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

/// A favorite page or database of the user.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct NotionFavorite {
    /// `page` or `database`.
    pub kind: String,
    pub url: String,
    pub title: String,
    /// An emoji, when the page has one.
    pub icon: Option<String>,
}

/// A teamspace. Notion gives it no icon.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct NotionTeamspace {
    pub id: String,
    pub name: String,
}

/// A page or database of a teamspace, with the pages under it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct NotionPageNode {
    pub id: String,
    pub title: String,
    pub url: String,
    /// `page` or `database`.
    pub kind: String,
    pub children: Vec<NotionPageNode>,
}

/// One reply of `notion-list-favorite-pages`: its entries, and the cursor of the next reply when there is one.
#[derive(Debug, PartialEq)]
pub struct FavoritePage {
    pub items: Vec<NotionFavorite>,
    pub next_cursor: Option<String>,
}

/// One result of `notion-search`. `path` holds the titles of its parents, the outermost first.
#[derive(Debug, PartialEq)]
pub struct SearchHit {
    pub id: String,
    pub title: String,
    pub url: String,
    pub kind: String,
    pub path: Vec<String>,
}

const NOT_READ: &str = "Notion の返りを読めませんでした";

/// The reply's list: the reply itself when it is an array, else the first of `keys` that holds one.
fn list_of(text: &str, keys: &[&str]) -> Result<Vec<Value>, String> {
    let value: Value = serde_json::from_str(text).map_err(|_| NOT_READ.to_owned())?;
    match &value {
        Value::Array(a) => Some(a),
        _ => keys.iter().find_map(|k| value.get(*k)?.as_array()),
    }
    .cloned()
    .ok_or_else(|| NOT_READ.to_owned())
}

/// A string field, trimmed; a missing, empty or non-string one is `None`.
fn field(value: &Value, key: &str) -> Option<String> {
    let s = value.get(key)?.as_str()?.trim();
    (!s.is_empty()).then(|| s.to_owned())
}

fn kind_of(value: &Value) -> String {
    field(value, "type").unwrap_or_else(|| "page".to_owned())
}

/// A reply of `notion-list-favorite-pages`. An entry with no URL cannot be opened and is skipped.
pub fn parse_favorites(text: &str) -> Result<FavoritePage, String> {
    let list = list_of(text, &["results", "favorites", "pages"])?;
    let items = list
        .iter()
        .filter_map(|e| {
            Some(NotionFavorite {
                kind: kind_of(e),
                url: field(e, "url")?,
                title: field(e, "title").unwrap_or_default(),
                icon: field(e, "icon"),
            })
        })
        .collect();
    let next_cursor = serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| field(&v, "nextCursor").or_else(|| field(&v, "next_cursor")));
    Ok(FavoritePage { items, next_cursor })
}

/// A reply of `notion-get-teams`. An entry needs an id and a name.
pub fn parse_teamspaces(text: &str) -> Result<Vec<NotionTeamspace>, String> {
    Ok(list_of(text, &["teams", "results"])?
        .iter()
        .filter_map(|e| {
            Some(NotionTeamspace {
                id: field(e, "id")?,
                name: field(e, "name")?,
            })
        })
        .collect())
}

/// A reply of `notion-search`. An entry needs an id and a URL.
pub fn parse_search(text: &str) -> Result<Vec<SearchHit>, String> {
    Ok(list_of(text, &["results"])?
        .iter()
        .filter_map(|e| {
            Some(SearchHit {
                id: field(e, "id")?,
                title: field(e, "title").unwrap_or_default(),
                url: field(e, "url")?,
                kind: kind_of(e),
                path: field(e, "path")
                    .map(|p| {
                        p.split(" / ")
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect())
}

/// Hangs each hit under the hit whose parents and title are its `path`, keeping the order of the search among siblings.
/// A hit whose parent is not among the hits (the search holds 50 at most) is a root. Of two hits with one title and path, the first is the parent.
pub fn build_tree(hits: Vec<SearchHit>) -> Vec<NotionPageNode> {
    let mut by_key: HashMap<Vec<&str>, usize> = HashMap::new();
    for (i, h) in hits.iter().enumerate() {
        let mut key: Vec<&str> = h.path.iter().map(String::as_str).collect();
        key.push(&h.title);
        by_key.entry(key).or_insert(i);
    }
    let mut roots = vec![];
    let mut children: Vec<Vec<usize>> = vec![vec![]; hits.len()];
    for (i, h) in hits.iter().enumerate() {
        let parent_key: Vec<&str> = h.path.iter().map(String::as_str).collect();
        match by_key.get(&parent_key) {
            Some(&p) => children[p].push(i),
            None => roots.push(i),
        }
    }
    roots
        .into_iter()
        .map(|i| node_of(i, &hits, &children))
        .collect()
}

/// A parent's path is shorter than its child's, so the chain of parents ends and the recursion is as deep as the path.
fn node_of(i: usize, hits: &[SearchHit], children: &[Vec<usize>]) -> NotionPageNode {
    let h = &hits[i];
    NotionPageNode {
        id: h.id.clone(),
        title: h.title.clone(),
        url: h.url.clone(),
        kind: h.kind.clone(),
        children: children[i]
            .iter()
            .map(|&c| node_of(c, hits, children))
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn favorites_are_read_with_their_cursor_and_an_entry_with_no_url_is_skipped() {
        let text = r#"{"results":[
            {"type":"page","url":"https://www.notion.so/a","title":" 議事録 ","icon":"📝"},
            {"type":"database","url":"https://www.notion.so/b","title":"DB","icon":null},
            {"type":"page","title":"no url"},
            {"url":"https://www.notion.so/c"}
        ],"nextCursor":"c2"}"#;
        let page = parse_favorites(text).unwrap();
        assert_eq!(page.next_cursor.as_deref(), Some("c2"));
        assert_eq!(
            page.items,
            vec![
                NotionFavorite {
                    kind: "page".into(),
                    url: "https://www.notion.so/a".into(),
                    title: "議事録".into(),
                    icon: Some("📝".into()),
                },
                NotionFavorite {
                    kind: "database".into(),
                    url: "https://www.notion.so/b".into(),
                    title: "DB".into(),
                    icon: None,
                },
                NotionFavorite {
                    kind: "page".into(),
                    url: "https://www.notion.so/c".into(),
                    title: String::new(),
                    icon: None,
                },
            ]
        );
    }

    #[test]
    fn favorites_with_no_cursor_or_an_empty_one_end_the_list_and_a_bare_array_is_read() {
        let page = parse_favorites(r#"[{"type":"page","url":"u","title":"t"}]"#).unwrap();
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.next_cursor, None);
        let page = parse_favorites(r#"{"results":[],"nextCursor":""}"#).unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.next_cursor, None);
        let page = parse_favorites(r#"{"results":[],"next_cursor":"x"}"#).unwrap();
        assert_eq!(page.next_cursor.as_deref(), Some("x"));
    }

    #[test]
    fn a_reply_that_is_no_json_or_holds_no_list_is_an_error_for_every_tool() {
        for text in ["", "no json", r#"{"other":1}"#, "3"] {
            assert!(parse_favorites(text).is_err(), "{text}");
            assert!(parse_teamspaces(text).is_err(), "{text}");
            assert!(parse_search(text).is_err(), "{text}");
        }
    }

    #[test]
    fn teamspaces_need_an_id_and_a_name() {
        let text = r#"{"teams":[
            {"id":"t1","name":"開発","role":"owner"},
            {"id":"t2"},
            {"name":"no id"},
            {"id":" ","name":"blank"}
        ]}"#;
        assert_eq!(
            parse_teamspaces(text).unwrap(),
            vec![NotionTeamspace {
                id: "t1".into(),
                name: "開発".into()
            }]
        );
        assert_eq!(parse_teamspaces("[]").unwrap(), vec![]);
    }

    #[test]
    fn a_search_hit_has_an_id_a_url_a_kind_and_its_parents_cut_at_the_slashes() {
        let text = r#"{"results":[
            {"id":"p1","title":"C","url":"u1","type":"page","path":"A / B"},
            {"id":"p2","title":"Top","url":"u2","type":"database"},
            {"id":"p3","title":"x","path":"A"},
            {"title":"no id","url":"u"}
        ]}"#;
        let hits = parse_search(text).unwrap();
        assert_eq!(
            hits,
            vec![
                SearchHit {
                    id: "p1".into(),
                    title: "C".into(),
                    url: "u1".into(),
                    kind: "page".into(),
                    path: vec!["A".into(), "B".into()],
                },
                SearchHit {
                    id: "p2".into(),
                    title: "Top".into(),
                    url: "u2".into(),
                    kind: "database".into(),
                    path: vec![],
                },
            ]
        );
    }

    fn hit(id: &str, title: &str, path: &[&str]) -> SearchHit {
        SearchHit {
            id: id.into(),
            title: title.into(),
            url: format!("https://www.notion.so/{id}"),
            kind: "page".into(),
            path: path.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn ids(nodes: &[NotionPageNode]) -> Vec<&str> {
        nodes.iter().map(|n| n.id.as_str()).collect()
    }

    #[test]
    fn pages_hang_under_the_hit_their_path_names_in_the_order_of_the_search() {
        let tree = build_tree(vec![
            hit("c", "C", &["A", "B"]),
            hit("a", "A", &[]),
            hit("b", "B", &["A"]),
            hit("d", "D", &["A"]),
            hit("z", "Z", &[]),
        ]);
        assert_eq!(ids(&tree), ["a", "z"]);
        assert_eq!(ids(&tree[0].children), ["b", "d"]);
        assert_eq!(ids(&tree[0].children[0].children), ["c"]);
        assert!(tree[1].children.is_empty());
        assert_eq!(
            tree[0].children[0].children[0].url,
            "https://www.notion.so/c"
        );
    }

    #[test]
    fn a_page_whose_parent_is_not_among_the_hits_is_a_root() {
        let tree = build_tree(vec![
            hit("x", "X", &["Team", "Gone"]),
            hit("y", "Y", &["Team"]),
        ]);
        assert_eq!(ids(&tree), ["x", "y"]);
    }

    #[test]
    fn a_page_with_the_title_of_its_parent_is_its_child_not_itself() {
        let tree = build_tree(vec![hit("p", "A", &[]), hit("q", "A", &["A"])]);
        assert_eq!(ids(&tree), ["p"]);
        assert_eq!(ids(&tree[0].children), ["q"]);
    }

    #[test]
    fn two_parents_with_one_title_take_the_first_hit_and_nothing_is_lost() {
        let tree = build_tree(vec![
            hit("p1", "A", &[]),
            hit("p2", "A", &[]),
            hit("k", "K", &["A"]),
        ]);
        assert_eq!(ids(&tree), ["p1", "p2"]);
        assert_eq!(ids(&tree[0].children), ["k"]);
        assert!(build_tree(vec![]).is_empty());
    }
}
