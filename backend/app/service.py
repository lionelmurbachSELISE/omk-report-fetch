from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Tuple

import httpx

from .models import ProgressEvent, RunRequest
from .request_types import BACKOFFICES, REQUEST_TYPES, apply_mapping


BASE_HEADERS = {
    "accept": "application/json, text/plain, */*",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8,de;q=0.7",
    "content-type": "application/json",
    "user-agent": "Mozilla/5.0",
}


def _resolve_backoffice(backoffice_id: str) -> Dict[str, str]:
    target = BACKOFFICES.get(backoffice_id)
    if not target:
        raise RuntimeError(f"Unknown backoffice: {backoffice_id}")
    return target


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
    headers = _build_headers(req.cookie, req.origin, req.referer, backoffice) if backoffice else {}

    all_rows: List[Dict[str, Any]] = []
    errors: List[str] = []
    events: List[ProgressEvent] = []
    raw_sample: List[Dict[str, Any]] = []

    branches = req.branchUuids
    if not branches and request_type.supports_pagination():
        return [], request_type.csv_schema(), errors, events, raw_sample
    effective_branches = branches if branches else [""]

    with httpx.Client(timeout=timeout) as client:
        for branch in effective_branches:
            branch_ok = True
            max_pages = req.maxPages if request_type.supports_pagination() else 1
            for page in range(1, max_pages + 1):
                try:
                    payload = request_type.build_payload(
                        org_id=req.orgId or "",
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
                        if req.cookie:
                            request_headers.setdefault("cookie", req.cookie)
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
