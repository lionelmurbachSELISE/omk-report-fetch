from __future__ import annotations

import base64
import json
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

logger = logging.getLogger("report-fetch")
logging.basicConfig(level=logging.DEBUG)

from .models import ProgressEvent, RunRequest
from .request_types import BACKOFFICES, REQUEST_TYPES, apply_mapping


BASE_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8,de;q=0.7",
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0",
}

REFRESH_URL = "https://cms.ordermonkey.com/api/identity/v100/identity/token"
TOKEN_EXPIRY_BUFFER_SECONDS = 300  # Refresh aggressively — old tokens get invalidated by CMS


def _parse_cookies(cookie_str: str) -> Dict[str, str]:
    """Parse a cookie header string into a dict of name->value."""
    cookies: Dict[str, str] = {}
    for part in cookie_str.split(";"):
        part = part.strip()
        if "=" in part:
            name, value = part.split("=", 1)
            cookies[name.strip()] = value.strip()
    return cookies


def _rebuild_cookie_string(cookies: Dict[str, str]) -> str:
    """Rebuild a cookie header string from a dict."""
    return "; ".join(f"{k}={v}" for k, v in cookies.items())


def _decode_jwt_exp(token: str) -> Optional[int]:
    """Extract the exp claim from a JWT. Returns None on failure."""
    try:
        jwt_payload = token.split(".")[1]
        jwt_payload += "=" * (4 - len(jwt_payload) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(jwt_payload))
        return decoded.get("exp")
    except Exception:
        return None


def _is_token_expired_or_expiring(token: str) -> bool:
    """Check if a JWT is expired or will expire within the buffer window."""
    exp = _decode_jwt_exp(token)
    if exp is None:
        return True  # Can't decode -> treat as expired
    now = int(time.time())
    remaining = exp - now
    logger.debug(f"JWT exp={exp}, now={now}, remaining={remaining}s, buffer={TOKEN_EXPIRY_BUFFER_SECONDS}s")
    return remaining < TOKEN_EXPIRY_BUFFER_SECONDS


def _refresh_access_token(cookie_str: str, client: httpx.Client) -> str:
    """
    Check if the cms.ordermonkey.com JWT needs refreshing, and if so,
    call the refresh endpoint and return an updated cookie string.
    Returns the original cookie string if no refresh is needed or possible.
    """
    cookies = _parse_cookies(cookie_str)

    access_token = cookies.get("cms.ordermonkey.com")
    refresh_token = cookies.get("httpOnlyRefreshToken")

    if not access_token or not refresh_token:
        return cookie_str

    if not _is_token_expired_or_expiring(access_token):
        return cookie_str

    logger.info("Access token expired or expiring soon -- refreshing...")

    x_blocks_key = cookies.get("x-blocks-key", "")

    refresh_headers = {
        "Content-Type": "application/x-www-form-urlencoded",
        "accept": "application/json, text/plain, */*",
        "user-agent": "Mozilla/5.0",
        "origin": "https://cms.ordermonkey.com",
        "referer": "https://cms.ordermonkey.com/",
        "cookie": cookie_str,
    }

    body = f"grant_type=refresh_token&refresh_token={refresh_token}"

    try:
        resp = client.post(REFRESH_URL, headers=refresh_headers, content=body)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logger.error(f"Token refresh failed: {e}")
        return cookie_str

    new_token = data.get("accessToken") or data.get("access_token")
    if not new_token:
        logger.error(f"Token refresh response missing accessToken. Keys: {list(data.keys())}")
        return cookie_str

    new_refresh = data.get("refreshToken") or data.get("refresh_token")

    cookies["cms.ordermonkey.com"] = new_token
    if new_refresh:
        cookies["httpOnlyRefreshToken"] = new_refresh

    new_cookie_str = _rebuild_cookie_string(cookies)
    logger.info("Access token refreshed successfully.")
    new_exp = _decode_jwt_exp(new_token)
    if new_exp:
        logger.info(f"New token expires at {new_exp} (in {new_exp - int(time.time())}s)")
    logger.info(f"New cookie length: {len(new_cookie_str)}, semicolons: {new_cookie_str.count(';')}")
    logger.info(f"New cookie first 80: {new_cookie_str[:80]}")
    logger.info(f"New cookie has cms: {'cms.ordermonkey.com' in new_cookie_str}")
    # Verify the new token works by checking it's a valid JWT
    cms_val = cookies.get("cms.ordermonkey.com", "")
    logger.info(f"cms token length: {len(cms_val)}, starts with eyJ: {cms_val[:3]}")

    return new_cookie_str


