#!/usr/bin/env python3
"""formal-scope: the manifests of a repository's formal checks (`verification/formal/{area}/manifest.json`).

  python3 -I formal-scope.py validate --manifest {path}
  python3 -I formal-scope.py list --repo-root {absolute path}
  python3 -I formal-scope.py rerun --repo-root {absolute path} --input {path}

The shape of the manifest, the output of each command and the exit codes are in
references/implement/formal-verification.md ("The manifest" and "formal-scope").
Exit 0: the answer is on stdout. Exit 1: a usage error or an invalid manifest. Exit 2: git failed.
"""

import json
import posixpath
import subprocess
import sys
from pathlib import Path

MANIFEST_KEYS = ["properties", "target_paths", "tool", "bound", "assumptions", "out_of_scope", "command"]


def say(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")


def usage(reason):
    say({"status": "usage", "reason": reason})
    sys.exit(1)


def failed(reason):
    say({"status": "failed", "reason": reason})
    sys.exit(2)


def text_ok(value):
    return isinstance(value, str) and value.strip() != ""


def check_path(value, where, problems):
    if not text_ok(value):
        problems.append(f"{where} must be a non-empty string")
    elif value.startswith("/") or ".." in value.split("/"):
        problems.append(f'{where} must be a repository-relative path without "..": {json.dumps(value)}')


def check_object(value, where, keys, problems):
    """True when `value` is an object holding exactly `keys`."""
    if not isinstance(value, dict):
        problems.append(f"{where} must be an object")
        return False
    for k in value:
        if k not in keys:
            problems.append(f"{where}/{k} is an unknown key")
    for k in keys:
        if k not in value:
            problems.append(f"{where}/{k} is required")
    return all(k in value for k in keys) and all(k in keys for k in value)


def manifest_problems(data):
    problems = []
    if not check_object(data, "", MANIFEST_KEYS, problems):
        return problems
    props = data["properties"]
    if not isinstance(props, list) or not props:
        problems.append("/properties must be an array of at least one property")
    else:
        for i, p in enumerate(props):
            if check_object(p, f"/properties/{i}", ["id", "statement", "harm"], problems):
                for k in ("id", "statement", "harm"):
                    if not text_ok(p[k]):
                        problems.append(f"/properties/{i}/{k} must be a non-empty string")
    targets = data["target_paths"]
    if not isinstance(targets, list) or not targets:
        problems.append("/target_paths must be an array of at least one path")
    else:
        for i, t in enumerate(targets):
            check_path(t, f"/target_paths/{i}", problems)
    if check_object(data["tool"], "/tool", ["name", "version"], problems):
        for k in ("name", "version"):
            if not text_ok(data["tool"][k]):
                problems.append(f"/tool/{k} must be a non-empty string")
    for k in ("bound", "command"):
        if not text_ok(data[k]):
            problems.append(f"/{k} must be a non-empty string")
    for k in ("assumptions", "out_of_scope"):
        v = data[k]
        if not isinstance(v, list) or not all(isinstance(x, str) for x in v):
            problems.append(f"/{k} must be an array of strings")
    return problems


def read_manifest(path):
    """(manifest or None, problem or None)."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except OSError as e:
        return None, f"is not readable: {e.strerror or e}"
    except ValueError as e:
        return None, f"is not a valid manifest: {e}"
    problems = manifest_problems(data)
    return (data, None) if not problems else (None, "; ".join(problems))


def areas(repo):
    """Every area with a manifest, in order of name: [(area, manifest path)]."""
    base = Path(repo) / "verification" / "formal"
    if not base.is_dir():
        return []
    return [(d.name, str(d / "manifest.json")) for d in sorted(base.iterdir()) if (d / "manifest.json").is_file()]


def load_all(repo):
    """Validate every manifest. On a problem, print the invalid answer and exit 1."""
    loaded, problems = [], []
    for area, path in areas(repo):
        data, problem = read_manifest(path)
        if problem:
            problems.append({"area": area, "manifest_path": path, "problem": problem})
        else:
            loaded.append((area, path, data))
    if problems:
        say({"status": "invalid", "problems": problems})
        sys.exit(1)
    return loaded


def git(repo, *args):
    try:
        done = subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, check=False)
    except OSError as e:
        failed(f"git cannot run: {e}")
    if done.returncode != 0:
        failed(f"git {' '.join(args)} failed: {done.stderr.strip()}")
    return done.stdout


def clean(path):
    return posixpath.normpath(path)


def inside(path, target):
    return target == "." or path == target or path.startswith(target + "/")


def cmd_validate(args):
    if len(args) != 2 or args[0] != "--manifest":
        usage("validate takes --manifest {path}")
    path = args[1]
    _, problem = read_manifest(path)
    if problem:
        say({"status": "invalid", "problems": [{"area": Path(path).parent.name, "manifest_path": path, "problem": problem}]})
        sys.exit(1)
    say({"status": "ok", "manifest_path": path})


def cmd_list(args):
    if len(args) != 2 or args[0] != "--repo-root":
        usage("list takes --repo-root {absolute path}")
    repo = args[1]
    loaded = load_all(repo)
    out = []
    if loaded:
        git(repo, "rev-parse", "--git-dir")
    for area, path, data in loaded:
        commit = git(repo, "log", "-1", "--format=%H", "--", f"verification/formal/{area}").strip()
        if commit:
            changed = set()
            for extra in ([], ["--cached"]):
                changed.update(git(repo, "diff", "--name-only", "--no-renames", "--relative", *extra, commit).splitlines())
            changed.update(git(repo, "ls-files", "--others", "--exclude-standard").splitlines())
            hit = [t for t in data["target_paths"] if any(inside(clean(c), clean(t)) for c in changed)]
        else:
            hit = list(data["target_paths"])
        if hit:
            out.append({"area": area, "manifest_path": path, "last_asset_commit": commit, "changed_targets": hit})
    say(out)


def cmd_rerun(args):
    flags = dict(zip(args[::2], args[1::2]))
    if len(args) != 4 or set(flags) != {"--repo-root", "--input"}:
        usage("rerun takes --repo-root {absolute path} and --input {path}")
    try:
        given = json.loads(Path(flags["--input"]).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        usage(f"--input cannot be read: {e}")
    if not isinstance(given, dict) or set(given) != {"changed_paths", "properties"}:
        usage("--input must be an object with changed_paths and properties")
    changed, props = given["changed_paths"], given["properties"]
    if not isinstance(changed, list) or not isinstance(props, list):
        usage("changed_paths and properties must be arrays")
    for p in changed:
        if not text_ok(p) or p.startswith("/") or ".." in p.split("/"):
            usage(f"changed_paths holds a path that is not repository-relative: {json.dumps(p)}")
    for p in props:
        if not isinstance(p, dict) or not text_ok(p.get("target")) or p["target"].startswith("/") or ".." in p["target"].split("/"):
            usage("each property needs a repository-relative target")
    changed = [clean(p) for p in changed]
    reasons = []
    for area, _, data in load_all(flags["--repo-root"]):
        paths = []
        for c in changed:
            if c not in paths and any(inside(c, clean(t)) for t in data["target_paths"]):
                paths.append(c)
        if paths:
            reasons.append({"kind": "area-target", "area": area, "paths": paths})
    for p in props:
        if not p.get("area"):
            reasons.append({"kind": "property-without-area", "target": p["target"]})
        paths = []
        for c in changed:
            if c not in paths and inside(c, clean(p["target"])):
                paths.append(c)
        if paths:
            reasons.append({"kind": "property-target", "target": p["target"], "paths": paths})
    say({"rerun": bool(reasons), "reasons": reasons})


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("validate", "list", "rerun"):
        usage("the command is validate, list or rerun")
    {"validate": cmd_validate, "list": cmd_list, "rerun": cmd_rerun}[sys.argv[1]](sys.argv[2:])


main()
