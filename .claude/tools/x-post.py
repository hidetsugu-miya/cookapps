"""The logic of x-post.sh: the X (Twitter) release post, in three commands (issue #754). Run through x-post.sh, which runs `python3 -I`.

auth  : by the owner, in front of the Mac Studio. Client ID and Client Secret come from the secret item, the browser asks for the owner's consent
        (OAuth 2.0 Authorization Code Flow with PKCE, S256), and the refresh token goes to the keychain.
check : reads the text of a post from a file or stdin and checks it mechanically. Exit 0, or exit 1 with one reason per line on stderr.
send  : `send file tag`. Refuses a tag that is not newer than .claude/x-posted of the main checkout (and the scheduled run of the x-post skill when that file is missing), before any network. Then the same check,
        refreshes the access token, writes the new refresh token back to the keychain, posts, and writes tag into .claude/x-posted. Exit 2 on a failure of the config, the secret item or the keychain, or of a token or of the post,
        exit 3 when the post got no answer (it may have been made; tag is written and the post is not sent again).

Sources (read on 2026-11-16):
  OAuth 2.0 Authorization Code Flow with PKCE (authorize URL, token endpoint, Basic authentication of a confidential client, refresh token):
    https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code.md
    https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/user-access-token.md
  POST /2/tweets: https://docs.x.com/x-api/posts/creation-of-a-post.md      GET /2/users/me: https://docs.x.com/x-api/users/get-my-user.md
  Weighted length: https://github.com/twitter/twitter-text/blob/master/config/v3.json

Where each value is: Client ID and Client Secret only in the secret item, which `op` reads with a service account (read only; the service account cannot write the vault); the refresh token, which X
replaces at every use, only in the keychain (service jp.mysis.tsunagiai.x, account refresh_token). Where the service account token, the vault and the item are is in .claude/x-post.json of the main checkout
(gitignored, publishing.md): {"op_token_keychain_service": ..., "op_vault": ..., "op_item": ...}. The service account token goes to `op` in OP_SERVICE_ACCOUNT_TOKEN.

A secret (service account token, client secret, refresh token, access token, authorization code) is never printed and never put in an argument of a command:
`op` gets the token in its environment, the keychain is written through the stdin of `security -i`, and HTTP goes through urllib (publishing.md, "Do not show secrets on screen or in logs").
"""

import base64
import getpass
import hashlib
import hmac
import http.client
import http.server
import json
import os
import re
import secrets
import socket
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SERVICE = "jp.mysis.tsunagiai.x"
CONFIG_KEYS = ("op_token_keychain_service", "op_vault", "op_item")
LABEL_CLIENT_ID = "クライアントID"
LABEL_CLIENT_SECRET = "クライアントシークレット"
OP_TIMEOUT_SECONDS = 60
REDIRECT_URI = "http://127.0.0.1:8765/callback"
AUTHORIZE_URL = "https://x.com/i/oauth2/authorize"
TOKEN_URL = "https://api.x.com/2/oauth2/token"
POST_URL = "https://api.x.com/2/tweets"
ME_URL = "https://api.x.com/2/users/me"
SCOPE = "tweet.read tweet.write users.read offline.access"
CALLBACK_WAIT_SECONDS = 300
HERE = Path(__file__).resolve().parent
TAG_RE = re.compile(r"v0\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")

# twitter-text config/v3.json
MAX_WEIGHTED = 280
SCALE = 100
DEFAULT_WEIGHT = 200
URL_LENGTH = 23
RANGES = [(0, 4351, 100), (8192, 8205, 100), (8208, 8223, 100), (8242, 8247, 100)]

URL_RE = re.compile(r"https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+", re.IGNORECASE)
BARE_DOMAIN_RE = re.compile(
    r"(?<![A-Za-z0-9_@./-])[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])"
)


class Fail(Exception):
    """A failure with the exit code to end with."""

    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


# ---- weighted length -------------------------------------------------------


def _is_pictograph(cp):
    return (
        0x1F000 <= cp <= 0x1FAFF
        or 0x2600 <= cp <= 0x27BF
        or 0x2300 <= cp <= 0x23FF
        or 0x2B00 <= cp <= 0x2BFF
    )


def _char_weight(cp):
    for start, end, weight in RANGES:
        if start <= cp <= end:
            return weight
    return DEFAULT_WEIGHT