def _resolve_backoffice(backoffice_id: str) -> Dict[str, str]:
    target = BACKOFFICES.get(backoffice_id)
    if not target:
        raise RuntimeError(f"Unknown backoffice: {backoffice_id}")
    return target


def _normalize_branch_id(value: str) -> str:
    return value.strip().lower().replace("-", "")


def _get_branch_value(values: Dict[str, str], branch: str) -> Optional[str]:
    return values.get(branch) or values.get(_normalize_branch_id(branch))


def _build_headers(cookie: str, origin: Optional[str], referer: Optional[str], backoffice: Dict[str, str]) -> Dict[str, str]:
    headers = dict(BASE_HEADERS)
    headers["cookie"] = cookie
    headers["origin"] = origin or backoffice["origin"]
    headers["referer"] = referer or backoffice["referer"]
    return headers


def _handle_response(resp: httpx.Response) -> Any:
    if resp.status_code in (401, 403):
        snippet = resp.text[:800] if resp.text else ""
        raise RuntimeError(
            "Unauthorized response. "
            + f"HTTP {resp.status_code}. "
            + "Your session cookie is missing or expired. "
            + ("Response snippet: " + snippet if snippet else "")
        )

    try:
        resp.raise_for_status()
    except httpx.HTTPError as e:
        snippet = resp.text[:800] if resp.text else ""
        raise RuntimeError(
            "HTTP error. " + f"HTTP {resp.status_code}. " + ("Response snippet: " + snippet if snippet else "")
        ) from e

    try:
        data = resp.json()
    except Exception as e:
        snippet = resp.text[:800] if resp.text else ""
        raise RuntimeError(
            "Response was not valid JSON. "
            + f"HTTP {resp.status_code}. "
            + ("Response snippet: " + snippet if snippet else "")
        ) from e

    if isinstance(data, dict) and data.get("errors"):
        raise RuntimeError("GraphQL errors: " + str(data.get("errors")))

    return data


