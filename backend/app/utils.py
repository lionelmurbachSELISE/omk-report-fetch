from __future__ import annotations

import re
from typing import Any


_INDEX_RE = re.compile(r"^(.*?)\[(\d+)\]$")


def get_path(data: Any, path: str) -> Any:
    if not path:
        return None
    current = data
    for part in path.split("."):
        if current is None:
            return None
        match = _INDEX_RE.match(part)
        if match:
            key = match.group(1)
            idx = int(match.group(2))
            if isinstance(current, dict):
                current = current.get(key)
            else:
                return None
            if not isinstance(current, list) or idx >= len(current):
                return None
            current = current[idx]
            continue
        if isinstance(current, dict):
            current = current.get(part)
        else:
            return None
    return current
