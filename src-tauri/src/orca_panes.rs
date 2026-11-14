//! A-17: how the work pane of the Orca screen is split into panes, each with its own tabs.
//!
//! The layout of a project is a tree: a pane (its tabs, in order, and the one selected) or a split of two or more nodes, side by side (`Row`) or one above the other (`Column`).
//! The nodes of a split each have a share of its size (`sizes`, which add up to 1), which the user changes by dragging the divider between two of them; a file saved before the shares were kept has none, and is read as equal shares.
//! It is saved for each project of each target (this machine, or a saved environment) in `orca-panes.json` in the app config directory.
//! The file holds only tab ids that the screen made up (`claude:{pane key}`, `orca:{handle}`, `file:{n}` for a file open in the editor of A-18, `diff:{n}` for the diff of a file, A-24) and project keys of Orca, no token and no screen content or path of a file.
//! A terminal whose kind changes (a plain terminal where Claude starts, or Claude's where the shell is back) has a new tab id but the same Orca handle, so it keeps its place in its pane and its selection.
//! A tab that Orca no longer lists leaves the layout, a tab it lists that the layout lacks joins the pane that has the focus, and a pane left with no tab is closed, so a layout of an older Orca or a broken file is mended at each read.
//! A file that cannot be read as it was written is taken as empty and replaced by the next save.

use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(test)]
use ts_rs::TS;

use crate::{accounts::write_atomic, auth::config_dir};

const FILE: &str = "orca-panes.json";
const VERSION: u32 = 1;
/// A layout deeper than this, or with more tabs, was not written by this app: it is dropped and made again from the tabs.
const MAX_DEPTH: usize = 32;
const MAX_TABS: usize = 500;
const MAX_TEXT: usize = 512;
/// The least share of its split that a drag of a divider leaves a node.
const MIN_SHARE: f64 = 0.1;
/// Shares that add up to 1 within this are kept as they are, so that a read does not change, and save, a layout by rounding.
const SUM_SLACK: f64 = 1e-9;
/// The file is read and written in turn by the commands of the screen, which may overlap.
static LOCK: Mutex<()> = Mutex::new(());

/// How the children of a split lie: `Row` side by side, `Column` one above the other.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub enum Direction {
    Row,
    Column,
}

/// Where a tab is put in relation to a pane: at an edge it splits the pane, in the `Center` it joins the pane's tabs.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
    Center,
}

/// A pane with its tabs and the one shown, or a split of two or more nodes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PaneNode {
    Pane {
        id: String,
        tabs: Vec<String>,
        selected: String,
    },
    Split {
        direction: Direction,
        children: Vec<PaneNode>,
        /// The share of the split's size that each child has, in the order of `children`; they add up to 1. A file saved before the shares were kept has none: equal shares.
        #[serde(default)]
        sizes: Vec<f64>,
    },
}

/// The panes of a project, and the one that has the focus (the plus adds its tab there; the selected tab of it is the project's selected tab). `root` is `None` when the project has no tab.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(rename_all = "camelCase")]
pub struct PaneLayout {
    pub root: Option<PaneNode>,
    pub focus: Option<String>,
}

/// What the user did to the layout.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[cfg_attr(test, ts(export, export_to = crate::BINDINGS))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PaneOp {
    /// The pane takes the focus.
    Focus { pane: String },
    /// The tab is shown in its pane, and the pane takes the focus.
    Select { tab: String },
    /// The tab moves to the `pane` at `edge`: a new pane beside it, or (the center) the end of its tabs. A pane left with no tab is closed.
    Move {
        tab: String,
        pane: String,
        edge: Edge,
    },
    /// The divider between two nodes of a split was dragged. `before` is a pane of the node before it and `after` a pane of the node after it (any pane of each), and `share` is the part the node before it takes of the size the two have together (0 to 1). No other node changes.
    Resize {
        before: String,
        after: String,
        share: f64,
    },
}

// ---- the tree ----

/// Equal shares for `n` nodes.
fn equal(n: usize) -> Vec<f64> {
    vec![1.0 / n as f64; n]
}

/// The shares of a split of `n` nodes as they were saved, or equal ones when they are not one positive number for each node.
fn shares(sizes: Vec<f64>, n: usize) -> Vec<f64> {
    if sizes.len() == n && sizes.iter().all(|s| s.is_finite() && *s > 0.0) {
        sizes
    } else {
        equal(n)
    }
}

/// The shares scaled so that they add up to 1 (each keeps its proportion), which gives the share of a node that left to the rest.
fn scaled(sizes: Vec<f64>) -> Vec<f64> {
    let sum: f64 = sizes.iter().sum();
    if (sum - 1.0).abs() <= SUM_SLACK {
        sizes
    } else if sum.is_finite() && sum > 0.0 {
        sizes.into_iter().map(|s| s / sum).collect()
    } else {
        equal(sizes.len())
    }
}

fn each_pane_mut(
    node: &mut PaneNode,
    f: &mut impl FnMut(&mut String, &mut Vec<String>, &mut String),
) {
    match node {
        PaneNode::Pane { id, tabs, selected } => f(id, tabs, selected),
        PaneNode::Split { children, .. } => children.iter_mut().for_each(|c| each_pane_mut(c, f)),
    }
}

/// The panes as `(id, tabs)`, left to right and top to bottom.
fn panes(node: &PaneNode) -> Vec<(&str, &[String])> {
    match node {
        PaneNode::Pane { id, tabs, .. } => vec![(id.as_str(), tabs.as_slice())],
        PaneNode::Split { children, .. } => children.iter().flat_map(panes).collect(),
    }
}

fn depth(node: &PaneNode) -> usize {
    match node {
        PaneNode::Pane { .. } => 1,
        PaneNode::Split { children, .. } => 1 + children.iter().map(depth).max().unwrap_or(0),
    }
}

/// The pane that has the tab.
fn pane_of(node: &PaneNode, tab: &str) -> Option<String> {
    panes(node)
        .into_iter()
        .find(|(_, tabs)| tabs.iter().any(|t| t == tab))
        .map(|(id, _)| id.to_owned())
}

/// A pane id that no pane has.
fn fresh_id(node: &PaneNode) -> String {
    let used: HashSet<&str> = panes(node).into_iter().map(|(id, _)| id).collect();
    (1..)
        .map(|n| format!("p{n}"))
        .find(|id| !used.contains(id.as_str()))
        .expect("an unused number exists")
}

/// Takes the tab out of its pane. The pane may be left with no tab (`normalize` closes it); the tab shown is then the one that followed it, else the one before.
fn take_tab(node: &mut PaneNode, tab: &str) {
    each_pane_mut(node, &mut |_, tabs, selected| {
        if let Some(at) = tabs.iter().position(|t| t == tab) {
            tabs.remove(at);
            if selected == tab {
                *selected = tabs
                    .get(at)
                    .or_else(|| tabs.last())
                    .cloned()
                    .unwrap_or_default();
            }
        }
    });
}