def run_request(req: RunRequest) -> Tuple[List[Dict[str, Any]], List[str], List[str], List[ProgressEvent], List[Dict[str, Any]]]:
    request_type = REQUEST_TYPES.get(req.requestTypeId)
    if not request_type:
        raise RuntimeError(f"Unknown request type: {req.requestTypeId}")

    timeout = httpx.Timeout(req.timeoutSeconds)
    backoffice = _resolve_backoffice(req.backofficeId) if req.requestTypeId != "custom_http" else None

    all_rows: List[Dict[str, Any]] = []
    errors: List[str] = []
    events: List[ProgressEvent] = []
    raw_sample: List[Dict[str, Any]] = []

    branches = req.branchUuids
    if not branches and request_type.supports_pagination():
        return [], request_type.csv_schema(), errors, events, raw_sample
    effective_branches = branches if branches else [""]

    # Ignore machine-level proxy env vars so local dev runs talk directly to the
    # selected backoffice instead of a broken localhost proxy.
    with httpx.Client(timeout=timeout, trust_env=False) as client:
        for branch in effective_branches:
            branch_ok = True
            branch_org_id = (
                _get_branch_value(req.branchOrgIds, branch)
                or req.orgId
                or ""
            )
            branch_cookie = _get_branch_value(req.branchCookies, branch) or req.cookie
            headers = _build_headers(branch_cookie, req.origin, req.referer, backoffice) if backoffice else {}
            max_pages = req.maxPages if request_type.supports_pagination() else 1
            for page in range(1, max_pages + 1):
                try:
                    # --- Token refresh before each request ---
                    if branch_cookie:
                        refreshed_cookie = _refresh_access_token(branch_cookie, client)
                        if refreshed_cookie != branch_cookie:
                            branch_cookie = refreshed_cookie
                            if req.branchCookies:
                                req.branchCookies[_normalize_branch_id(branch)] = refreshed_cookie
                            else:
                                req.cookie = refreshed_cookie
                            if headers:
                                headers["cookie"] = refreshed_cookie

                    payload = request_type.build_payload(
                        org_id=branch_org_id,
                        branch_uuid=branch,
                        page_number=page,
                        page_size=req.pageSize,
                        start_date=req.startDate,
                        end_date=req.endDate,
                        request_config=req.requestConfig.model_dump() if req.requestConfig else None,
                    )
                    if req.requestTypeId == "custom_http":
                        request_headers = dict(headers)
                        request_headers.update(payload.get("headers") or {})
                        request_headers.setdefault("accept", "application/json, text/plain, */*")
                        request_headers.setdefault("user-agent", "Mozilla/5.0")
                        if branch_cookie:
                            request_headers.setdefault("cookie", branch_cookie)
                        if req.origin:
                            request_headers.setdefault("origin", req.origin)
                        if req.referer:
                            request_headers.setdefault("referer", req.referer)

                        method = payload.get("method") or "GET"
                        url = payload.get("url")
                        if not url:
                            raise RuntimeError("Custom URL is required")
                        request_kwargs: Dict[str, Any] = {"headers": request_headers}
                        if "json" in payload:
                            request_kwargs["json"] = payload["json"]
                        resp = client.request(method, url, **request_kwargs)
                    else:
                        assert backoffice is not None
                        resp = client.post(backoffice["graphql_url"], headers=headers, json=payload)
                    # Decode JWT exp from cookie
                    try:
                        cookie_str = headers.get("cookie") or ""
                        for part in cookie_str.split(";"):
                            part = part.strip()
                            if part.startswith("cms.ordermonkey.com="):
                                jwt_token = part.split("=", 1)[1]
                                jwt_payload = jwt_token.split(".")[1]
                                jwt_payload += "=" * (4 - len(jwt_payload) % 4)
                                decoded = json.loads(base64.urlsafe_b64decode(jwt_payload))
                                exp = decoded.get("exp", 0)
                                now = int(time.time())
                                print(f"JWT exp={exp}, now={now}, diff={exp - now}s, {'VALID' if exp > now else 'EXPIRED!'}", flush=True)
                                print(f"JWT user={decoded.get('user_name')}, role={decoded.get('role')}, site_id={decoded.get('site_id')}, orgid={decoded.get('orgid')}, user_loggedin={decoded.get('user_loggedin')}", flush=True)
                    except Exception as e:
                        print(f"JWT decode error: {e}", flush=True)
                    print(f"=== REQUEST to {backoffice['graphql_url'] if backoffice else payload.get('url')} ===", flush=True)
                    print(f"Full payload: {json.dumps(payload, default=str)[:800]}", flush=True)
                    sent_cookie = headers.get('cookie') or ''
                    print(f"Cookie length sent: {len(sent_cookie)}, semicolons: {sent_cookie.count(';')}", flush=True)
                    # Check if cms token in the sent cookie is a real JWT
                    for cp in sent_cookie.split(';'):
                        cp = cp.strip()
                        if cp.startswith('cms.ordermonkey.com='):
                            cms_val = cp.split('=', 1)[1]
                            print(f"cms token in sent cookie: len={len(cms_val)}, starts={cms_val[:10]}", flush=True)
                            break
                    print(f"Response status: {resp.status_code}", flush=True)
                    print(f"Response body (first 500 chars): {resp.text[:500]}", flush=True)
                    data = _handle_response(resp)
                    if req.requestTypeId == "custom_http":
                        response_path = req.requestConfig.responsePath if req.requestConfig else None
                        items = request_type.parse_items(data, response_path=response_path)
                    else:
                        items = request_type.parse_items(data)

                    if req.requestTypeId == "all_orders":
                        if len(raw_sample) < req.previewLimit:
                            raw_sample.extend(items[: max(0, req.previewLimit - len(raw_sample))])

                    rows = request_type.transform_rows(items)

                    if req.requestConfig and req.requestConfig.mapping:
                        rows = apply_mapping(rows, req.requestConfig.mapping)

                    all_rows.extend(rows)

                    events.append(ProgressEvent(branch=branch or "(single)", page=page, status="ok"))

                    if not request_type.supports_pagination() or len(items) < req.pageSize:
                        break

                    time.sleep(req.sleepSeconds)
                except Exception as e:
                    branch_ok = False
                    label = branch or "(single)"
                    msg = f"branch={label}, page={page}, error={e}"
                    errors.append(msg)
                    events.append(ProgressEvent(branch=label, page=page, status="error", message=str(e)))
                    break
            if not branch_ok:
                continue

    columns = request_type.csv_schema()
    if req.requestConfig and req.requestConfig.csvSchema:
        columns = req.requestConfig.csvSchema
    if not columns and all_rows:
        columns = list(all_rows[0].keys())

    return all_rows, columns, errors, events, raw_sample
