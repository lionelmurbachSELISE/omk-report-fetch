from __future__ import annotations

import json
import re
from typing import Dict, List, Optional, Tuple

from .models import ParseCurlResponse


_HEADER_RE = re.compile(r"-H\s+(['\"])(.*?)\1")
_URL_RE = re.compile(r"curl\s+(['\"])(.*?)\1")
_METHOD_RE = re.compile(r"(?:-X|--request)\s+(['\"])?([A-Za-z]+)\1?")


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


def _extract_quoted_argument(curl: str, flags: List[str]) -> Optional[str]:
    for flag in flags:
        start = curl.find(flag)
        if start == -1:
            continue

        i = start + len(flag)
        while i < len(curl) and curl[i].isspace():
            i += 1

        if i < len(curl) and curl[i] == "$":
            i += 1

        if i >= len(curl) or curl[i] not in ("'", '"'):
            continue

        quote = curl[i]
        i += 1
        out: List[str] = []
        escaped = False

        while i < len(curl):
            ch = curl[i]
            if escaped:
                out.append("\\" + ch)
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                return "".join(out)
            else:
                out.append(ch)
            i += 1

    return None


def _extract_data(curl: str) -> Optional[str]:
    return _extract_quoted_argument(curl, ["--data-raw", "--data"])


def _extract_cookie(curl: str) -> Optional[str]:
    return _extract_quoted_argument(curl, ["-b", "--cookie"])


def _parse_body(raw_json: str) -> Optional[Dict[str, object]]:
    try:
        body = json.loads(raw_json)
    except Exception:
        try:
            # Chrome "Copy as cURL" may use ANSI-C $'...' quoting, which leaves
            # shell escapes like \' in the extracted payload. Decode them first.
            decoded = bytes(raw_json, "utf-8").decode("unicode_escape")
            body = json.loads(decoded)
        except Exception:
            return None

    if isinstance(body, dict):
        return body

    return None


def _extract_filter_values(query: str) -> Tuple[Optional[str], List[str]]:
    org_match = re.search(r"OrganizationId'\s*:\s*'([^']+)'", query)
    branch_matches = re.findall(r"BranchUUID'\s*:\s*'([^']+)'", query)
    return (org_match.group(1) if org_match else None, branch_matches)


def _extract_date_range(query: str) -> Tuple[Optional[str], Optional[str]]:
    start_match = re.search(
        r"CreateDate'?\s*:\s*\{[^}]*\$gte'?\s*:\s*(?:ISODate\('([^']+)'\)|'([^']+)')",
        query,
    )
    end_match = re.search(
        r"CreateDate'?\s*:\s*\{[^}]*\$lte'?\s*:\s*(?:ISODate\('([^']+)'\)|'([^']+)')",
        query,
    )
    return (
        (start_match.group(1) or start_match.group(2)) if start_match else None,
        (end_match.group(1) or end_match.group(2)) if end_match else None,
    )


def _template_query(
    query: str,
    org_id: Optional[str],
    branch_uuids: List[str],
    start_date: Optional[str],
    end_date: Optional[str],
) -> str:
    templated = query
    if org_id:
        templated = templated.replace(org_id, "{{ORG_ID}}")
    for branch_uuid in branch_uuids:
        templated = templated.replace(branch_uuid, "{{BRANCH_UUID}}")
    if start_date:
        templated = templated.replace(start_date, "{{START_DATE}}")
    if end_date:
        templated = templated.replace(end_date, "{{END_DATE}}")

    templated = re.sub(r"PageNumber\s*:\s*\d+", "PageNumber: {{PAGE_NUMBER}}", templated)
    templated = re.sub(r"PageSize\s*:\s*\d+", "PageSize: {{PAGE_SIZE}}", templated)
    return templated


def parse_curl(curl: str) -> ParseCurlResponse:
    headers = _extract_header_values(curl)
    url = _extract_url(curl)
    raw_json = _extract_data(curl)
    cookie_from_flag = _extract_cookie(curl)
    method_match = _METHOD_RE.search(curl)
    method = method_match.group(2).upper() if method_match else ("POST" if raw_json else "GET")
    backoffice_id = None

    if url:
        if "backoffice.subway.ch" in url:
            backoffice_id = "subway"
        elif "cms.ordermonkey.com" in url:
            backoffice_id = "ordermonkey"

    cookie = headers.get("cookie") or headers.get("Cookie") or cookie_from_flag
    origin = headers.get("origin") or headers.get("Origin")
    referer = headers.get("referer") or headers.get("Referer")

    operation = None
    query = None
    normalized_raw_json = None
    org_id = None
    branch_uuids: List[str] = []
    start_date = None
    end_date = None
    if raw_json:
        body = _parse_body(raw_json)
        if body:
            operation_value = body.get("operationName")
            query_value = body.get("query")
            operation = operation_value if isinstance(operation_value, str) else None
            query = query_value if isinstance(query_value, str) else None
            if query:
                org_id, branch_uuids = _extract_filter_values(query)
                start_date, end_date = _extract_date_range(query)
                body["query"] = _template_query(query, org_id, branch_uuids, start_date, end_date)
                query = body["query"] if isinstance(body["query"], str) else query
            normalized_raw_json = json.dumps(body)

    return ParseCurlResponse(
        url=url,
        method=method,
        backofficeId=backoffice_id,
        orgId=org_id,
        branchUuids=branch_uuids,
        startDate=start_date,
        endDate=end_date,
        headers=headers,
        cookie=cookie,
        origin=origin,
        referer=referer,
        operationName=operation,
        query=query,
        rawJsonBody=normalized_raw_json or raw_json,
    )
