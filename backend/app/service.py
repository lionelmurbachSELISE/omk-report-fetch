from __future__ import annotations

import json
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


def _handle_response(resp: httpx.Response) -> Dict[str, Any]:
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
        raise RuntimeError("GraphQL errors: " + json.dumps(data.get("errors")))

    if not isinstance(data, dict):
        raise RuntimeError("Response JSON is not an object")

    return data


def run_request(req: RunRequest) -> Tuple[List[Dict[str, Any]], List[str], List[str], List[ProgressEvent], List[Dict[str, Any]]]:
    request_type = REQUEST_TYPES.get(req.requestTypeId)
    if not request_type:
        raise RuntimeError(f"Unknown request type: {req.requestTypeId}")

    backoffice = _resolve_backoffice(req.backofficeId)
    headers = _build_headers(req.cookie, req.origin, req.referer, backoffice)
    timeout = httpx.Timeout(req.timeoutSeconds)

    all_rows: List[Dict[str, Any]] = []
    errors: List[str] = []
    events: List[ProgressEvent] = []
    raw_sample: List[Dict[str, Any]] = []

    branches = req.branchUuids
    if not branches:
        return [], request_type.csv_schema(), errors, events, raw_sample

    with httpx.Client(timeout=timeout) as client:
        for branch in branches:
            branch_ok = True
            for page in range(1, req.maxPages + 1):
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
                    resp = client.post(backoffice["graphql_url"], headers=headers, json=payload)
                    data = _handle_response(resp)
                    items = request_type.parse_items(data)

                    if req.requestTypeId == "all_orders":
                        if len(raw_sample) < req.previewLimit:
                            raw_sample.extend(items[: max(0, req.previewLimit - len(raw_sample))])

                    rows = request_type.transform_rows(items)

                    if req.requestConfig and req.requestConfig.mapping:
                        rows = apply_mapping(rows, req.requestConfig.mapping)

                    all_rows.extend(rows)

                    events.append(ProgressEvent(branch=branch, page=page, status="ok"))

                    if len(items) < req.pageSize:
                        break

                    time.sleep(req.sleepSeconds)
                except Exception as e:
                    branch_ok = False
                    msg = f"branch={branch}, page={page}, error={e}"
                    errors.append(msg)
                    events.append(ProgressEvent(branch=branch, page=page, status="error", message=str(e)))
                    break
            if not branch_ok:
                continue

    columns = request_type.csv_schema()
    if req.requestConfig and req.requestConfig.csvSchema:
        columns = req.requestConfig.csvSchema
    if not columns and all_rows:
        columns = list(all_rows[0].keys())

    return all_rows, columns, errors, events, raw_sample
