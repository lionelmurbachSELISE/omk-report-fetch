from __future__ import annotations

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class ParseCurlRequest(BaseModel):
    curl: str


class ParseCurlResponse(BaseModel):
    url: Optional[str] = None
    backofficeId: Optional[str] = None
    orgId: Optional[str] = None
    branchUuids: List[str] = Field(default_factory=list)
    startDate: Optional[str] = None
    endDate: Optional[str] = None
    headers: Dict[str, str] = Field(default_factory=dict)
    cookie: Optional[str] = None
    origin: Optional[str] = None
    referer: Optional[str] = None
    operationName: Optional[str] = None
    query: Optional[str] = None
    rawJsonBody: Optional[str] = None


class RequestTypeConfig(BaseModel):
    queryTemplate: Optional[str] = None
    operationName: Optional[str] = None
    variables: Optional[Dict[str, Any]] = None
    rawJsonBody: Optional[str] = None
    mapping: Optional[Dict[str, str]] = None
    csvSchema: Optional[List[str]] = None
    useCurl: bool = False


class RunRequest(BaseModel):
    cookie: str
    backofficeId: str = "subway"
    orgId: Optional[str] = None
    branchUuids: List[str] = Field(default_factory=list)
    startDate: Optional[str] = None
    endDate: Optional[str] = None
    pageSize: int = 100
    maxPages: int = 50
    sleepSeconds: float = 0.15
    timeoutSeconds: float = 60.0
    origin: Optional[str] = None
    referer: Optional[str] = None
    requestTypeId: str
    requestConfig: Optional[RequestTypeConfig] = None
    previewLimit: int = 200


class ProgressEvent(BaseModel):
    branch: str
    page: int
    status: str
    message: Optional[str] = None


class RunResponse(BaseModel):
    columns: List[str]
    rows: List[Dict[str, Any]]
    totalRows: int
    totalBranches: int
    branchesCompleted: int
    errors: List[str] = Field(default_factory=list)
    events: List[ProgressEvent] = Field(default_factory=list)
    rawSample: Optional[List[Dict[str, Any]]] = None


class ExportCsvRequest(BaseModel):
    columns: List[str]
    rows: List[Dict[str, Any]]
