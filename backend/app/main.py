from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from .accounting_export import build_accounting_workbook, build_young_boys_product_workbook, build_young_boys_match_report, build_young_boys_tcpos_export, build_young_boys_season_dashboard, build_burgermeister_export
from .csv_export import to_xlsx_bytes_by_branch
from .curl_parser import parse_curl
from .customer_health import HealthResults, load_results, run_health_check
from .models import (
    ParseCurlRequest,
    ParseCurlResponse,
    RunRequest,
    RunResponse,
    OMKPayKPIResults,
    OMKPayKPIRunRequest,
    VapianoReportRequest,
)
from .omk_pay_kpi import OMKPayKPIService
from .service import run_request

logger = logging.getLogger("main")

_health_job_running = False


async def _daily_health_loop() -> None:
    """Run health check once daily at 08:00 UTC (avoids OMK server maintenance window at ~06:00 UTC).
    No automatic startup run — users trigger manually, cached results are loaded from disk."""
    global _health_job_running
    while True:
        now = datetime.now(timezone.utc)
        next_run = now.replace(hour=8, minute=0, second=0, microsecond=0)
        if next_run <= now:
            next_run += timedelta(days=1)
        await asyncio.sleep((next_run - now).total_seconds())

        if _health_job_running:
            logger.info("Daily health check skipped — manual run already in progress")
            continue
        _health_job_running = True
        try:
            logger.info("Starting scheduled daily health check")
            await asyncio.to_thread(run_health_check)
        except Exception as e:
            logger.error("Daily health check failed: %s", e)
        finally:
            _health_job_running = False


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(_daily_health_loop())
    yield
    task.cancel()