/// Puts a new pane with `new` beside the pane `target`, before or after it. Beside a split of the same direction it joins that split.
/// The new pane takes half of the size the target had, and the target keeps the other half.
fn insert_beside(
    node: &mut PaneNode,
    target: &str,
    new: PaneNode,
    direction: Direction,
    after: bool,
) -> bool {
    if matches!(node, PaneNode::Pane { id, .. } if id == target) {
        let old = std::mem::replace(
            node,
            PaneNode::Split {
                direction,
                children: vec![],
                sizes: vec![],
            },
        );
        let children = if after {
            vec![old, new]
        } else {
            vec![new, old]
        };
        *node = PaneNode::Split {
            direction,
            children,
            sizes: equal(2),
        };
        return true;
    }
    let PaneNode::Split {
        direction: own,
        children,
        sizes,
    } = node
    else {
        return false;
    };
    let at = children
        .iter()
        .position(|c| matches!(c, PaneNode::Pane { id, .. } if id == target));
    if let (Some(at), true) = (at, *own == direction) {
        // Shares that are not one for each node are left for `normalize`, which makes them equal.
        if sizes.len() == children.len() {
            sizes[at] /= 2.0;
            sizes.insert(at, sizes[at]);
        }
        children.insert(if after { at + 1 } else { at }, new);
        return true;
    }
    let mut new = Some(new);
    for child in children.iter_mut() {
        // Only the child that holds the target takes it, so one that does not leaves `new` for the next.
        if panes(child).iter().any(|(id, _)| *id == target) {
            return insert_beside(
                child,
                target,
                new.take().expect("given once"),
                direction,
                after,
            );
        }
    }
    false
}

/// Sets the shares of the two nodes on the sides of a divider: the one that holds the pane `before` and the next one, which holds `after`, in the deepest split that holds both. The node before the divider takes `share` of what the two have together, each keeps at least `MIN_SHARE` of the split (half of what the two have, when that is less), and no other node changes. A divider that is not there changes nothing.
fn resize(node: &mut PaneNode, before: &str, after: &str, share: f64) {
    let PaneNode::Split {
        children, sizes, ..
    } = node
    else {
        return;
    };
    let holds = |pane: &str| {
        children
            .iter()
            .position(|c| panes(c).iter().any(|(id, _)| *id == pane))
    };
    let (Some(i), Some(j)) = (holds(before), holds(after)) else {
        return;
    };
    if i == j {
        resize(&mut children[i], before, after, share);
    } else if j == i + 1 && sizes.len() == children.len() && share.is_finite() {
        let both = sizes[i] + sizes[j];
        let least = MIN_SHARE.min(both / 2.0);
        sizes[i] = (share * both).clamp(least, both - least);
        sizes[j] = both - sizes[i];
    }
}

/// Closes the panes with no tab, takes a split of one node for the node, and merges a split into its parent of the same direction.
/// A split's shares are made equal when they are not one positive number for each node; a node that closes gives its share to the rest in proportion, and the nodes of a merged split divide the share it had.
fn normalize(node: PaneNode) -> Option<PaneNode> {
    match node {
        PaneNode::Pane { id, tabs, selected } => {
            let first = tabs.first()?.clone();
            let selected = if tabs.contains(&selected) {
                selected
            } else {
                first
            };
            Some(PaneNode::Pane { id, tabs, selected })
        }
        PaneNode::Split {
            direction,
            children,
            sizes,
        } => {
            let sizes = shares(sizes, children.len());
            let mut flat = Vec::new();
            let mut flat_sizes = Vec::new();
            for (child, share) in children.into_iter().zip(sizes) {
                match normalize(child) {
                    None => {}
                    Some(PaneNode::Split {
                        direction: inner,
                        children,
                        sizes,
                    }) if inner == direction => {
                        flat_sizes.extend(sizes.iter().map(|s| s * share));
                        flat.extend(children);
                    }
                    Some(other) => {
                        flat.push(other);
                        flat_sizes.push(share);
                    }
                }
            }
            match flat.len() {
                0 => None,
                1 => flat.pop(),
                _ => Some(PaneNode::Split {
                    direction,
                    children: flat,
                    sizes: scaled(flat_sizes),
                }),
            }
        }
    }
}

/// The handles of the Orca terminals behind the tab ids: of the tabs listed now (`now`), and of the tabs of the read before (`was`, by the call that last worked), as the screen knows them.
/// A tab with no terminal has no entry.
#[derive(Default, Debug)]
pub struct Handles {
    pub now: HashMap<String, String>,
    pub was: HashMap<String, String>,
}

/// A terminal whose kind changed (a plain terminal where Claude started, or the other way round) is listed under a new tab id and the same handle. Its old tab id is replaced by the new one, in the same pane at the same place, and it stays the pane's selected tab if it was.
/// The old tab's handle is the one `handles.was` gives, else the one a plain tab id carries (`orca:{handle}`). A tab id that is still listed, or a new one the layout already has, is not touched.
pub fn follow_kind_switches(
    mut layout: PaneLayout,
    live: &[String],
    handles: &Handles,
) -> PaneLayout {
    let Some(root) = layout.root.as_mut() else {
        return layout;
    };
    let held: Vec<String> = panes(root)
        .into_iter()
        .flat_map(|(_, tabs)| tabs.iter().cloned())
        .collect();
    let mut taken: HashSet<&str> = held.iter().map(String::as_str).collect();
    let mut renames: Vec<(&str, &str)> = Vec::new();
    let live_set: HashSet<&str> = live.iter().map(String::as_str).collect();
    // The tabs listed now by their handle, in the order of `live`.
    let mut by_handle: HashMap<&str, Vec<&str>> = HashMap::new();
    for tab in live {
        if let Some(handle) = handles.now.get(tab) {
            by_handle.entry(handle).or_default().push(tab);
        }
    }
    for old in held.iter().filter(|t| !live_set.contains(t.as_str())) {
        let Some(handle) = handles
            .was
            .get(old)
            .map(String::as_str)
            .or_else(|| old.strip_prefix("orca:"))
        else {
            continue;
        };
        let new = by_handle
            .get(handle)
            .and_then(|tabs| tabs.iter().find(|t| !taken.contains(**t)));
        if let Some(&new) = new {
            taken.insert(new);
            renames.push((old, new));
        }
    }
    each_pane_mut(root, &mut |_, tabs, selected| {
        for (old, new) in &renames {
            for tab in tabs.iter_mut().filter(|t| t == old) {
                *tab = (*new).to_owned();
            }
            if selected == old {
                *selected = (*new).to_owned();
            }
        }
    });
    layout
}

// ---- the layout ----

