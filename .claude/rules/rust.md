---
paths:
  - "src-tauri/src/**/*.rs"
  - "src-tauri/Cargo.toml"
---

# Rust backend rules

## Tools

### Run cargo through `mise exec --`

Rust is managed by mise, and cargo is not on the PATH.

```sh
cd src-tauri && mise exec -- cargo test --all-features
```

### Pass fmt, clippy and test before you commit

`run-ci.sh` runs the same three before a push (`pre-git.sh` then checks its record), and clippy turns warnings into errors (`testing.md`).
`cargo test` writes the ts-rs types to `ts/bindings/`, so when a type changes, commit the generated files with it.

```sh
mise exec -- cargo fmt --check
mise exec -- cargo clippy --all-targets --all-features -- -D warnings
mise exec -- cargo test --all-features
```

## Where Tauri commands live

### Write a new command in the service module, and register it in `lib.rs` and `ipc.ts`

Put a command in the module of the service it handles (`gmail.rs`, `calendar.rs`, `todoist.rs`, `slack.rs`, and so on).
Then add it to `generate_handler!` in `invoke_handler` in `src-tauri/src/lib.rs`, add its argument and return types to `Commands` in `ts/ipc.ts`, and add its answer to `fixtures.js` or a spec for E2E (`e2e.md`).
If you forget `lib.rs`, you learn "no such command" only when the screen calls it. Without `ipc.ts` and the E2E answer, the types and tests on the screen side do not pass.

```rust
// Good: the module owns it, lib.rs lists it
// calendar.rs
#[tauri::command]
pub async fn example_week(id: String) -> Result<Option<Week>, String> { /* … */ }
// lib.rs: generate_handler![ …, calendar::example_week ]
```

### Put the ts-rs derive on a struct returned to the screen

Put `#[derive(TS)]` and `#[ts(export, export_to = crate::BINDINGS)]` on the return value and on the structs inside it.
The TS types are generated from the structs, so nobody has to chase shape mismatches by hand (`testing.md`).

```rust
#[derive(Serialize, TS)]
#[ts(export, export_to = crate::BINDINGS)]
pub struct Item {
    pub id: String,
}
```

## Tauri command return values

### Return `None` when the user must log in again

When the frontend receives `null`, it reloads the list and shows the re-login row.

```rust
#[tauri::command]
async fn example(id: String) -> Result<Option<Item>, String> {
    // None: the account must log in again
}
```

### Return a success with no value as `Some(true)`

`Some(())` reaches JS as `null`, which cannot be told apart from `None` (re-login needed).

```rust
// Good
Ok(done.map(|_| true))
// Bad: reaches JS as null
Ok(done.map(|_| ()))
```

### Make errors shown in the UI Japanese strings

An error is shown on the screen as it is.
The app's UI text is Japanese, so keep these strings in Japanese.

```rust
.ok_or("認証に失敗しました")?
```

## Gmail API

### Add `Content-Length: 0` to a POST with no body

Without it, Gmail returns 411 Length Required.

```rust
let req = client.post(url).header(CONTENT_LENGTH, 0);
```

## Tests

### Extract decisions into pure functions and unit-test them, with no mocks

Put the logic you want to test in a pure function cut off from HTTP and `AppHandle`. Do not put it in the screen-side TS (`testing.md`).
If you mock HTTP or the keychain, a test can pass while the real thing fails because of the gap.
To test an HTTP branch, use a local `TcpListener`, not a mock library.

```rust
fn parse(json: &Value) -> Item { /* pure */ }

#[test]
fn parses_subject() {
    assert_eq!(parse(&json!({"subject": "a"})).subject, "a");
}
```