def _emoji_end(text, i):
    """The end of the emoji sequence that starts at i, or i when none does (twitter-text counts one emoji sequence as DEFAULT_WEIGHT)."""
    n = len(text)
    cp = ord(text[i])
    if 0x1F1E6 <= cp <= 0x1F1FF and i + 1 < n and 0x1F1E6 <= ord(text[i + 1]) <= 0x1F1FF:
        return i + 2
    if text[i] in "0123456789#*":
        j = i + 1
        if j < n and ord(text[j]) == 0xFE0F:
            j += 1
        return j + 1 if j < n and ord(text[j]) == 0x20E3 else i
    if cp in (0xA9, 0xAE, 0x203C, 0x2049, 0x2122, 0x2139):
        return i + 2 if i + 1 < n and ord(text[i + 1]) == 0xFE0F else i
    if not _is_pictograph(cp):
        return i
    j = i + 1
    while True:
        while j < n and (ord(text[j]) in (0xFE0F, 0x20E3) or 0x1F3FB <= ord(text[j]) <= 0x1F3FF or 0xE0020 <= ord(text[j]) <= 0xE007F):
            j += 1
        if j + 1 < n and ord(text[j]) == 0x200D and _is_pictograph(ord(text[j + 1])):
            j += 2
            continue
        return j


def weighted_length(text):
    """The weighted length of twitter-text v3 (a URL is 23, a Japanese character is 2), as a number of characters."""
    text = unicodedata.normalize("NFC", text)
    total = 0
    pos = 0
    for m in URL_RE.finditer(text):
        total += _plain_weight(text[pos : m.start()]) + URL_LENGTH * SCALE
        pos = m.end()
    total += _plain_weight(text[pos:])
    return total / SCALE


def _plain_weight(text):
    total = 0
    i = 0
    while i < len(text):
        end = _emoji_end(text, i)
        if end > i:
            total += DEFAULT_WEIGHT
            i = end
        else:
            total += _char_weight(ord(text[i]))
            i += 1
    return total


# ---- check -----------------------------------------------------------------


def repo_slug():
    out = subprocess.run(["git", "-C", str(HERE), "remote", "get-url", "origin"], capture_output=True, text=True)
    m = re.search(r"github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?$", out.stdout.strip()) if out.returncode == 0 else None
    return (m.group(1), m.group(2)) if m else None


