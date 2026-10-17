#!/usr/bin/env python3
"""Rewrite real tokitoki JSON output into a committable e2e fixture.

Usage (from the repo root):
    tokitoki widget-payload --cached --json > /tmp/payload.raw
    tokitoki sessions --cached --last month --top 25 --json > /tmp/sessions.raw
    python3 e2e/fixtures/anonymize.py /tmp/payload.raw e2e/fixtures/payload.json
    python3 e2e/fixtures/anonymize.py /tmp/sessions.raw e2e/fixtures/sessions.json

Rewrites account emails, repository and project names, session IDs, titles,
snippets, and conversation bodies. Provider IDs, model names, windows, dates,
and token counts remain to exercise the widget's real rendering paths.
"""

import hashlib
import json
import re
import sys

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+")

REPO_MAP = {
    "Documents/Voxy + Voxy Server for 1.21.1": "Documents/Aurora Server",
    "Documents/ChatGPT/Minecraft Schematic Generator": "Documents/Minecraft Schematic Generator",
    ".nixfiles": "dotfiles",
}

# Public/neutral names that are fine to keep; anything else in a repo slot gets
# renumbered, so a new private project can never leak by being forgotten here.
REPO_ALLOW = {"lab/tokitoki", "(no repo)"}

# Snippet bodies quote real conversations. Keep the shape (the widget splits on
# the markers and truncates), drop the content.
SNIPPET = "### User · 2026-01-01 00:00:00 e2e fixture prompt ### Assistant · 2026-01-01 00:00:01"

# Keys whose string values are repo/project names.
REPO_KEYS = {"repos", "repoNames", "repository"}
# Cards where a "bucket" is a repo/project name rather than a date.
REPO_CARDS = {"reposMonth", "repoHistory"}


def is_repo_slot(path):
    """path is the list of keys from the document root down to this value."""
    if not path:
        return False
    if path[-1] in REPO_KEYS:
        return True
    # The card name can be several levels up: reposMonth.rows[].bucket.
    return path[-1] == "bucket" and any(step in REPO_CARDS for step in path)


def collect_repos(data):
    names = set()

    def walk(node, path):
        if isinstance(node, dict):
            for child_key, child in node.items():
                walk(child, path + [child_key])
        elif isinstance(node, list):
            for item in node:
                walk(item, path)
        elif isinstance(node, str) and is_repo_slot(path):
            names.add(node)

    walk(data, [])
    mapping = {}
    for name in sorted(names):
        if name not in REPO_ALLOW:
            mapping[name] = "project-%d" % (len(mapping) + 1)
    return mapping


def scrub(value, path=None, repo_map=None):
    path = path or []
    if isinstance(value, dict):
        return {child_key: scrub(child, path + [child_key], repo_map) for child_key, child in value.items()}
    if isinstance(value, list):
        return [scrub(item, path, repo_map) for item in value]
    if isinstance(value, str):
        if is_repo_slot(path):
            return repo_map.get(value, value)
        key = path[-1] if path else None
        text = EMAIL.sub("dev@example.com", value)
        for raw, replacement in REPO_MAP.items():
            text = text.replace(raw, replacement)
        if key == "title":
            return "e2e fixture session"
        if key == "snippet":
            return SNIPPET
        if key == "sessionId":
            digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]
            return "e2e-" + digest
        if key == "body" and "conversation" in path:
            return "Synthetic e2e conversation body."
        return text
    return value


def main():
    source, target = sys.argv[1], sys.argv[2]
    with open(source) as handle:
        data = json.load(handle)
    repo_map = collect_repos(data)
    with open(target, "w") as handle:
        json.dump(scrub(data, [], repo_map), handle, indent=2, sort_keys=True)
        handle.write("\n")


if __name__ == "__main__":
    main()