app = FastAPI(title="Alifs Chora Request App", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"]
    ,
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.get("/api/customer-health/results", response_model=HealthResults)
async def customer_health_results() -> HealthResults:
    results = load_results()
    if results is None:
        raise HTTPException(status_code=404, detail="No health results yet. Trigger a run first.")
    return results


@app.post("/api/customer-health/run", response_model=HealthResults)
async def customer_health_run() -> HealthResults:
    global _health_job_running
    if _health_job_running:
        raise HTTPException(status_code=409, detail="Health check already running.")
    _health_job_running = True
    try:
        return await asyncio.to_thread(run_health_check)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    finally:
        _health_job_running = False


@app.post("/api/test-direct")
async def test_direct(req: RunRequest) -> dict:
    """Test: use the EXACT same cookie the /api/run endpoint receives,
    send it directly to CMS, and compare with /api/run result."""
    import httpx as _httpx

    cookie = req.cookie
    branch = req.branchUuids[0] if req.branchUuids else "1d470650037549598bfcd7030248ca20"

    query = f"query findData {{ PlOrders(Model: {{PageNumber: 1, Filter: \"{{ 'BranchUUID': '{branch}' }}\", Sort: \"{{CreateDate: -1}}\", PageSize: 1}}) {{ Data {{ ItemId }} TotalCount Success ErrorMessage }} }}"

    headers = {
        "accept": "application/json, text/plain, */*",
        "accept-language": "en-GB,en-US;q=0.9,en;q=0.8,de;q=0.7",
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0",
        "origin": "https://cms.ordermonkey.com",
        "referer": "https://cms.ordermonkey.com",
        "cookie": cookie,
    }

    # Direct test
    payload = {"operationName": "", "variables": {}, "query": query}
    r1 = _httpx.post("https://cms.ordermonkey.com/api/gqlquery/v100/graphql", headers=headers, json=payload, timeout=30)

    # Through /api/run logic
    rows, columns, errors, events, raw_sample = run_request(req)

    return {
        "direct": {"status": r1.status_code, "body": r1.text[:300]},
        "via_run": {"totalRows": len(rows), "errors": errors[:2]},
        "cookie_length": len(cookie),
        "cookie_has_cms": "cms.ordermonkey.com" in cookie,
    }


@app.post("/api/parse-curl", response_model=ParseCurlResponse)
async def parse_curl_endpoint(req: ParseCurlRequest) -> ParseCurlResponse:
    try:
        return parse_curl(req.curl)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid curl parse: {e}") from e


@app.post("/api/run", response_model=RunResponse)
async def run_endpoint(req: RunRequest) -> RunResponse:
    try:
        print(f"[API] Cookie length: {len(req.cookie)}", flush=True)
        print(f"[API] Cookie has 'cms.ordermonkey.com': {'cms.ordermonkey.com' in req.cookie}", flush=True)
        print(f"[API] Cookie first 100 chars: {req.cookie[:100]}", flush=True)
        print(f"[API] Cookie last 50 chars: {req.cookie[-50:]}", flush=True)
        print(f"[API] Number of semicolons: {req.cookie.count(';')}", flush=True)
        rows, columns, errors, events, raw_sample = run_request(req)
        total_targets = len(req.branchUuids) if req.branchUuids else (1 if req.requestTypeId == "custom_http" else 0)
        preview = rows[: req.previewLimit]
        return RunResponse(
            columns=columns,
            rows=preview,
            totalRows=len(rows),
            totalBranches=total_targets,
            branchesCompleted=total_targets - len({e.branch for e in events if e.status == "error"}),
            errors=errors,
            events=events,
            rawSample=raw_sample if raw_sample else None,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/export-csv")
async def export_csv(req: RunRequest) -> Response:
    from .accounting_export import _branch_label

    rows, columns, errors, events, _raw_sample = run_request(req)
    any_ok = any(e.status == "ok" for e in events)
    if not rows and errors and not any_ok:
        raise HTTPException(
            status_code=400,
            detail="Export failed — no rows collected. Errors: " + "; ".join(errors[:5]),
        )
    xlsx_bytes = to_xlsx_bytes_by_branch(columns, rows, branch_label_fn=_branch_label)
    headers: dict[str, str] = {
        "Content-Disposition": 'attachment; filename="export_by_branch.xlsx"',
        "Access-Control-Expose-Headers": "Content-Disposition",
    }
    if errors:
        headers["X-Export-Errors"] = "; ".join(errors[:10])
        headers["X-Export-Error-Count"] = str(len(errors))
        headers["Access-Control-Expose-Headers"] = (
            "Content-Disposition, X-Export-Errors, X-Export-Error-Count"
        )
    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.post("/api/export-accounting-xlsx")
async def export_accounting_xlsx(req: RunRequest) -> Response:
    try:
        workbook_bytes, errors, _events = build_accounting_workbook(req)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    from .accounting_export import _org_label

    filename_slug = _org_label(req.orgId).lower().replace(" ", "_")
    headers = {
        "Content-Disposition": f'attachment; filename="{filename_slug}_accounting.xlsx"',
        "Access-Control-Expose-Headers": "Content-Disposition",
    }
    if errors:
        headers["X-Export-Errors"] = "; ".join(errors[:10])
        headers["X-Export-Error-Count"] = str(len(errors))
        headers["Access-Control-Expose-Headers"] = (
            "Content-Disposition, X-Export-Errors, X-Export-Error-Count"
        )

    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.post("/api/young-boys-tcpos-export")
async def young_boys_tcpos_export(req: RunRequest) -> Response:
    try:
        workbook_bytes, errors, _events = build_young_boys_tcpos_export(req)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    headers = {
        "Content-Disposition": 'attachment; filename="bsc_young_boys_tcpos.xlsx"',
        "Access-Control-Expose-Headers": "Content-Disposition",
    }
    if errors:
        headers["X-Export-Errors"] = "; ".join(errors[:10])
        headers["X-Export-Error-Count"] = str(len(errors))
        headers["Access-Control-Expose-Headers"] = (
            "Content-Disposition, X-Export-Errors, X-Export-Error-Count"
        )

    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.post("/api/young-boys-match-report")
async def young_boys_match_report(req: RunRequest) -> Response:
    try:
        workbook_bytes, errors, _events = build_young_boys_match_report(req)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    headers = {
        "Content-Disposition": 'attachment; filename="bsc_young_boys_match_report.xlsx"',
        "Access-Control-Expose-Headers": "Content-Disposition",
    }
    if errors:
        headers["X-Export-Errors"] = "; ".join(errors[:10])
        headers["X-Export-Error-Count"] = str(len(errors))
        headers["Access-Control-Expose-Headers"] = (
            "Content-Disposition, X-Export-Errors, X-Export-Error-Count"
        )

    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.post("/api/young-boys-product-export")
async def young_boys_product_export(req: RunRequest) -> Response:
    try:
        workbook_bytes, errors, _events = build_young_boys_product_workbook(req)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    headers = {
        "Content-Disposition": 'attachment; filename="bsc_young_boys_produkte.xlsx"',
        "Access-Control-Expose-Headers": "Content-Disposition",
    }
    if errors:
        headers["X-Export-Errors"] = "; ".join(errors[:10])
        headers["X-Export-Error-Count"] = str(len(errors))
        headers["Access-Control-Expose-Headers"] = (
            "Content-Disposition, X-Export-Errors, X-Export-Error-Count"
        )

    return Response(
        content=workbook_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.post("/api/burgermeister-export")
async def burgermeister_export(req: RunRequest) -> Response:
    try:
        xlsx_bytes, partial_errors, events = await asyncio.to_thread(build_burgermeister_export, req)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    headers: dict[str, str] = {}
    if partial_errors:
        headers["X-Export-Errors"] = "; ".join(partial_errors[:10])
        headers["X-Export-Error-Count"] = str(len(partial_errors))
    return Response(
        content=xlsx_bytes,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers=headers,
    )


@app.post("/api/young-boys-season-dashboard")
async def young_boys_season_dashboard(req: RunRequest) -> JSONResponse:
    try:
        data = build_young_boys_season_dashboard(req)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return JSONResponse(content=data)


@app.post("/api/vapiano-report")
async def vapiano_report(req: VapianoReportRequest) -> Response:
    from .vapiano_report import build_vapiano_report

    try:
        pdf_bytes = await asyncio.to_thread(
            build_vapiano_report,
            req.cookie,
            req.orgId,
            req.branchUuid,
            req.startDate,
            req.endDate,
            req.leatCsvText,
            req.influencerSignups,
            req.locationName,
            req.backofficeId,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    filename = f"vapiano_kpi_{req.startDate}.pdf"
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )


@app.post("/api/omk-pay/settlements")
async def omk_pay_settlements(body: dict) -> dict:
    """Proxy endpoint to call the OMK SettlementReportExport API.
    Expects JSON body with keys: StartDate, EndDate, FileName, OrganizationId, BranchIds, TenantId
    Optionally include `cookie` in the body (string)."""
    import httpx

    cookie = body.get("cookie") or ""
    payload = {
        "StartDate": body.get("StartDate"),
        "EndDate": body.get("EndDate"),
        "FileName": body.get("FileName"),
        "OrganizationId": body.get("OrganizationId"),
        "BranchIds": body.get("BranchIds", []),
        "TenantId": body.get("TenantId"),
    }

    headers = {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/json",
        "user-agent": "OMK-Report-Fetch/1.0",
        "origin": "https://cms.ordermonkey.com",
        "referer": "https://cms.ordermonkey.com/payment-report",
    }
    if cookie:
        headers["cookie"] = cookie

    url = "https://cms.ordermonkey.com/api/arc-etl/ArcEtlWebService/Kiosk/SettlementReportExport"
    try:
        with httpx.Client(timeout=60, verify=True) as client:
            resp = client.post(url, json=payload, headers=headers)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Error calling remote service: {e}") from e

    try:
        data = resp.json()
    except Exception:
        data = resp.text

    return {"status_code": resp.status_code, "data": data}


@app.get("/api/omk-pay/kpi/results", response_model=OMKPayKPIResults)
async def omk_pay_kpi_results() -> OMKPayKPIResults:
    """Get cached OMK Pay KPI results."""
    service = OMKPayKPIService(Path("omk_pay_kpi_results.json"))
    results = service.load_results()
    if results is None:
        # Return empty results on first run
        return OMKPayKPIResults(
            timestamp=datetime.now(timezone.utc).isoformat(),
            start_date="",
            end_date="",
            total_transactions=0,
            total_organizations=0,
            organizations={},
            errors=["No KPI results yet. Trigger a run first."],
        )
    return OMKPayKPIResults(**results)


@app.post("/api/omk-pay/kpi/run", response_model=OMKPayKPIResults)
async def omk_pay_kpi_run(req: OMKPayKPIRunRequest) -> OMKPayKPIResults:
    """Run OMK Pay KPI calculation for organizations."""
    service = OMKPayKPIService(Path("omk_pay_kpi_results.json"))
    try:
        results = service.run_kpi_calculation(
            start_date=req.start_date,
            end_date=req.end_date,
            orgs=req.organizations,
        )
        return OMKPayKPIResults(**results)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/api/omk-pay/kpi/run-auto", response_model=OMKPayKPIResults)
async def omk_pay_kpi_run_auto(days_back: int = 7) -> OMKPayKPIResults:
    """Auto-run KPI calculation for all organizations from orgs.json."""
    service = OMKPayKPIService(Path("omk_pay_kpi_results.json"))
    try:
        results = await asyncio.to_thread(service.run_auto_kpi, days_back)
        return OMKPayKPIResults(**results)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/api/omk-pay/kpi/debug-settlements")
async def omk_pay_kpi_debug_settlements(body: dict) -> dict:
    """Debug endpoint: show raw settlement response with auto-authentication."""
    import httpx
    from .omk_pay_kpi import authenticate, load_orgs
    
    org_name = body.get("org_name", "burgermeister").lower()
    start_date = body.get("start_date") or "2024-01-01"
    end_date = body.get("end_date") or "2024-01-31"
    
    # Load orgs and find the one to authenticate with
    orgs = load_orgs()
    org_config = next((o for o in orgs if o.name.lower() == org_name), None)
    
    if not org_config:
        return {
            "error": f"Organization '{org_name}' not found in orgs.json",
            "available_orgs": [o.name for o in orgs],
        }
    
    try:
        # Authenticate and get valid cookie
        logger.info(f"Debug: Authenticating {org_config.name}...")
        cookie = await asyncio.to_thread(authenticate, org_config.email, org_config.password)
        logger.info(f"Debug: Got valid cookie for {org_config.name}")
    except Exception as e:
        logger.error(f"Debug: Auth failed for {org_config.name}: {e}")
        return {"error": f"Authentication failed: {e}"}
    
    payload = {
        "StartDate": start_date,
        "EndDate": end_date,
        "FileName": "debug_export.csv",
        "OrganizationId": org_config.orgId,
        "BranchIds": [],
        "TenantId": "default",
    }
    
    headers = {
        "accept": "application/json, text/plain, */*",
        "content-type": "application/json",
        "user-agent": "OMK-Debug/1.0",
        "origin": "https://cms.ordermonkey.com",
        "referer": "https://cms.ordermonkey.com/payment-report",
        "cookie": cookie,
    }
    
    url = "https://cms.ordermonkey.com/api/arc-etl/ArcEtlWebService/Kiosk/SettlementReportExport"
    
    try:
        with httpx.Client(timeout=60, verify=True) as client:
            resp = client.post(url, json=payload, headers=headers)
        logger.info(f"Debug: Settlement API returned {resp.status_code}, text_len={len(resp.text)}")
    except Exception as e:
        logger.error(f"Debug: Settlement fetch failed: {e}")
        return {"error": str(e), "status": "failed"}
    
    # Return raw response
    return {
        "status_code": resp.status_code,
        "headers": dict(resp.headers),
        "text_first_500": resp.text[:500] if resp.text else "",
        "text_length": len(resp.text) if resp.text else 0,
        "organization": org_config.name,
        "try_json": None,
    } | ({"try_json": resp.json()} if resp.text else {})