/// Mends the layout against the tabs Orca lists now (`live`, in the order the screen shows them) and returns it normalized.
pub fn reconcile(layout: PaneLayout, live: &[String]) -> PaneLayout {
    let live_set: HashSet<&str> = live.iter().map(String::as_str).collect();
    let mut root = layout.root.filter(|r| {
        depth(r) <= MAX_DEPTH && panes(r).iter().map(|(_, t)| t.len()).sum::<usize>() <= MAX_TABS
    });
    if let Some(r) = root.as_mut() {
        // A tab that is gone, or one a pane already has, leaves; a pane id used twice is renamed.
        let mut seen = HashSet::new();
        let mut used = HashSet::new();
        each_pane_mut(r, &mut |id, tabs, _| {
            tabs.retain(|t| live_set.contains(t.as_str()) && seen.insert(t.clone()));
            if !used.insert(id.clone()) {
                id.clear();
            }
        });
        each_pane_mut(r, &mut |id, _, _| {
            if id.is_empty() {
                *id = (1..)
                    .map(|n| format!("p{n}"))
                    .find(|c| !used.contains(c))
                    .expect("an unused number exists");
                used.insert(id.clone());
            }
        });
    }
    let mut root = root.and_then(normalize);
    let held: HashSet<String> = root
        .as_ref()
        .map(|r| {
            panes(r)
                .into_iter()
                .flat_map(|(_, tabs)| tabs.iter().cloned())
                .collect()
        })
        .unwrap_or_default();
    let mut added = HashSet::new();
    let missing: Vec<String> = live
        .iter()
        .filter(|t| !held.contains(*t) && added.insert((*t).clone()))
        .cloned()
        .collect();
    let mut focus = layout.focus;
    if !missing.is_empty() {
        match root.as_mut() {
            None => {
                focus = Some("p1".into());
                root = Some(PaneNode::Pane {
                    id: "p1".into(),
                    selected: missing[0].clone(),
                    tabs: missing,
                });
            }
            Some(r) => {
                let ids: Vec<&str> = panes(r).into_iter().map(|(id, _)| id).collect();
                let target = focus
                    .clone()
                    .filter(|f| ids.contains(&f.as_str()))
                    .unwrap_or_else(|| ids[0].to_owned());
                each_pane_mut(r, &mut |id, tabs, _| {
                    if *id == target {
                        tabs.extend(missing.iter().cloned());
                    }
                });
            }
        }
    }
    let focus = root.as_ref().and_then(|r| {
        let ids: Vec<&str> = panes(r).into_iter().map(|(id, _)| id).collect();
        focus
            .filter(|f| ids.contains(&f.as_str()))
            .or_else(|| ids.first().map(|id| (*id).to_owned()))
    });
    PaneLayout { root, focus }
}

/// Does what the user did. An operation on a tab or a pane the layout does not have changes nothing.
pub fn apply(mut layout: PaneLayout, op: &PaneOp) -> PaneLayout {
    let Some(root) = layout.root.as_mut() else {
        return layout;
    };
    match op {
        PaneOp::Focus { pane } => {
            if panes(root).iter().any(|(id, _)| id == pane) {
                layout.focus = Some(pane.clone());
            }
        }
        PaneOp::Select { tab } => {
            if let Some(pane) = pane_of(root, tab) {
                each_pane_mut(root, &mut |id, _, selected| {
                    if *id == pane {
                        *selected = tab.clone();
                    }
                });
                layout.focus = Some(pane);
            }
        }
        PaneOp::Move { tab, pane, edge } => {
            let Some(source) = pane_of(root, tab) else {
                return layout;
            };
            let Some((_, target_tabs)) = panes(root).into_iter().find(|(id, _)| id == pane) else {
                return layout;
            };
            let alone = target_tabs.len() == 1;
            if *edge == Edge::Center {
                if source != *pane {
                    take_tab(root, tab);
                    each_pane_mut(root, &mut |id, tabs, _| {
                        if id == pane {
                            tabs.push(tab.clone());
                        }
                    });
                }
                each_pane_mut(root, &mut |id, _, selected| {
                    if id == pane {
                        *selected = tab.clone();
                    }
                });
                layout.focus = Some(pane.clone());
            } else if source != *pane || !alone {
                take_tab(root, tab);
                let id = fresh_id(root);
                let new = PaneNode::Pane {
                    id: id.clone(),
                    tabs: vec![tab.clone()],
                    selected: tab.clone(),
                };
                let (direction, after) = match edge {
                    Edge::Left => (Direction::Row, false),
                    Edge::Right => (Direction::Row, true),
                    Edge::Top => (Direction::Column, false),
                    _ => (Direction::Column, true),
                };
                insert_beside(root, pane, new, direction, after);
                layout.focus = Some(id);
            }
        }
        PaneOp::Resize {
            before,
            after,
            share,
        } => resize(root, before, after, *share),
    }
    layout.root = layout.root.take().and_then(normalize);
    layout
}

// ---- the file ----

#[derive(Serialize, Deserialize, Default)]
struct Store {
    version: u32,
    entries: Vec<Entry>,
}

#[derive(Serialize, Deserialize)]
struct Entry {
    /// The saved environment, `None` for this machine.
    environment: Option<String>,
    project: String,
    layout: PaneLayout,
}

fn load(dir: &Path) -> Store {
    std::fs::read_to_string(dir.join(FILE))
        .ok()
        .and_then(|text| serde_json::from_str::<Store>(&text).ok())
        .filter(|s| s.version == VERSION)
        .unwrap_or_else(|| Store {
            version: VERSION,
            entries: Vec::new(),
        })
}

fn save(dir: &Path, store: &Store) -> Result<(), String> {
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    write_atomic(dir, FILE, &text)
}

/// The layout of the project `project` of `environment`, with the terminals that changed kind followed, mended against `live` and changed by `op`, saved when it differs from the saved one (a project with no tab leaves no entry).
fn update(
    dir: &Path,
    environment: Option<&str>,
    project: &str,
    live: &[String],
    handles: &Handles,
    op: Option<&PaneOp>,
) -> Result<PaneLayout, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut store = load(dir);
    let at = store
        .entries
        .iter()
        .position(|e| e.environment.as_deref() == environment && e.project == project);
    let held = at.map(|i| store.entries[i].layout.clone());
    let followed = follow_kind_switches(held.clone().unwrap_or_default(), live, handles);
    let mut layout = reconcile(followed, live);
    if let Some(op) = op {
        layout = apply(layout, op);
    }
    if layout.root.is_none() {
        if let Some(i) = at {
            store.entries.remove(i);
            save(dir, &store)?;
        }
    } else if held.as_ref() != Some(&layout) {
        let entry = Entry {
            environment: environment.map(str::to_owned),
            project: project.to_owned(),
            layout: layout.clone(),
        };
        match at {
            Some(i) => store.entries[i] = entry,
            None => store.entries.push(entry),
        }
        save(dir, &store)?;
    }
    Ok(layout)
}

fn check_text(what: &str, text: &str) -> Result<(), String> {
    if text.is_empty() || text.len() > MAX_TEXT || text.chars().any(char::is_control) {
        return Err(format!("{what}が正しくありません"));
    }
    Ok(())
}

