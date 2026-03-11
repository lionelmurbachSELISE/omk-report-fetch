from __future__ import annotations

import json
import re
from typing import Dict, Optional, Tuple

from .models import ParseCurlResponse


_HEADER_RE = re.compile(r"-H\s+(['\"])(.*?)\1")
_DATA_RE = re.compile(r"--data-raw\s+(['\"])(.*?)\1|--data\s+(['\"])(.*?)\3")
_URL_RE = re.compile(r"curl\s+(['\"])(.*?)\1")


def _extract_header_values(curl: str) -> Dict[str, str]:
    headers: Dict[str, str] = {}
    for match in _HEADER_RE.finditer(curl):
        header_line = match.group(2)
        if ":" in header_line:
            name, value = header_line.split(":", 1)
            headers[name.strip()] = value.strip()
    return headers


def _extract_url(curl: str) -> Optional[str]:
    match = _URL_RE.search(curl)
    if not match:
        return None
    return match.group(2)


def _extract_data(curl: str) -> Optional[str]:
    match = _DATA_RE.search(curl)
    if not match:
        return None
    if match.group(2):
        return match.group(2)
    return match.group(4)


def _extract_query_fields(raw_json: str) -> Tuple[Optional[str], Optional[str]]:
    try:
        body = json.loads(raw_json)
    except Exception:
        return None, None

    if isinstance(body, dict):
        operation = body.get("operationName")
        query = body.get("query")
        return operation, query

    return None, None


def parse_curl(curl: str) -> ParseCurlResponse:
    headers = _extract_header_values(curl)
    url = _extract_url(curl)
    raw_json = _extract_data(curl)

    cookie = headers.get("cookie") or headers.get("Cookie")
    origin = headers.get("origin") or headers.get("Origin")
    referer = headers.get("referer") or headers.get("Referer")

    operation = None
    query = None
    if raw_json:
        operation, query = _extract_query_fields(raw_json)

    return ParseCurlResponse(
        url=url,
        headers=headers,
        cookie=cookie,
        origin=origin,
        referer=referer,
        operationName=operation,
        query=query,
        rawJsonBody=raw_json,
    )
