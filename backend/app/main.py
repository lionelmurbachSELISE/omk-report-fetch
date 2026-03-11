from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from .csv_export import to_csv_bytes
from .curl_parser import parse_curl
from .models import ParseCurlRequest, ParseCurlResponse, RunRequest, RunResponse
from .service import run_request

app = FastAPI(title="Subway Backoffice Local App")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
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
        preview = rows[: req.previewLimit]
        return RunResponse(
            columns=columns,
            rows=preview,
            totalRows=len(rows),
            totalBranches=len(req.branchUuids),
            branchesCompleted=len(req.branchUuids) - len({e.branch for e in events if e.status == "error"}),
            errors=errors,
            events=events,
            rawSample=raw_sample if raw_sample else None,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@app.post("/api/export-csv")
async def export_csv(req: RunRequest) -> Response:
    rows, columns, _errors, _events, _raw_sample = run_request(req)
    csv_bytes = to_csv_bytes(columns, rows)
    return Response(content=csv_bytes, media_type="text/csv")