fn check(
    environment: Option<&str>,
    project: &str,
    live: &[String],
    handles: &Handles,
    op: Option<&PaneOp>,
) -> Result<(), String> {
    if let Some(environment) = environment {
        check_text("接続先", environment)?;
    }
    check_text("プロジェクト", project)?;
    if live.len() > MAX_TABS {
        return Err("タブが多すぎます".into());
    }
    live.iter().try_for_each(|t| check_text("タブ", t))?;
    if handles.now.len() > MAX_TABS || handles.was.len() > MAX_TABS {
        return Err("タブが多すぎます".into());
    }
    handles
        .now
        .iter()
        .chain(&handles.was)
        .try_for_each(|(tab, handle)| {
            check_text("タブ", tab)?;
            check_text("ハンドル", handle)
        })?;
    match op {
        Some(PaneOp::Focus { pane }) => check_text("ペイン", pane),
        Some(PaneOp::Select { tab }) => check_text("タブ", tab),
        Some(PaneOp::Move { tab, pane, .. }) => {
            check_text("タブ", tab)?;
            check_text("ペイン", pane)
        }
        Some(PaneOp::Resize {
            before,
            after,
            share,
        }) => {
            check_text("ペイン", before)?;
            check_text("ペイン", after)?;
            if !(0.0..=1.0).contains(share) {
                return Err("比率が正しくありません".into());
            }
            Ok(())
        }
        None => Ok(()),
    }
}

