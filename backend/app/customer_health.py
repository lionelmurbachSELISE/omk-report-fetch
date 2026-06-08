from __future__ import annotations

import json
import logging
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Dict, List, Optional

import requests as _requests  # requests has no asyncio coupling — safe in asyncio.to_thread
from pydantic import BaseModel

logger = logging.getLogger("customer-health")

# ── Constants ─────────────────────────────────────────────────────────────────
_BLOCKS_API = "https://api.seliseblocks.com"
_CMS_IDENTITY_URL = "https://cms.ordermonkey.com/api/identity/v100/identity/token"
_CMS_GRAPHQL_URL = "https://cms.ordermonkey.com/api/gqlquery/v100/graphql"
_CMS_ORIGIN = "https://cms.ordermonkey.com"
_X_BLOCKS_KEY = "Df2bcc056a20948d7b124d1be4c5925e0"

_ORGS_PATH = Path(__file__).parent.parent / "orgs.json"
_RESULTS_PATH = Path(__file__).parent.parent / "health_results.json"

_results_lock = threading.Lock()


# ── Models ────────────────────────────────────────────────────────────────────

class OrgConfig(BaseModel):
    name: str
    orgId: str
    email: str
    password: str


class ChannelStats(BaseModel):
    orders: int = 0
    revenue: float = 0.0


class OrgHealthResult(BaseModel):
    name: str
    orgId: str
    orders7d: Optional[int] = None
    revenue7d: Optional[float] = None
    lastOrderDate: Optional[str] = None
    byChannel: Dict[str, ChannelStats] = {}
    error: Optional[str] = None
    fetchedAt: str


class HealthResults(BaseModel):
    results: List[OrgHealthResult]
    runAt: str
    durationSeconds: Optional[float] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def load_orgs() -> List[OrgConfig]:
    if not _ORGS_PATH.exists():
        logger.warning("orgs.json not found at %s", _ORGS_PATH)
        return []
    try:
        raw = json.loads(_ORGS_PATH.read_text(encoding="utf-8"))
        return [OrgConfig(**o) for o in raw]
    except Exception as e:
        logger.error("Failed to load orgs.json: %s", e)
        return []


def save_results(results: HealthResults) -> None:
    with _results_lock:
        _RESULTS_PATH.write_text(results.model_dump_json(indent=2), encoding="utf-8")


def load_results() -> Optional[HealthResults]:
    with _results_lock:
        if not _RESULTS_PATH.exists():
            return None
        try:
            return HealthResults.model_validate_json(_RESULTS_PATH.read_text(encoding="utf-8"))
        except Exception as e:
            logger.error("Failed to load health_results.json: %s", e)
            return None


# ── Auth ──────────────────────────────────────────────────────────────────────

def _authenticate(email: str, password: str) -> str:
    """Log in via CMS identity endpoint and return a cookie string for GraphQL requests."""
    body = urllib.parse.urlencode({
        "grant_type": "password",
        "username": email,
        "password": password,
    })

    for url in [_CMS_IDENTITY_URL, f"{_BLOCKS_API}/idp/v1/Authentication/Token"]:
        try:
            resp = _requests.post(
                url,
                data=body,
                headers={
                    "Content-Type": "application/x-www-form-urlencoded",
                    "x-blocks-key": _X_BLOCKS_KEY,
                    "origin": _CMS_ORIGIN,
                    "referer": f"{_CMS_ORIGIN}/",
                    "user-agent": "Mozilla/5.0",
                },
                timeout=30,
            )
            if not resp.ok:
                logger.debug("Auth attempt at %s returned %s, trying next", url, resp.status_code)
                continue
            data = resp.json()
            access_token = data.get("accessToken") or data.get("access_token")
            refresh_token = data.get("refreshToken") or data.get("refresh_token")
            if not access_token:
                continue
            cookie = f"cms.ordermonkey.com={access_token}; x-blocks-key={_X_BLOCKS_KEY}"
            if refresh_token:
                cookie += f"; httpOnlyRefreshToken={refresh_token}"
            logger.info("Authenticated %s via %s", email, url)
            return cookie
        except Exception as e:
            logger.debug("Auth attempt at %s failed: %s", url, e)
            continue

    raise RuntimeError(f"All authentication attempts failed for {email}")


# ── Metrics fetch ─────────────────────────────────────────────────────────────

