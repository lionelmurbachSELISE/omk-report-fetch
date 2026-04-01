from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from .csv_export import to_csv_bytes
from .curl_parser import parse_curl
from .models import ParseCurlRequest, ParseCurlResponse, RunRequest, RunResponse
from .service import run_request

app = FastAPI(title="Alifs Chora Request App")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://dbwkit-dvfjf.seliseblocks.com",
    ],
    allow_credentials=True,
    allow_methods=["*"]
    ,
    allow_headers=["*"],
)


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


@app.post("/api/parse-curl", response_model=ParseCurlResponse)
async def parse_curl_endpoint(req: ParseCurlRequest) -> ParseCurlResponse:
    try:
        return parse_curl(req.curl)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid curl parse: {e}") from e


@app.post("/api/run", response_model=RunResponse)
async def run_endpoint(req: RunRequest) -> RunResponse:
    try:
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
    rows, columns, errors, events, _raw_sample = run_request(req)
    any_ok = any(e.status == "ok" for e in events)
    if not rows and errors and not any_ok:
        raise HTTPException(
            status_code=400,
            detail="Export failed — no rows collected. Errors: " + "; ".join(errors[:5]),
        )
    csv_bytes = to_csv_bytes(columns, rows)
    headers: dict[str, str] = {}
    if errors:
        headers["X-Export-Errors"] = "; ".join(errors[:10])
        headers["X-Export-Error-Count"] = str(len(errors))
        headers["Access-Control-Expose-Headers"] = "X-Export-Errors, X-Export-Error-Count"
    return Response(content=csv_bytes, media_type="text/csv", headers=headers)