/// The layout of the work pane of a project (A-17): the one saved, mended against the tabs the screen shows now (`tabs`), after `op` when there is one. It is saved when it changed.
/// `handles` is the Orca handle of each of those tabs that has a terminal, and `was` that of the tabs of the read before: a terminal that changed kind keeps its place.
#[tauri::command]
pub async fn orca_panes(
    app: AppHandle,
    environment: Option<String>,
    project: String,
    tabs: Vec<String>,
    handles: HashMap<String, String>,
    was: HashMap<String, String>,
    op: Option<PaneOp>,
) -> Result<PaneLayout, String> {
    let handles = Handles { now: handles, was };
    check(
        environment.as_deref(),
        &project,
        &tabs,
        &handles,
        op.as_ref(),
    )?;
    let dir = config_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        update(
            &dir,
            environment.as_deref(),
            &project,
            &tabs,
            &handles,
            op.as_ref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn ids(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| (*s).to_owned()).collect()
    }

    fn pane(id: &str, tabs: &[&str], selected: &str) -> PaneNode {
        PaneNode::Pane {
            id: id.into(),
            tabs: ids(tabs),
            selected: selected.into(),
        }
    }

    /// A split whose children share its size equally.
    fn split(direction: Direction, children: Vec<PaneNode>) -> PaneNode {
        let sizes = equal(children.len());
        PaneNode::Split {
            direction,
            children,
            sizes,
        }
    }

    fn sized(direction: Direction, children: Vec<PaneNode>, sizes: &[f64]) -> PaneNode {
        PaneNode::Split {
            direction,
            children,
            sizes: sizes.to_vec(),
        }
    }

    fn resize(before: &str, after: &str, share: f64) -> PaneOp {
        PaneOp::Resize {
            before: before.into(),
            after: after.into(),
            share,
        }
    }

    /// The shares of the split at the root.
    fn sizes_of(layout: &PaneLayout) -> Vec<f64> {
        match layout.root.as_ref() {
            Some(PaneNode::Split { sizes, .. }) => sizes.clone(),
            other => panic!("{other:?}"),
        }
    }

    fn close(got: &[f64], want: &[f64]) -> bool {
        got.len() == want.len() && got.iter().zip(want).all(|(g, w)| (g - w).abs() < 1e-9)
    }

    fn layout(root: PaneNode, focus: &str) -> PaneLayout {
        PaneLayout {
            root: Some(root),
            focus: Some(focus.into()),
        }
    }

    fn mv(tab: &str, pane: &str, edge: Edge) -> PaneOp {
        PaneOp::Move {
            tab: tab.into(),
            pane: pane.into(),
            edge,
        }
    }

    fn handles(now: &[(&str, &str)], was: &[(&str, &str)]) -> Handles {
        let map = |pairs: &[(&str, &str)]| {
            pairs
                .iter()
                .map(|(tab, handle)| ((*tab).to_owned(), (*handle).to_owned()))
                .collect()
        };
        Handles {
            now: map(now),
            was: map(was),
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("cookapps-panes-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_project_with_no_saved_layout_gets_one_pane_with_all_its_tabs() {
        let got = reconcile(PaneLayout::default(), &ids(&["a", "b", "c"]));
        assert_eq!(got, layout(pane("p1", &["a", "b", "c"], "a"), "p1"));
        assert_eq!(reconcile(PaneLayout::default(), &[]), PaneLayout::default());
    }

    #[test]
    fn a_tab_that_is_gone_leaves_and_an_empty_pane_closes() {
        let saved = layout(
            split(
                Direction::Row,
                vec![pane("p1", &["a", "b"], "b"), pane("p2", &["c"], "c")],
            ),
            "p2",
        );
        let got = reconcile(saved, &ids(&["a", "b"]));
        assert_eq!(got, layout(pane("p1", &["a", "b"], "b"), "p1"));
        let saved = layout(pane("p1", &["a", "b"], "b"), "p1");
        assert_eq!(
            reconcile(saved, &ids(&["a"])),
            layout(pane("p1", &["a"], "a"), "p1")
        );
    }

    #[test]
    fn a_new_tab_joins_the_pane_with_the_focus_and_a_lost_focus_goes_to_the_first_pane() {
        let saved = layout(
            split(
                Direction::Row,
                vec![pane("p1", &["a"], "a"), pane("p2", &["b"], "b")],
            ),
            "p2",
        );
        let got = reconcile(saved.clone(), &ids(&["a", "b", "c"]));
        assert_eq!(
            got,
            layout(
                split(
                    Direction::Row,
                    vec![pane("p1", &["a"], "a"), pane("p2", &["b", "c"], "b")]
                ),
                "p2"
            )
        );
        let lost = PaneLayout {
            focus: Some("nope".into()),
            ..saved
        };
        let got = reconcile(lost, &ids(&["a", "b", "c"]));
        assert_eq!(got.focus.as_deref(), Some("p1"));
        assert_eq!(panes(got.root.as_ref().unwrap())[0].1, ids(&["a", "c"]));
    }

    #[test]
    fn a_tab_in_two_panes_and_a_pane_id_used_twice_are_mended() {
        let saved = layout(
            split(
                Direction::Column,
                vec![pane("p1", &["a", "b"], "a"), pane("p1", &["b", "c"], "c")],
            ),
            "p1",
        );
        let got = reconcile(saved, &ids(&["a", "b", "c"]));
        assert_eq!(
            got,
            layout(
                split(
                    Direction::Column,
                    vec![pane("p1", &["a", "b"], "a"), pane("p2", &["c"], "c")]
                ),
                "p1"
            )
        );
    }

    #[test]
    fn a_layout_that_is_too_deep_or_too_big_is_made_again() {
        let mut root = pane("p1", &["a"], "a");
        for _ in 0..MAX_DEPTH + 1 {
            root = split(Direction::Row, vec![root, pane("p2", &["b"], "b")]);
        }
        let got = reconcile(layout(root, "p1"), &ids(&["a", "b"]));
        assert_eq!(got, layout(pane("p1", &["a", "b"], "a"), "p1"));
    }

    #[test]
    fn a_split_of_one_and_a_split_in_a_split_of_its_direction_are_flattened() {
        let tangled = split(
            Direction::Row,
            vec![
                split(
                    Direction::Row,
                    vec![pane("p1", &["a"], "a"), pane("p2", &["b"], "b")],
                ),
                split(Direction::Column, vec![pane("p3", &["c"], "c")]),
                pane("p4", &[], ""),
            ],
        );
        let got = normalize(tangled).unwrap();
        // The inner row had a third of the outer one, the column a third, and the empty pane's third is shared out.
        assert_eq!(
            got,
            sized(
                Direction::Row,
                vec![
                    pane("p1", &["a"], "a"),
                    pane("p2", &["b"], "b"),
                    pane("p3", &["c"], "c")
                ],
                &[0.25, 0.25, 0.5]
            )
        );
        assert_eq!(
            normalize(split(Direction::Row, vec![pane("p1", &[], "")])),
            None
        );
    }

    #[test]
    fn selecting_a_tab_shows_it_and_gives_its_pane_the_focus() {
        let saved = layout(
            split(
                Direction::Row,
                vec![pane("p1", &["a", "b"], "a"), pane("p2", &["c"], "c")],
            ),
            "p2",
        );
        let got = apply(saved.clone(), &PaneOp::Select { tab: "b".into() });
        assert_eq!(
            got,
            layout(
                split(
                    Direction::Row,
                    vec![pane("p1", &["a", "b"], "b"), pane("p2", &["c"], "c")]
                ),
                "p1"
            )
        );
        assert_eq!(
            apply(saved.clone(), &PaneOp::Select { tab: "zz".into() }),
            saved
        );
        assert_eq!(
            apply(saved.clone(), &PaneOp::Focus { pane: "p1".into() })
                .focus
                .as_deref(),
            Some("p1")
        );
        assert_eq!(
            apply(saved.clone(), &PaneOp::Focus { pane: "p9".into() }),
            saved
        );
    }

    #[test]
    fn a_tab_moved_to_the_right_or_bottom_edge_of_its_own_pane_splits_it() {
        let saved = layout(pane("p1", &["a", "b", "c"], "b"), "p1");
        let got = apply(saved.clone(), &mv("b", "p1", Edge::Right));
        assert_eq!(
            got,
            layout(
                split(
                    Direction::Row,
                    vec![pane("p1", &["a", "c"], "c"), pane("p2", &["b"], "b")]
                ),
                "p2"
            )
        );
        let got = apply(saved.clone(), &mv("c", "p1", Edge::Bottom));
        assert_eq!(
            got,
            layout(
                split(
                    Direction::Column,
                    vec![pane("p1", &["a", "b"], "b"), pane("p2", &["c"], "c")]
                ),
                "p2"
            )
        );
        let got = apply(saved, &mv("a", "p1", Edge::Left));
        assert_eq!(
            got.root,
            Some(split(
                Direction::Row,
                vec![pane("p2", &["a"], "a"), pane("p1", &["b", "c"], "b")]
            ))
        );
        let got = apply(
            layout(pane("p1", &["a", "b"], "a"), "p1"),
            &mv("b", "p1", Edge::Top),
        );
        assert_eq!(
            got.root,
            Some(split(
                Direction::Column,
                vec![pane("p2", &["b"], "b"), pane("p1", &["a"], "a")]
            ))
        );
    }

    #[test]
    fn a_tab_alone_in_its_pane_cannot_split_it_and_an_unknown_tab_or_pane_changes_nothing() {
        let saved = layout(pane("p1", &["a"], "a"), "p1");
        assert_eq!(apply(saved.clone(), &mv("a", "p1", Edge::Right)), saved);
        assert_eq!(apply(saved.clone(), &mv("zz", "p1", Edge::Right)), saved);
        assert_eq!(apply(saved.clone(), &mv("a", "p9", Edge::Right)), saved);
        assert_eq!(
            apply(PaneLayout::default(), &mv("a", "p1", Edge::Right)),
            PaneLayout::default()
        );
    }

    #[test]
    fn a_split_beside_a_split_of_the_same_direction_adds_a_pane_to_it_and_one_of_the_other_nests() {
        let two = layout(
            split(
                Direction::Row,
                vec![pane("p1", &["a", "b"], "a"), pane("p2", &["c"], "c")],
            ),
            "p1",
        );
        let got = apply(two.clone(), &mv("b", "p1", Edge::Right));
        // The new pane takes half of the pane it was split from, and the other pane keeps its size.
        assert_eq!(
            got.root,
            Some(sized(
                Direction::Row,
                vec![
                    pane("p1", &["a"], "a"),
                    pane("p3", &["b"], "b"),
                    pane("p2", &["c"], "c")
                ],
                &[0.25, 0.25, 0.5]
            ))
        );
        let got = apply(two, &mv("b", "p1", Edge::Bottom));
        assert_eq!(
            got.root,
            Some(split(
                Direction::Row,
                vec![
                    split(
                        Direction::Column,
                        vec![pane("p1", &["a"], "a"), pane("p3", &["b"], "b")]
                    ),
                    pane("p2", &["c"], "c")
                ]
            ))
        );
        assert_eq!(got.focus.as_deref(), Some("p3"));
    }

    #[test]
    fn a_tab_dragged_to_another_pane_edge_closes_the_pane_it_leaves_empty() {
        let saved = layout(
            split(
                Direction::Row,
                vec![pane("p1", &["a"], "a"), pane("p2", &["b", "c"], "b")],
            ),
            "p1",
        );
        let got = apply(saved, &mv("a", "p2", Edge::Bottom));
        assert_eq!(
            got,
            layout(
                split(
                    Direction::Column,
                    vec![pane("p2", &["b", "c"], "b"), pane("p3", &["a"], "a")]
                ),
                "p3"
            )
        );
    }

    #[test]
    fn a_tab_moved_to_the_center_joins_the_tabs_of_the_pane_and_the_pane_it_left_closes_when_empty()
    {
        let saved = layout(
            split(
                Direction::Row,
                vec![pane("p1", &["a"], "a"), pane("p2", &["b", "c"], "c")],
            ),
            "p1",
        );
        let got = apply(saved.clone(), &mv("a", "p2", Edge::Center));
        assert_eq!(got, layout(pane("p2", &["b", "c", "a"], "a"), "p2"));
        // Into its own pane: it is only shown.
        let got = apply(saved, &mv("b", "p2", Edge::Center));
        assert_eq!(got.focus.as_deref(), Some("p2"));
        assert_eq!(panes(got.root.as_ref().unwrap())[1].1, ids(&["b", "c"]));
    }

    #[test]
    fn the_tab_shown_after_one_leaves_is_the_next_else_the_previous() {
        let saved = layout(pane("p1", &["a", "b", "c"], "b"), "p1");
        let got = apply(saved.clone(), &mv("b", "p1", Edge::Right));
        assert_eq!(panes(got.root.as_ref().unwrap())[0].1, ids(&["a", "c"]));
        let saved = layout(pane("p1", &["a", "b", "c"], "c"), "p1");
        let got = apply(saved, &mv("c", "p1", Edge::Right));
        match got.root.unwrap() {
            PaneNode::Split { children, .. } => {
                assert_eq!(children[0], pane("p1", &["a", "b"], "b"))
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_layout_is_saved_for_each_project_and_target_and_comes_back() {
        let no = Handles::default();
        let dir = temp_dir("roundtrip");
        let live = ids(&["a", "b"]);
        let first = update(&dir, None, "proj", &live, &no, None).unwrap();
        assert_eq!(first, layout(pane("p1", &["a", "b"], "a"), "p1"));
        let split = update(
            &dir,
            None,
            "proj",
            &live,
            &no,
            Some(&mv("b", "p1", Edge::Right)),
        )
        .unwrap();
        // The same project of another target and another project are separate.
        let other = update(&dir, Some("Studio"), "proj", &live, &no, None).unwrap();
        assert_eq!(other, first);
        let other = update(&dir, None, "other", &ids(&["x"]), &no, None).unwrap();
        assert_eq!(other, layout(pane("p1", &["x"], "x"), "p1"));
        // Read again with no operation: what was saved.
        assert_eq!(update(&dir, None, "proj", &live, &no, None).unwrap(), split);
        let text = std::fs::read_to_string(dir.join(FILE)).unwrap();
        assert!(text.contains("\"version\": 1"), "{text}");
        assert!(!dir.join("orca-panes.json.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tabs_that_left_are_taken_out_of_the_saved_layout_and_a_project_with_none_leaves_no_entry() {
        let no = Handles::default();
        let dir = temp_dir("gone");
        let got = update(&dir, None, "proj", &ids(&["a", "b"]), &no, None).unwrap();
        assert!(matches!(got.root, Some(PaneNode::Pane { .. })));
        let got = update(
            &dir,
            None,
            "proj",
            &ids(&["a", "b"]),
            &no,
            Some(&mv("b", "p1", Edge::Right)),
        )
        .unwrap();
        assert!(matches!(got.root, Some(PaneNode::Split { .. })));
        let got = update(&dir, None, "proj", &ids(&["a"]), &no, None).unwrap();
        assert_eq!(got, layout(pane("p1", &["a"], "a"), "p1"));
        let got = update(&dir, None, "proj", &[], &no, None).unwrap();
        assert_eq!(got, PaneLayout::default());
        assert!(load(&dir).entries.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_broken_file_or_one_of_another_version_is_taken_as_empty_and_replaced() {
        let no = Handles::default();
        let dir = temp_dir("broken");
        std::fs::write(dir.join(FILE), "{ not json").unwrap();
        let got = update(&dir, None, "proj", &ids(&["a"]), &no, None).unwrap();
        assert_eq!(got, layout(pane("p1", &["a"], "a"), "p1"));
        assert_eq!(load(&dir).entries.len(), 1);
        std::fs::write(dir.join(FILE), r#"{"version":99,"entries":[]}"#).unwrap();
        assert!(load(&dir).entries.is_empty());
        std::fs::write(
            dir.join(FILE),
            r#"{"version":1,"entries":[{"environment":null,"project":"proj","layout":{"root":{"kind":"pane","id":"p1","tabs":["gone"],"selected":"gone"},"focus":"p1"}}]}"#,
        )
        .unwrap();
        let got = update(&dir, None, "proj", &ids(&["a"]), &no, None).unwrap();
        assert_eq!(got, layout(pane("p1", &["a"], "a"), "p1"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Claude and bash on the left, zsh alone on the right, with the right pane's tab shown and the focus.
    fn split_saved(right: &str) -> PaneLayout {
        layout(
            split(
                Direction::Row,
                vec![
                    pane("p1", &["claude:K", "orca:bash"], "claude:K"),
                    pane("p2", &[right], right),
                ],
            ),
            "p2",
        )
    }

    #[test]
    fn a_plain_terminal_where_claude_starts_keeps_its_pane_and_its_selection() {
        let live = ids(&["claude:K", "orca:bash", "claude:Z"]);
        let h = handles(
            &[
                ("claude:K", "term_k"),
                ("orca:bash", "bash"),
                ("claude:Z", "zsh"),
            ],
            &[],
        );
        let got = reconcile(
            follow_kind_switches(split_saved("orca:zsh"), &live, &h),
            &live,
        );
        assert_eq!(got, split_saved("claude:Z"));
    }

    #[test]
    fn claude_that_ends_in_its_terminal_keeps_its_pane_and_place_among_the_tabs() {
        let saved = layout(
            split(
                Direction::Row,
                vec![
                    pane("p1", &["orca:a", "claude:Z", "orca:b"], "claude:Z"),
                    pane("p2", &["orca:c"], "orca:c"),
                ],
            ),
            "p1",
        );
        let live = ids(&["orca:a", "orca:b", "orca:c", "orca:zsh"]);
        let h = handles(&[("orca:zsh", "zsh")], &[("claude:Z", "zsh")]);
        let got = reconcile(follow_kind_switches(saved, &live, &h), &live);
        let want = layout(
            split(
                Direction::Row,
                vec![
                    pane("p1", &["orca:a", "orca:zsh", "orca:b"], "orca:zsh"),
                    pane("p2", &["orca:c"], "orca:c"),
                ],
            ),
            "p1",
        );
        assert_eq!(got, want);
    }

    #[test]
    fn a_claude_tab_with_no_known_handle_and_a_tab_still_listed_are_not_followed() {
        let live = ids(&["claude:K", "orca:bash", "orca:zsh"]);
        let h = handles(&[("orca:zsh", "zsh")], &[]);
        // `claude:Z` was never seen with a handle, so it is only a tab that is gone.
        let saved = split_saved("claude:Z");
        let got = follow_kind_switches(saved.clone(), &live, &h);
        assert_eq!(got, saved);
        // The tab is still listed, so another one with its handle is not a successor.
        let live = ids(&["claude:K", "orca:bash", "claude:Z", "orca:zsh"]);
        let h = handles(
            &[("claude:Z", "zsh"), ("orca:zsh", "zsh")],
            &[("claude:Z", "zsh")],
        );
        let saved = split_saved("claude:Z");
        assert_eq!(follow_kind_switches(saved.clone(), &live, &h), saved);
    }

    #[test]
    fn a_tab_with_another_handle_or_one_the_layout_already_has_is_not_a_successor() {
        let live = ids(&["claude:K", "orca:bash", "claude:Z"]);
        let h = handles(&[("claude:Z", "other")], &[]);
        let saved = split_saved("orca:zsh");
        assert_eq!(follow_kind_switches(saved.clone(), &live, &h), saved);
        // `claude:K` is in the layout: it does not take the place of `orca:zsh`.
        let h = handles(&[("claude:K", "zsh")], &[]);
        assert_eq!(follow_kind_switches(saved.clone(), &live, &h), saved);
        assert_eq!(
            follow_kind_switches(PaneLayout::default(), &live, &h),
            PaneLayout::default()
        );
    }

    #[test]
    fn two_terminals_that_changed_kind_each_take_their_own_successor() {
        let saved = layout(pane("p1", &["orca:a", "orca:b"], "orca:b"), "p1");
        let live = ids(&["claude:B", "claude:A"]);
        let h = handles(&[("claude:A", "a"), ("claude:B", "b")], &[]);
        let got = reconcile(follow_kind_switches(saved, &live, &h), &live);
        assert_eq!(
            got,
            layout(pane("p1", &["claude:A", "claude:B"], "claude:B"), "p1")
        );
    }

    #[test]
    fn a_saved_layout_follows_the_terminal_that_changed_kind() {
        let dir = temp_dir("kind");
        let before = ids(&["claude:K", "orca:zsh"]);
        let h = handles(&[("claude:K", "term_k"), ("orca:zsh", "zsh")], &[]);
        update(&dir, None, "proj", &before, &h, None).unwrap();
        let split = update(
            &dir,
            None,
            "proj",
            &before,
            &h,
            Some(&mv("orca:zsh", "p1", Edge::Right)),
        )
        .unwrap();
        let now = ids(&["claude:K", "claude:Z"]);
        let h = handles(
            &[("claude:K", "term_k"), ("claude:Z", "zsh")],
            &[("claude:K", "term_k"), ("orca:zsh", "zsh")],
        );
        let got = update(&dir, None, "proj", &now, &h, None).unwrap();
        let PaneNode::Split { children, .. } = got.root.clone().unwrap() else {
            panic!("the split was folded: {got:?}");
        };
        assert_eq!(children.len(), 2);
        assert_eq!(got.focus, split.focus);
        assert_eq!(children[1], pane("p2", &["claude:Z"], "claude:Z"));
        assert_eq!(load(&dir).entries[0].layout, got);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_arguments_are_checked() {
        let no = Handles::default();
        let ok = ids(&["a"]);
        assert!(check(None, "proj", &ok, &no, None).is_ok());
        assert!(check(
            Some("Studio"),
            "proj",
            &ok,
            &no,
            Some(&mv("a", "p1", Edge::Left))
        )
        .is_ok());
        assert!(check(Some(""), "proj", &ok, &no, None).is_err());
        assert!(check(None, "", &ok, &no, None).is_err());
        assert!(check(None, "proj", &ids(&[""]), &no, None).is_err());
        assert!(check(None, "proj", &ids(&["a\nb"]), &no, None).is_err());
        assert!(check(None, &"x".repeat(MAX_TEXT + 1), &ok, &no, None).is_err());
        assert!(check(None, "proj", &vec!["t".to_owned(); MAX_TABS + 1], &no, None).is_err());
        assert!(check(
            None,
            "proj",
            &ok,
            &no,
            Some(&PaneOp::Select { tab: String::new() })
        )
        .is_err());
        assert!(check(
            None,
            "proj",
            &ok,
            &no,
            Some(&PaneOp::Focus {
                pane: String::new()
            })
        )
        .is_err());
        assert!(check(None, "proj", &ok, &no, Some(&mv("a", "", Edge::Left))).is_err());
        assert!(check(None, "proj", &ok, &no, Some(&resize("p1", "p2", 0.0))).is_ok());
        assert!(check(None, "proj", &ok, &no, Some(&resize("p1", "p2", 1.0))).is_ok());
        assert!(check(None, "proj", &ok, &no, Some(&resize("", "p2", 0.5))).is_err());
        assert!(check(None, "proj", &ok, &no, Some(&resize("p1", "", 0.5))).is_err());
        assert!(check(None, "proj", &ok, &no, Some(&resize("p1", "p2", f64::NAN))).is_err());
        assert!(check(None, "proj", &ok, &no, Some(&resize("p1", "p2", -0.1))).is_err());
        assert!(check(None, "proj", &ok, &no, Some(&resize("p1", "p2", 1.1))).is_err());
        assert!(check(
            None,
            "proj",
            &ok,
            &handles(&[("a", "h")], &[("b", "h")]),
            None
        )
        .is_ok());
        assert!(check(None, "proj", &ok, &handles(&[("a", "")], &[]), None).is_err());
        assert!(check(None, "proj", &ok, &handles(&[], &[("\n", "h")]), None).is_err());
        let many = (0..=MAX_TABS)
            .map(|n| (format!("t{n}"), "h".to_owned()))
            .collect();
        assert!(check(
            None,
            "proj",
            &ok,
            &Handles {
                now: many,
                was: HashMap::new()
            },
            None
        )
        .is_err());
    }

    #[test]
    fn the_shapes_are_tagged_in_camel_case() {
        let op: PaneOp =
            serde_json::from_str(r#"{"kind":"move","tab":"a","pane":"p1","edge":"bottom"}"#)
                .unwrap();
        assert_eq!(op, mv("a", "p1", Edge::Bottom));
        let json = serde_json::to_value(layout(
            split(
                Direction::Column,
                vec![pane("p1", &["a"], "a"), pane("p2", &["b"], "b")],
            ),
            "p1",
        ))
        .unwrap();
        assert_eq!(json["root"]["kind"], "split");
        assert_eq!(json["root"]["direction"], "column");
        assert_eq!(json["root"]["children"][0]["kind"], "pane");
        assert_eq!(json["root"]["sizes"], serde_json::json!([0.5, 0.5]));
        assert_eq!(json["focus"], "p1");
        let op: PaneOp =
            serde_json::from_str(r#"{"kind":"resize","before":"p1","after":"p2","share":0.25}"#)
                .unwrap();
        assert_eq!(op, resize("p1", "p2", 0.25));
    }

    /// Three panes side by side, a quarter, a quarter and a half.
    fn three() -> PaneLayout {
        layout(
            sized(
                Direction::Row,
                vec![
                    pane("p1", &["a"], "a"),
                    pane("p2", &["b"], "b"),
                    pane("p3", &["c"], "c"),
                ],
                &[0.25, 0.25, 0.5],
            ),
            "p1",
        )
    }

    #[test]
    fn a_divider_dragged_changes_the_two_nodes_beside_it_and_no_other() {
        // The second pane takes 0.2 of the 0.75 it has with the third.
        let got = apply(three(), &resize("p2", "p3", 0.2));
        assert!(close(&sizes_of(&got), &[0.25, 0.15, 0.6]), "{got:?}");
        assert_eq!(got.focus.as_deref(), Some("p1"));
        let got = apply(three(), &resize("p1", "p2", 0.5));
        assert_eq!(sizes_of(&got), vec![0.25, 0.25, 0.5]);
    }

    #[test]
    fn a_node_keeps_the_least_share_and_two_that_are_smaller_share_what_they_have() {
        let got = apply(three(), &resize("p2", "p3", 0.0));
        assert!(
            close(&sizes_of(&got), &[0.25, MIN_SHARE, 0.75 - MIN_SHARE]),
            "{got:?}"
        );
        let got = apply(three(), &resize("p2", "p3", 1.0));
        assert!(
            close(&sizes_of(&got), &[0.25, 0.75 - MIN_SHARE, MIN_SHARE]),
            "{got:?}"
        );
        // Two nodes with less than twice the least share between them are made equal.
        let narrow = layout(
            sized(
                Direction::Column,
                vec![
                    pane("p1", &["a"], "a"),
                    pane("p2", &["b"], "b"),
                    pane("p3", &["c"], "c"),
                ],
                &[0.03, 0.09, 0.88],
            ),
            "p1",
        );
        let got = apply(narrow, &resize("p1", "p2", 0.9));
        assert!(close(&sizes_of(&got), &[0.06, 0.06, 0.88]), "{got:?}");
    }

    #[test]
    fn a_divider_is_named_by_any_pane_on_each_side_and_one_that_is_not_there_changes_nothing() {
        // A column on the left of a pane: the divider of the row is between any pane of the column and p3.
        let nested = || {
            layout(
                split(
                    Direction::Row,
                    vec![
                        split(
                            Direction::Column,
                            vec![pane("p1", &["a"], "a"), pane("p2", &["b"], "b")],
                        ),
                        pane("p3", &["c"], "c"),
                    ],
                ),
                "p1",
            )
        };
        let got = apply(nested(), &resize("p2", "p3", 0.7));
        assert!(close(&sizes_of(&got), &[0.7, 0.3]), "{got:?}");
        // The divider inside the column.
        let got = apply(nested(), &resize("p1", "p2", 0.25));
        assert_eq!(sizes_of(&got), vec![0.5, 0.5]);
        match got.root.unwrap() {
            PaneNode::Split { children, .. } => match &children[0] {
                PaneNode::Split { sizes, .. } => assert!(close(sizes, &[0.25, 0.75]), "{sizes:?}"),
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
        // The wrong order, panes that are not beside each other, one pane twice, an unknown pane, a share that is no number, no split.
        assert_eq!(apply(three(), &resize("p2", "p1", 0.7)), three());
        assert_eq!(apply(three(), &resize("p1", "p3", 0.7)), three());
        assert_eq!(apply(three(), &resize("p1", "p1", 0.7)), three());
        assert_eq!(apply(three(), &resize("p1", "p9", 0.7)), three());
        assert_eq!(apply(three(), &resize("p9", "p2", 0.7)), three());
        assert_eq!(apply(three(), &resize("p1", "p2", f64::NAN)), three());
        let one = layout(pane("p1", &["a"], "a"), "p1");
        assert_eq!(apply(one.clone(), &resize("p1", "p1", 0.7)), one);
    }

    #[test]
    fn a_pane_that_closes_gives_its_share_to_the_rest_in_proportion() {
        let got = reconcile(three(), &ids(&["b", "c"]));
        assert!(close(&sizes_of(&got), &[1.0 / 3.0, 2.0 / 3.0]), "{got:?}");
        // A tab that moves out of its pane closes it too.
        let got = apply(three(), &mv("a", "p2", Edge::Center));
        assert!(close(&sizes_of(&got), &[1.0 / 3.0, 2.0 / 3.0]), "{got:?}");
    }

    #[test]
    fn a_new_pane_takes_half_of_the_pane_it_is_split_from() {
        let saved = layout(
            sized(
                Direction::Row,
                vec![pane("p1", &["a", "b"], "a"), pane("p2", &["c"], "c")],
                &[0.8, 0.2],
            ),
            "p1",
        );
        let got = apply(saved.clone(), &mv("b", "p1", Edge::Left));
        assert!(close(&sizes_of(&got), &[0.4, 0.4, 0.2]), "{got:?}");
        // The other direction nests: the outer shares stay, and the new split is halves.
        let got = apply(saved, &mv("b", "p1", Edge::Bottom));
        assert_eq!(sizes_of(&got), vec![0.8, 0.2]);
        match got.root.unwrap() {
            PaneNode::Split { children, .. } => match &children[0] {
                PaneNode::Split { sizes, .. } => assert_eq!(sizes, &vec![0.5, 0.5]),
                other => panic!("{other:?}"),
            },
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_split_merged_into_its_parent_gives_its_nodes_their_part_of_its_share() {
        let tangled = sized(
            Direction::Row,
            vec![
                sized(
                    Direction::Row,
                    vec![pane("p1", &["a"], "a"), pane("p2", &["b"], "b")],
                    &[0.25, 0.75],
                ),
                pane("p3", &["c"], "c"),
            ],
            &[0.4, 0.6],
        );
        match normalize(tangled).unwrap() {
            PaneNode::Split { sizes, .. } => assert!(close(&sizes, &[0.1, 0.3, 0.6]), "{sizes:?}"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn shares_that_are_missing_or_wrong_are_made_equal_and_others_are_scaled_to_one() {
        let two = |sizes: &[f64]| {
            sized(
                Direction::Row,
                vec![pane("p1", &["a"], "a"), pane("p2", &["b"], "b")],
                sizes,
            )
        };
        let shares = |sizes: &[f64]| match normalize(two(sizes)).unwrap() {
            PaneNode::Split { sizes, .. } => sizes,
            other => panic!("{other:?}"),
        };
        assert_eq!(shares(&[]), vec![0.5, 0.5]);
        assert_eq!(shares(&[1.0]), vec![0.5, 0.5]);
        assert_eq!(shares(&[0.2, 0.3, 0.5]), vec![0.5, 0.5]);
        assert_eq!(shares(&[0.0, 1.0]), vec![0.5, 0.5]);
        assert_eq!(shares(&[-0.5, 1.5]), vec![0.5, 0.5]);
        assert_eq!(shares(&[f64::NAN, 0.5]), vec![0.5, 0.5]);
        assert_eq!(shares(&[f64::INFINITY, 0.5]), vec![0.5, 0.5]);
        assert!(close(&shares(&[3.0, 1.0]), &[0.75, 0.25]));
        // Shares that are one already are kept as they are, so a read saves nothing.
        assert_eq!(shares(&[0.3, 0.7]), vec![0.3, 0.7]);
    }

    #[test]
    fn a_saved_file_with_no_shares_is_read_as_equal_and_a_ratio_comes_back() {
        let no = Handles::default();
        let dir = temp_dir("sizes");
        std::fs::write(
            dir.join(FILE),
            r#"{"version":1,"entries":[{"environment":null,"project":"proj","layout":{"root":{"kind":"split","direction":"row","children":[{"kind":"pane","id":"p1","tabs":["a"],"selected":"a"},{"kind":"pane","id":"p2","tabs":["b"],"selected":"b"}]},"focus":"p1"}}]}"#,
        )
        .unwrap();
        let live = ids(&["a", "b"]);
        let got = update(&dir, None, "proj", &live, &no, None).unwrap();
        assert_eq!(sizes_of(&got), vec![0.5, 0.5]);
        let got = update(
            &dir,
            None,
            "proj",
            &live,
            &no,
            Some(&resize("p1", "p2", 0.7)),
        )
        .unwrap();
        assert!(close(&sizes_of(&got), &[0.7, 0.3]), "{got:?}");
        // Read again with no operation: the ratio that was saved.
        assert_eq!(update(&dir, None, "proj", &live, &no, None).unwrap(), got);
        assert_eq!(load(&dir).entries[0].layout, got);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