def _fetch_pl_orders(session: _requests.Session, headers: dict, org_id: str,
                     page: int, page_size: int,
                     start_str: str, end_str: str) -> dict:
    query = (
        "query healthCheck { "
        "PlOrders(Model: {"
        f"PageNumber: {page}, "
        f"Filter: \"{{ 'OrganizationId': '{org_id}', "
        f"'CreateDate': {{'$lte': ISODate('{end_str}'), '$gte': ISODate('{start_str}')}} }}\", "
        f"Sort: \"{{CreateDate: -1}}\", PageSize: {page_size}"
        "}) { Data { TotalAmount Device { DeviceType } } TotalCount Success ErrorMessage } }"
    )
    resp = session.post(
        _CMS_GRAPHQL_URL,
        headers=headers,
        json={"operationName": "healthCheck", "variables": {}, "query": query},
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("errors"):
        logger.error("GraphQL errors on page %d: %s", page, data["errors"])
    return data


_LIGHTSPEED = "Lightspeed"


def _query_last_order_for_channel(
    session: _requests.Session, headers: dict, org_id: str, device_type: str
) -> Optional[str]:
    """Return the CreateDate of the most recent order matching a specific DeviceType."""
    filter_str = (
        f"{{ 'OrganizationId': '{org_id}', 'Device.DeviceType': '{device_type}' }}"
    )
    query = (
        "query lastOrderByChannel { "
        "PlOrders(Model: {"
        "PageNumber: 1, "
        f"Filter: \"{filter_str}\", "
        "Sort: \"{CreateDate: -1}\", PageSize: 1"
        "}) { Data { CreateDate } Success } }"
    )
    resp = session.post(
        _CMS_GRAPHQL_URL,
        headers=headers,
        json={"operationName": "lastOrderByChannel", "variables": {}, "query": query},
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    items = (data.get("data") or {}).get("PlOrders", {}).get("Data") or []
    return items[0].get("CreateDate") if items else None


def _fetch_last_order(
    session: _requests.Session,
    headers: dict,
    org_id: str,
    known_channels: Optional[List[str]] = None,
) -> Optional[str]:
    """Find the most recent non-Lightspeed order date.

    Strategy A (fast): if we already know which non-Lightspeed channels exist, query
    each one directly with a DeviceType filter — 1 request per channel, guaranteed to
    find the right order regardless of how many Lightspeed orders came after it.

    Strategy B (fallback): when no non-Lightspeed channels are known from the 7-day
    window (org may be Lightspeed-only recently), paginate all orders newest-first and
    return the first non-Lightspeed date found (up to 10 000 orders).
    """
    # ── Strategy A ────────────────────────────────────────────────────────────
    if known_channels:
        latest_date: Optional[str] = None
        for ch in known_channels:
            date = _query_last_order_for_channel(session, headers, org_id, ch)
            if date:
                if latest_date is None or date > latest_date:
                    latest_date = date
        if latest_date:
            return latest_date
        # fell through — channel filter didn't work; try Strategy B

    # ── Strategy B (pagination fallback) ──────────────────────────────────────
    page_size = 100
    for page in range(1, 101):  # up to 10 000 orders
        query = (
            "query lastOrder { "
            "PlOrders(Model: {"
            f"PageNumber: {page}, Filter: \"{{ 'OrganizationId': '{org_id}' }}\", "
            f"Sort: \"{{CreateDate: -1}}\", PageSize: {page_size}"
            "}) { Data { CreateDate Device { DeviceType } } Success } }"
        )
        resp = session.post(
            _CMS_GRAPHQL_URL,
            headers=headers,
            json={"operationName": "lastOrder", "variables": {}, "query": query},
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        items = (data.get("data") or {}).get("PlOrders", {}).get("Data") or []
        for item in items:
            device_type = str((item.get("Device") or {}).get("DeviceType") or "")
            if device_type.lower() != _LIGHTSPEED.lower():
                return item.get("CreateDate")
        if len(items) < page_size:
            break
    return None


def _fetch_org_metrics(org: OrgConfig) -> OrgHealthResult:
    """Each org gets its own requests.Session — fresh cookie jar, no cross-org contamination."""
    now = datetime.now(timezone.utc)
    start_str = (now - timedelta(days=7)).strftime("%Y-%m-%dT00:00:00.000Z")
    end_str = now.strftime("%Y-%m-%dT23:59:59.999Z")

    print(f"[HEALTH] [{org.name}] authenticating …", flush=True)
    try:
        cookie = _authenticate(org.email, org.password)
        print(f"[HEALTH] [{org.name}] auth OK ({len(cookie)} chars)", flush=True)
    except Exception as e:
        print(f"[HEALTH] [{org.name}] auth FAILED: {e}", flush=True)
        return OrgHealthResult(
            name=org.name, orgId=org.orgId,
            error=f"Auth failed: {e}", fetchedAt=now.isoformat()
        )

    headers = {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0",
        "origin": _CMS_ORIGIN,
        "referer": _CMS_ORIGIN,
        "cookie": cookie,
    }

    try:
        with _requests.Session() as session:
            # Disable session-level cookie management so our manual Cookie header is
            # never overwritten by requests' internal jar.
            session.cookies.clear()

            by_channel: Dict[str, ChannelStats] = {}
            page_size = 100

            for page in range(1, 201):  # up to 20 000 orders per org per week
                data = _fetch_pl_orders(session, headers, org.orgId, page, page_size, start_str, end_str)
                pl = (data.get("data") or {}).get("PlOrders") or {}

                if pl.get("Success") is False:
                    raise RuntimeError(f"GraphQL error: {pl.get('ErrorMessage')}")

                items = pl.get("Data") or []

                # Diagnostics on first page only
                if page == 1:
                    print(
                        f"[HEALTH] [{org.name}] page 1 → "
                        f"{len(items)} items  TotalCount={pl.get('TotalCount')}  "
                        f"Success={pl.get('Success')}  errors={bool(data.get('errors'))}",
                        flush=True,
                    )

                for item in items:
                    channel = str((item.get("Device") or {}).get("DeviceType") or "Unknown")
                    if channel.lower() == _LIGHTSPEED.lower():
                        continue  # exclude Lightspeed from all metrics
                    amount = 0.0
                    try:
                        amount = float(item.get("TotalAmount") or 0)
                    except (TypeError, ValueError):
                        pass
                    ch = by_channel.setdefault(channel, ChannelStats())
                    ch.orders += 1
                    ch.revenue = round(ch.revenue + amount, 2)

                if len(items) < page_size:
                    break
                time.sleep(0.1)

            total_orders = sum(ch.orders for ch in by_channel.values())
            total_revenue = round(sum(ch.revenue for ch in by_channel.values()), 2)
            non_ls_channels = list(by_channel.keys())  # already excludes Lightspeed
            print(
                f"[HEALTH] [{org.name}] done → {total_orders} orders  "
                f"CHF {total_revenue}  channels={non_ls_channels}",
                flush=True,
            )
            last_order_date = _fetch_last_order(
                session, headers, org.orgId, known_channels=non_ls_channels or None
            )

        return OrgHealthResult(
            name=org.name,
            orgId=org.orgId,
            orders7d=total_orders,
            revenue7d=total_revenue,
            lastOrderDate=last_order_date,
            byChannel=by_channel,
            fetchedAt=now.isoformat(),
        )
    except Exception as e:
        logger.error("Metrics fetch failed for %s: %s", org.name, e)
        print(f"[HEALTH] [{org.name}] EXCEPTION: {e}", flush=True)
        return OrgHealthResult(
            name=org.name, orgId=org.orgId,
            error=str(e), fetchedAt=now.isoformat()
        )


# ── Job ───────────────────────────────────────────────────────────────────────

def run_health_check() -> HealthResults:
    orgs = load_orgs()
    started = datetime.now(timezone.utc)
    results: List[OrgHealthResult] = []

    print(f"[HEALTH] Starting health check for {len(orgs)} orgs", flush=True)
    logger.info("Starting health check for %d orgs", len(orgs))

    for org in orgs:
        logger.info("Fetching metrics for %s", org.name)
        results.append(_fetch_org_metrics(org))

    duration = (datetime.now(timezone.utc) - started).total_seconds()
    health = HealthResults(
        results=results,
        runAt=started.isoformat(),
        durationSeconds=round(duration, 1),
    )

    # Sanity check: if every org returned 0 orders and no errors, the API is probably
    # unreachable or in a maintenance window — keep the previous cache instead of overwriting.
    orgs_with_data = [r for r in results if (r.orders7d or 0) > 0 or r.error]
    if not orgs_with_data and results:
        print(
            f"[HEALTH] WARNING — all {len(results)} orgs returned 0 orders with no errors "
            f"after {duration:.1f}s — skipping cache update (server issue suspected)",
            flush=True,
        )
        logger.warning(
            "All %d orgs returned 0 orders with no errors after %.1fs — "
            "likely a server issue. Skipping cache update.",
            len(results), duration,
        )
        return health  # return for the API response but don't save

    save_results(health)
    print(f"[HEALTH] Health check complete in {duration:.1f}s", flush=True)
    logger.info("Health check complete in %.1fs", duration)
    return health