def main_checkout():
    common = subprocess.run(
        ["git", "-C", str(HERE), "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True, text=True
    )
    if common.returncode != 0:
        raise Fail("メインのチェックアウトを求められない", 1)
    return Path(common.stdout.strip()).parent


def guard_public_lines(text):
    """The line numbers (of the text) where guard-public.sh finds a forbidden word. Its stderr names the word, so only the numbers are kept."""
    guard = main_checkout() / ".claude" / "hooks" / "guard-public.sh"
    run = subprocess.run([str(guard), "text"], input=text, capture_output=True, text=True)
    if run.returncode == 0:
        return []
    lines = [int(n) for n in re.findall(r"^stdin:(\d+):", run.stderr, re.MULTILINE)]
    if not lines:
        raise Fail("guard-public.sh text が失敗した（禁止語の判定ができない）", 1)
    return lines


def check_text(text):
    """The reasons the text cannot be posted, one string each; an empty list is a pass."""
    reasons = []
    if not text.strip():
        return ["文面が空"]
    slug = repo_slug()
    length = weighted_length(text)
    if length > MAX_WEIGHTED:
        reasons.append(f"重み付き文字数が {length:g} で、{MAX_WEIGHTED} を超えている")
    for n in guard_public_lines(text):
        reasons.append(f"{n} 行目に公開禁止語がある")
    if "@" in text or "＠" in text:
        reasons.append("@ を含む（メンションは付けない）")
    urls = URL_RE.findall(text)
    rest = URL_RE.sub(" ", text)
    domains = BARE_DOMAIN_RE.findall(rest)
    if len(urls) + len(domains) != 1:
        reasons.append(f"URL がちょうど 1 つでない（{len(urls) + len(domains)} 個。ドメイン形式の語も数える）")
    elif domains:
        reasons.append("URL が https:// で始まっていない")
    elif slug is None:
        reasons.append("git の origin から {owner}/{repo} を求められないので、URL を確かめられない")
    else:
        owner, repo = (re.escape(p) for p in slug)
        if not re.fullmatch(rf"https://github\.com/{owner}/{repo}/releases(?:/tag/v[0-9A-Za-z._-]+)?", urls[0]):
            reasons.append("URL が https://github.com/{owner}/{repo}/releases（または releases/tag/v…）でない")
    return reasons


def read_text(args):
    try:
        raw = Path(args[0]).read_bytes() if args else sys.stdin.buffer.read()
        return raw.decode("utf-8").strip()
    except (OSError, UnicodeDecodeError):
        raise Fail("文面を読めない（ファイルがないか、UTF-8 でない）", 1)


# ---- secret store (op) -----------------------------------------------------


def op_config():
    """The three names of .claude/x-post.json. A missing file or a wrong shape ends with exit 2, before any network."""
    path = main_checkout() / ".claude" / "x-post.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise Fail(".claude/x-post.json を読めない（ファイルがないか、JSON でない）。メインのチェックアウトに置く", 2)
    if not isinstance(data, dict) or not all(isinstance(data.get(k), str) and data[k] for k in CONFIG_KEYS):
        raise Fail(".claude/x-post.json の形が違う（" + ", ".join(CONFIG_KEYS) + " の 3 つの文字列が要る）", 2)
    return {k: data[k] for k in CONFIG_KEYS}


def op_environment(config):
    """The environment of `op`: the service account token read from the keychain. It is in no argument and in no output."""
    run = subprocess.run(
        ["security", "find-generic-password", "-a", getpass.getuser(), "-s", config["op_token_keychain_service"], "-w"], capture_output=True, text=True
    )
    token = run.stdout.rstrip("\n")
    if run.returncode != 0 or not token:
        raise Fail("キーチェーンからサービスアカウントトークンを読めなかった", 2)
    return {**os.environ, "OP_SERVICE_ACCOUNT_TOKEN": token}


def op_run(config, args):
    """Runs `op` and returns its stdout. Its stderr is dropped: a failure is only its exit code."""
    try:
        run = subprocess.run(["op", *args], capture_output=True, text=True, env=op_environment(config), timeout=OP_TIMEOUT_SECONDS)
    except FileNotFoundError:
        raise Fail("op コマンドが見つからない", 2)
    except (OSError, subprocess.TimeoutExpired):
        raise Fail("op を実行できなかった（または応答がなかった）", 2)
    if run.returncode != 0:
        raise Fail(f"op が失敗した（exit {run.returncode}）", 2)
    return run.stdout


def op_item(config):
    """The secret item as the JSON of `op item get`."""
    out = op_run(config, ["item", "get", config["op_item"], "--vault", config["op_vault"], "--format", "json"])
    try:
        item = json.loads(out)
    except ValueError:
        raise Fail("op item get の出力が JSON でない", 2)
    if not isinstance(item, dict) or not isinstance(item.get("fields"), list):
        raise Fail("op item get の出力に fields がない", 2)
    return item


def field_value(item, label):
    """The value of the first field with the label, or None when there is none or it is empty."""
    for field in item["fields"]:
        if isinstance(field, dict) and field.get("label") == label:
            value = field.get("value")
            return value if isinstance(value, str) and value else None
    return None


def op_client(config):
    """(client ID, client secret) of the item; a missing one ends with exit 2."""
    item = op_item(config)
    client_id, client_secret = field_value(item, LABEL_CLIENT_ID), field_value(item, LABEL_CLIENT_SECRET)
    missing = [label for label, value in ((LABEL_CLIENT_ID, client_id), (LABEL_CLIENT_SECRET, client_secret)) if not value]
    if missing:
        raise Fail("アイテムに X の認証情報がない（" + ", ".join(missing) + "）", 2)
    return client_id, client_secret


# ---- keychain (the refresh token) ------------------------------------------


def keychain_get(account):
    run = subprocess.run(["security", "find-generic-password", "-s", SERVICE, "-a", account, "-w"], capture_output=True, text=True)
    value = run.stdout.rstrip("\n")
    return value if run.returncode == 0 and value else None


def keychain_set(account, value):
    """Writes through the stdin of `security -i`, so the value is in no argument; then reads it back, because `-i` can exit 0 after a failed command."""

    if not value.isascii() or not value.isprintable():
        # `security -w` prints a value that is not plain ASCII in hex, so it could not be read back
        raise Fail(f"{account} が ASCII の印字できる文字だけの値でない", 2)

    def quote(s):
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'

    command = f"add-generic-password -U -s {quote(SERVICE)} -a {quote(account)} -w {quote(value)}\n"
    run = subprocess.run(["security", "-i"], input=command, capture_output=True, text=True)
    if run.returncode != 0 or not hmac.compare_digest((keychain_get(account) or "").encode(), value.encode()):
        raise Fail(f"キーチェーンの {account} を書けなかった", 2)


# ---- HTTP ------------------------------------------------------------------


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """A 30x is a failure: urllib would send the Authorization header to the place it points to."""

    def redirect_request(self, *args, **kwargs):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def request_json(method, url, headers, body=None):
    """(status, parsed JSON or None). Status -1: the request never left (no name, connection refused). Status 0: no answer after it may have left."""
    request = urllib.request.Request(url, data=body, method=method, headers={"User-Agent": "tsunagiai-x-post", **headers})
    try:
        with OPENER.open(request, timeout=30) as response:
            status, raw = response.status, response.read()
    except urllib.error.HTTPError as e:
        try:
            status, raw = e.code, e.read()
        except (OSError, http.client.HTTPException):
            status, raw = e.code, b""
    except urllib.error.URLError as e:
        return (-1 if isinstance(e.reason, (socket.gaierror, ConnectionRefusedError)) else 0), None
    except (TimeoutError, OSError, http.client.HTTPException):
        return 0, None
    try:
        data = json.loads(raw)
    except ValueError:
        data = None
    return status, data if isinstance(data, dict) else None


def fail_http(what, status, data):
    """Only the HTTP status and the kind of error X returned, cut to harmless characters (never the body)."""
    kind = ""
    if data:
        for key in ("error", "title", "type"):
            if isinstance(data.get(key), str):
                kind = re.sub(r"[^A-Za-z0-9_:/. -]", "", data[key])[:100]
                break
    if status <= 0:
        raise Fail(f"{what}に失敗した: 通信できなかった", 2)
    raise Fail(f"{what}に失敗した: HTTP {status}" + (f"（{kind}）" if kind else ""), 2)


def token_request(client_id, client_secret, fields, what):
    basic = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    status, data = request_json(
        "POST",
        TOKEN_URL,
        {"Authorization": f"Basic {basic}", "Content-Type": "application/x-www-form-urlencoded"},
        urllib.parse.urlencode(fields).encode(),
    )
    if status != 200 or not data or not isinstance(data.get("access_token"), str) or not isinstance(data.get("refresh_token"), str):
        fail_http(what, status, data)
    return data["access_token"], data["refresh_token"]


# ---- auth ------------------------------------------------------------------


def wait_for_callback(state):
    """Takes the one request of /callback and returns its code. Nothing of the request is logged: its query holds the code."""
    result = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            url = urllib.parse.urlsplit(self.path)
            if url.path != "/callback":
                self.send_error(404)
                return
            query = urllib.parse.parse_qs(url.query)
            got_state = (query.get("state") or [""])[0]
            if not hmac.compare_digest(got_state.encode(), state.encode()):
                result["error"] = "state が一致しない"
            elif "error" in query:
                result["error"] = "X が認可を断った: " + re.sub(r"[^A-Za-z0-9_ -]", "", query["error"][0])[:50]
            elif query.get("code"):
                result["code"] = query["code"][0]
            else:
                result["error"] = "認可コードが付いていない"
            page = "<!doctype html><meta charset=utf-8><title>つなぎAI</title><p>" + (
                "受け取りました。このタブは閉じてかまいません。" if "code" in result else "失敗しました。ターミナルを見てください。"
            )
            self.send_response(200 if "code" in result else 400)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(page.encode())

        def log_message(self, *args):
            pass

    try:
        server = http.server.HTTPServer(("127.0.0.1", 8765), Handler)
    except OSError:
        raise Fail("127.0.0.1:8765 を開けない（別のプロセスが使っている）", 1)
    server.timeout = 1
    return server, result


def auth():
    config = op_config()
    client_id, client_secret = op_client(config)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(32)
    server, result = wait_for_callback(state)
    query = urllib.parse.urlencode(
        {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": REDIRECT_URI,
            "scope": SCOPE,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        },
        quote_via=urllib.parse.quote,
    )
    url = f"{AUTHORIZE_URL}?{query}"
    print("ブラウザで X の許可画面を開く。許可を押す。開かないときは次の URL を開く。")
    print(url)
    subprocess.run(["open", url], check=True)
    deadline = time.monotonic() + CALLBACK_WAIT_SECONDS
    while not result and time.monotonic() < deadline:
        server.handle_request()
    server.server_close()
    if "error" in result:
        raise Fail(result["error"], 1)
    if "code" not in result:
        raise Fail(f"{CALLBACK_WAIT_SECONDS} 秒待ったが認可を受け取れなかった", 1)
    # the code lives 30 seconds: exchange it before anything else
    access, refresh = token_request(
        client_id,
        client_secret,
        {"grant_type": "authorization_code", "code": result["code"], "redirect_uri": REDIRECT_URI, "code_verifier": verifier},
        "トークンの取得",
    )
    keychain_set("refresh_token", refresh)
    status, data = request_json("GET", ME_URL, {"Authorization": f"Bearer {access}"})
    user = data.get("data", {}).get("username") if data and isinstance(data.get("data"), dict) else None
    if isinstance(user, str) and re.fullmatch(r"[A-Za-z0-9_]{1,15}", user):
        print(f"キーチェーンに入れた。投稿先: @{user}")
    else:
        print("キーチェーンに入れた。投稿先のユーザー名は取れなかった")


# ---- send ------------------------------------------------------------------


def posted_file():
    return main_checkout() / ".claude" / "x-posted"


def parse_tag(text):
    m = TAG_RE.fullmatch(text)
    return (int(m.group(1)), int(m.group(2))) if m else None


def check_tag(tag):
    """Refuses, before any network, a tag that is not newer than the last posted one, and a scheduled run with no record of it."""
    new = parse_tag(tag)
    if new is None:
        raise Fail("タグが v0.{minor}.{patch} の形でない", 1)
    path = posted_file()
    try:
        last = parse_tag(path.read_text(encoding="utf-8").strip())
    except FileNotFoundError:
        if os.environ.get("X_POST_SCHEDULED"):
            raise Fail(".claude/x-posted がない定期実行は投稿しない（初回はオーナーが端末で send を手で実行する）", 1)
        return
    except (OSError, UnicodeDecodeError):
        raise Fail(".claude/x-posted を読めない", 1)
    if last is None:
        raise Fail(".claude/x-posted が v0.{minor}.{patch} の 1 行でない", 1)
    if new <= last:
        raise Fail(f"{tag} は .claude/x-posted の版より新しくない", 1)


def record_posted(tag, state):
    """Writes the tag through a temporary file and mv. state says what is known of the post, for the message of a failure."""
    path = posted_file()
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(tag + "\n", encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        raise Fail(f"{state}が、.claude/x-posted に {tag} を書けなかった。X で確かめて、手で書く", 2)


def send(args):
    file, tag = args
    check_tag(tag)
    text = read_text([file])
    reasons = check_text(text)
    if reasons:
        raise Fail("\n".join(reasons), 1)
    config = op_config()
    old_refresh = keychain_get("refresh_token")
    if not old_refresh:
        raise Fail("キーチェーンに X の refresh_token がない。auth を実行する", 2)
    client_id, client_secret = op_client(config)
    access, refresh = token_request(client_id, client_secret, {"grant_type": "refresh_token", "refresh_token": old_refresh}, "アクセストークンの取り直し")
    try:
        keychain_set("refresh_token", refresh)
    except Fail:
        raise Fail("新しいリフレッシュトークンをキーチェーンに書けなかったので、投稿しない。古いものは使えなくなった可能性があり、auth のやり直しが要る", 2)
    status, data = request_json(
        "POST", POST_URL, {"Authorization": f"Bearer {access}", "Content-Type": "application/json"}, json.dumps({"text": text}).encode()
    )
    if status == 0:
        # no answer: the post may have been made, so it is recorded and never sent again
        record_posted(tag, "投稿の応答がなく、投稿されたかもしれない")
        raise Fail(f"投稿の応答がなかった。投稿されたかもしれないので、{tag} を .claude/x-posted に書いた。再送しない。X で投稿を確かめる", 3)
    if status != 201:
        fail_http("投稿", status, data)
    post_id = data.get("data", {}).get("id") if data and isinstance(data.get("data"), dict) else None
    has_id = isinstance(post_id, str) and re.fullmatch(r"[0-9]+", post_id) is not None
    if has_id:
        print(f"https://x.com/i/web/status/{post_id}")
    record_posted(tag, "投稿は済んでいる")
    if not has_id:
        raise Fail("投稿は受け付けられたが、応答に投稿の ID がなかった。X で確かめる", 2)


USAGE = "使い方: x-post.sh auth | check [file] | send file tag   （check は file を省くと標準入力から文面を読む。tag は v0.{minor}.{patch}）"


def main(argv):
    cmd = argv[0] if argv else ""
    if (cmd == "auth" and len(argv) != 1) or (cmd == "check" and len(argv) > 2) or (cmd == "send" and len(argv) != 3) or cmd not in ("auth", "check", "send"):
        print(USAGE, file=sys.stderr)
        return 64
    try:
        if cmd == "auth":
            auth()
        elif cmd == "check":
            reasons = check_text(read_text(argv[1:]))
            if reasons:
                raise Fail("\n".join(reasons), 1)
        else:
            send(argv[1:])
    except Fail as e:
        print(str(e), file=sys.stderr)
        return e.code
    except KeyboardInterrupt:
        print("中断した", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
