import { useEffect, useMemo, useRef, useState } from "react";
import { postCsv, postJson } from "./utils/api";
import { clearLocal, loadLocal, saveLocal } from "./utils/storage";

const INTERNAL_MAX_PAGES = 200;
const BACKOFFICE_OPTIONS = [
  {
    id: "subway",
    name: "Subway",
    orgId: "420940c0-d894-4774-84e2-6398d71dd41c",
    origin: "https://backoffice.subway.ch",
    referer: "https://backoffice.subway.ch/orders/all-orders",
  },
  {
    id: "ordermonkey",
    name: "Ordermonkey",
    orgId: "837a3046-3a55-4754-a872-bbb35738fc32",
    origin: "https://cms.ordermonkey.com",
    referer: "https://cms.ordermonkey.com",
  },
] as const;
type BackofficeId = (typeof BACKOFFICE_OPTIONS)[number]["id"];
const DEFAULT_BACKOFFICE_ID: BackofficeId = "subway";

function getBackofficeConfig(backofficeId: BackofficeId) {
  return BACKOFFICE_OPTIONS.find((option) => option.id === backofficeId) ?? BACKOFFICE_OPTIONS[0];
}

const STORAGE_KEYS = {
  settings: "subway_settings",
  branches: "subway_branches",
  requestTypes: "subway_request_types",
  lastRequestType: "subway_last_request_type",
  savedCookie: "subway_cookie",
  saveCookie: "subway_save_cookie",
};

type BranchItem = { id: string; selected: boolean };

type RequestTypeConfig = {
  id: string;
  name: string;
  description: string;
  queryTemplate: string;
  operationName: string;
  variablesJson: string;
  rawJsonBody: string;
  customUrl: string;
  httpMethod: string;
  headersJson: string;
  responsePath: string;
  mappingJson: string;
  csvSchema: string;
  useCurl: boolean;
};

type RunResponse = {
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  totalBranches: number;
  branchesCompleted: number;
  errors: string[];
  events: { branch: string; page: number; status: string; message?: string }[];
  rawSample?: Record<string, unknown>[];
};

const ALL_ORDERS_QUERY_TEMPLATE = `query findData {
  PlOrders(Model: {PageNumber: {{PAGE_NUMBER}}, Filter: "{ 'OrganizationId': '{{ORG_ID}}','BranchUUID': '{{BRANCH_UUID}}', 'CreateDate': { '$lte': ISODate('{{END_DATE}}'), '$gte': ISODate('{{START_DATE}}') } }", Sort: "{CreateDate: -1}", PageSize: {{PAGE_SIZE}}}) {
    Data {
      ItemId
      CreateDate
      OrderNumber
      ChannelOrderDisplayId
      TotalAmount
      SubTotal
      DiscountAmount
      TaxAmount
      TipAmount
      DeliveryCost
      ServiceCharge
      PaymentMethod
      PaymentReferenceId
      OrderStatus
      OrderType
      CustomerName
      CustomerEmail
      CustomerPhoneNumber
      BranchUUID
      OrderProducts {
        Name
        ProductId
        ProductVariationName
        UnitPrice
        Quantity
        DiscountAmount
      }
    }
    TotalCount
    Success
    ErrorMessage
  }
}
`;

const ALL_ORDERS_MAPPING_JSON = JSON.stringify(
  {
    ItemId: "ItemId",
    CreateDate: "CreateDate",
    OrderNumber: "OrderNumber",
    ChannelOrderDisplayId: "ChannelOrderDisplayId",
    TotalAmount: "TotalAmount",
    SubTotal: "SubTotal",
    DiscountAmount: "DiscountAmount",
    TaxAmount: "TaxAmount",
    TipAmount: "TipAmount",
    DeliveryCost: "DeliveryCost",
    ServiceCharge: "ServiceCharge",
    PaymentMethod: "PaymentMethod",
    PaymentReferenceId: "PaymentReferenceId",
    OrderStatus: "OrderStatus",
    OrderType: "OrderType",
    CustomerName: "CustomerName",
    CustomerEmail: "CustomerEmail",
    CustomerPhoneNumber: "CustomerPhoneNumber",
    BranchUUID: "BranchUUID",
    FirstProductName: "OrderProducts[0].Name",
    FirstProductId: "OrderProducts[0].ProductId",
    FirstProductVariation: "OrderProducts[0].ProductVariationName",
    FirstProductUnitPrice: "OrderProducts[0].UnitPrice",
    FirstProductQuantity: "OrderProducts[0].Quantity",
  },
  null,
  2
);

const ALL_ORDERS_CSV_SCHEMA =
  "ItemId,CreateDate,OrderNumber,ChannelOrderDisplayId,TotalAmount,SubTotal,DiscountAmount,TaxAmount,TipAmount,DeliveryCost,ServiceCharge,PaymentMethod,PaymentReferenceId,OrderStatus,OrderType,CustomerName,CustomerEmail,CustomerPhoneNumber,BranchUUID,FirstProductName,FirstProductId,FirstProductVariation,FirstProductUnitPrice,FirstProductQuantity";

function formatDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function defaultDateRange(): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 7);
  return {
    startDate: formatDateInput(start),
    endDate: formatDateInput(end),
  };
}

const DEFAULT_REQUEST_TYPES: RequestTypeConfig[] = [
  {
    id: "refunded_products",
    name: "Refunded Products",
    description: "Returned orders with refunded product rows.",
    queryTemplate:
      "query findData {\\n  PlOrders(Model: {PageNumber: {{PAGE_NUMBER}}, Filter: \\\"{ 'OrganizationId': '{{ORG_ID}}','BranchUUID': '{{BRANCH_UUID}}', 'ReturnType': { $ne: null } }\\\", Sort: \\\"{CreateDate: -1}\\\", PageSize: {{PAGE_SIZE}}}) {\\n    Data {\\n      CreateDate\\n      BranchUUID\\n      OrderNumber\\n      ChannelOrderDisplayId\\n      PaymentMethod\\n      PaymentReferenceId\\n      OrderStatus\\n      OrderType\\n      OrderProducts {\\n        Name\\n        ProductId\\n        ProductVariationName\\n        ProductVariationPrice\\n        Quantity\\n        RefundedInfo {\\n          RefundedReason\\n          RefundedQuantity\\n          RefundedTime\\n          EmployeeId\\n          ManagerId\\n        }\\n      }\\n    }\\n    Success\\n    ErrorMessage\\n    TotalCount\\n  }\\n}\\n",
    operationName: "findData",
    variablesJson: "{}",
    rawJsonBody: "",
    customUrl: "",
    httpMethod: "POST",
    headersJson: "{}",
    responsePath: "",
    mappingJson: "{}",
    csvSchema:
      "BranchUUID,CreateDate,OrderNumber,ChannelOrderDisplayId,PaymentMethod,PaymentReferenceId,OrderStatus,OrderType,ProductName,ProductId,ProductVariationName,ProductVariationPrice,Quantity,RefundedAmount,RefundedReason,RefundedQuantity,RefundedTime,RefundedEmployeeId,RefundedManagerId",
    useCurl: false,
  },
  {
    id: "all_orders",
    name: "All Orders",
    description: "Paginated all-orders query with branch and page placeholders.",
    queryTemplate: ALL_ORDERS_QUERY_TEMPLATE,
    operationName: "findData",
    variablesJson: "{}",
    rawJsonBody: "",
    customUrl: "",
    httpMethod: "POST",
    headersJson: "{}",
    responsePath: "",
    mappingJson: ALL_ORDERS_MAPPING_JSON,
    csvSchema: ALL_ORDERS_CSV_SCHEMA,
    useCurl: false,
  },
  {
    id: "custom_http",
    name: "Custom HTTP / cURL",
    description: "Call any JSON endpoint or pasted cURL and export the response to CSV.",
    queryTemplate: "",
    operationName: "",
    variablesJson: "{}",
    rawJsonBody: "",
    customUrl: "",
    httpMethod: "GET",
    headersJson: "{}",
    responsePath: "",
    mappingJson: "{}",
    csvSchema: "",
    useCurl: true,
  },
];

function mergeRequestTypes(storedTypes: RequestTypeConfig[]): RequestTypeConfig[] {
  const defaultsById = new Map(DEFAULT_REQUEST_TYPES.map((type) => [type.id, type]));
  const mergedStored = storedTypes.map((type) => {
    const fallback = defaultsById.get(type.id);
    if (!fallback) return type;

    const normalizedQueryTemplate =
      type.queryTemplate && type.queryTemplate.includes("\\n")
        ? type.queryTemplate.replace(/\\n/g, "\n").replace(/\\"/g, '"')
        : type.queryTemplate;
    const normalizedRawJsonBody =
      type.rawJsonBody && type.rawJsonBody.includes("\\n")
        ? type.rawJsonBody.replace(/\\n/g, "\n").replace(/\\"/g, '"')
        : type.rawJsonBody;

    return {
      ...fallback,
      ...type,
      description: type.description || fallback.description,
      queryTemplate: normalizedQueryTemplate || fallback.queryTemplate,
      operationName: type.operationName || fallback.operationName,
      variablesJson: type.variablesJson || fallback.variablesJson,
      rawJsonBody: normalizedRawJsonBody || fallback.rawJsonBody,
      customUrl: type.customUrl || fallback.customUrl,
      httpMethod: type.httpMethod || fallback.httpMethod,
      headersJson: type.headersJson || fallback.headersJson,
      responsePath: type.responsePath || fallback.responsePath,
      mappingJson: type.mappingJson || fallback.mappingJson,
      csvSchema: type.csvSchema || fallback.csvSchema,
    };
  });

  const existingIds = new Set(mergedStored.map((type) => type.id));
  const missingDefaults = DEFAULT_REQUEST_TYPES.filter((type) => !existingIds.has(type.id));
  return [...mergedStored, ...missingDefaults];
}

function uniquePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function parseBranches(text: string): string[] {
  return uniquePreserveOrder(
    text
      .split(/\s|,|;/)
      .map((v) => v.trim())
      .filter(Boolean)
  );
}

function safeJsonParse(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

function App() {
  const defaults = defaultDateRange();
  const [cookie, setCookie] = useState("");
  const [saveCookie, setSaveCookie] = useState(false);
  const [backofficeId, setBackofficeId] = useState<BackofficeId>(DEFAULT_BACKOFFICE_ID);
  const [orgId, setOrgId] = useState<string>(getBackofficeConfig(DEFAULT_BACKOFFICE_ID).orgId);
  const [pageSize, setPageSize] = useState(100);
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [sleepSeconds, setSleepSeconds] = useState(0.15);
  const [timeoutSeconds, setTimeoutSeconds] = useState(60);
  const [origin, setOrigin] = useState("");
  const [referer, setReferer] = useState("");

  const [branches, setBranches] = useState<BranchItem[]>([]);
  const [branchSearch, setBranchSearch] = useState("");
  const [branchPaste, setBranchPaste] = useState("");
  const [singleBranch, setSingleBranch] = useState("");

  const [requestTypes, setRequestTypes] = useState<RequestTypeConfig[]>(DEFAULT_REQUEST_TYPES);
  const [selectedRequestTypeId, setSelectedRequestTypeId] = useState("refunded_products");

  const [curlInput, setCurlInput] = useState("");
  const [curlError, setCurlError] = useState("");

  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError] = useState("");
  const [runResponse, setRunResponse] = useState<RunResponse | null>(null);

  const [tableSearch, setTableSearch] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const pageSizeUi = 50;

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const storedSettings = loadLocal(STORAGE_KEYS.settings, null as any);
    if (storedSettings) {
      const storedBackofficeId = (storedSettings.backofficeId ?? DEFAULT_BACKOFFICE_ID) as BackofficeId;
      setBackofficeId(storedBackofficeId);
      setOrgId(storedSettings.orgId ?? getBackofficeConfig(storedBackofficeId).orgId);
      setPageSize(storedSettings.pageSize ?? 100);
      setStartDate(storedSettings.startDate ?? defaults.startDate);
      setEndDate(storedSettings.endDate ?? defaults.endDate);
      setSleepSeconds(storedSettings.sleepSeconds ?? 0.15);
      setTimeoutSeconds(storedSettings.timeoutSeconds ?? 60);
      setOrigin(storedSettings.origin ?? "");
      setReferer(storedSettings.referer ?? "");
    }

    const storedBranches = loadLocal<string[]>(STORAGE_KEYS.branches, []);
    if (storedBranches.length) {
      setBranches(storedBranches.map((id) => ({ id, selected: true })));
    }

    const storedTypes = loadLocal<RequestTypeConfig[] | null>(STORAGE_KEYS.requestTypes, null);
    if (storedTypes && storedTypes.length) {
      setRequestTypes(mergeRequestTypes(storedTypes));
    }

    const lastType = loadLocal<string | null>(STORAGE_KEYS.lastRequestType, null);
    if (lastType) {
      setSelectedRequestTypeId(lastType);
    }

    const savedCookieFlag = loadLocal<boolean>(STORAGE_KEYS.saveCookie, false);
    setSaveCookie(savedCookieFlag);
    if (savedCookieFlag) {
      const saved = loadLocal<string>(STORAGE_KEYS.savedCookie, "");
      if (saved) setCookie(saved);
    }
  }, []);

  useEffect(() => {
    saveLocal(STORAGE_KEYS.settings, {
      backofficeId,
      orgId,
      pageSize,
      startDate,
      endDate,
      sleepSeconds,
      timeoutSeconds,
      origin,
      referer,
    });
  }, [backofficeId, orgId, pageSize, startDate, endDate, sleepSeconds, timeoutSeconds, origin, referer]);

  useEffect(() => {
    saveLocal(STORAGE_KEYS.branches, branches.map((b) => b.id));
  }, [branches]);

  useEffect(() => {
    saveLocal(STORAGE_KEYS.requestTypes, requestTypes);
  }, [requestTypes]);

  useEffect(() => {
    saveLocal(STORAGE_KEYS.lastRequestType, selectedRequestTypeId);
  }, [selectedRequestTypeId]);

  useEffect(() => {
    saveLocal(STORAGE_KEYS.saveCookie, saveCookie);
    if (!saveCookie) {
      clearLocal(STORAGE_KEYS.savedCookie);
    } else {
      saveLocal(STORAGE_KEYS.savedCookie, cookie);
    }
  }, [saveCookie, cookie]);

  const selectedType = requestTypes.find((t) => t.id === selectedRequestTypeId) ?? requestTypes[0];
  const isCustomHttpType = selectedType?.id === "custom_http";
  const requiresBranches = !isCustomHttpType;

  const filteredBranches = branches.filter((b) =>
    b.id.toLowerCase().includes(branchSearch.toLowerCase())
  );

  const selectedBranches = branches.filter((b) => b.selected).map((b) => b.id);
  const canRun = !runLoading && (!requiresBranches || selectedBranches.length > 0);

  const mappedRows = useMemo(() => {
    if (!runResponse) return [] as Record<string, unknown>[];
    let rows = runResponse.rows;

    if (tableSearch.trim()) {
      const query = tableSearch.toLowerCase();
      rows = rows.filter((row) =>
        Object.values(row)
          .join(" ")
          .toLowerCase()
          .includes(query)
      );
    }

    if (sortKey) {
      const dir = sortDir === "asc" ? 1 : -1;
      rows = [...rows].sort((a, b) => {
        const av = a[sortKey] ?? "";
        const bv = b[sortKey] ?? "";
        if (av === bv) return 0;
        return av > bv ? dir : -dir;
      });
    }

    return rows;
  }, [runResponse, tableSearch, sortKey, sortDir]);

  const pagedRows = useMemo(() => {
    const start = (page - 1) * pageSizeUi;
    return mappedRows.slice(start, start + pageSizeUi);
  }, [mappedRows, page]);

  const totalPages = Math.max(1, Math.ceil(mappedRows.length / pageSizeUi));

  function updateRequestType(update: Partial<RequestTypeConfig>) {
    setRequestTypes((prev) =>
      prev.map((t) => (t.id === selectedRequestTypeId ? { ...t, ...update } : t))
    );
  }

  function updateRequestTypeById(requestTypeId: string, update: Partial<RequestTypeConfig>) {
    setRequestTypes((prev) =>
      prev.map((t) => (t.id === requestTypeId ? { ...t, ...update } : t))
    );
  }

  function addBranchesFromPaste() {
    const values = parseBranches(branchPaste);
    if (!values.length) return;
    setBranches((prev) => {
      const existing = prev.map((b) => b.id);
      const merged = uniquePreserveOrder([...existing, ...values]);
      return merged.map((id) => ({ id, selected: true }));
    });
    setBranchPaste("");
  }

  function addSingleBranch() {
    const value = singleBranch.trim();
    if (!value) return;
    setBranches((prev) => {
      const merged = uniquePreserveOrder([...prev.map((b) => b.id), value]);
      return merged.map((id) => ({ id, selected: true }));
    });
    setSingleBranch("");
  }

  function handleBackofficeChange(nextBackofficeId: BackofficeId) {
    setBackofficeId(nextBackofficeId);
    setOrgId(getBackofficeConfig(nextBackofficeId).orgId);
  }

  function removeBranch(id: string) {
    setBranches((prev) => prev.filter((b) => b.id !== id));
  }

  function toggleBranch(id: string) {
    setBranches((prev) => prev.map((b) => (b.id === id ? { ...b, selected: !b.selected } : b)));
  }

  function selectAllBranches(selected: boolean) {
    setBranches((prev) => prev.map((b) => ({ ...b, selected })));
  }

  async function handleParseCurl() {
    setCurlError("");
    if (!curlInput.trim()) return;
    try {
      const data = await postJson<{
        url?: string;
        method?: string;
        backofficeId?: BackofficeId;
        orgId?: string;
        branchUuids?: string[];
        startDate?: string;
        endDate?: string;
        headers?: Record<string, string>;
        cookie?: string;
        origin?: string;
        referer?: string;
        operationName?: string;
        query?: string;
        rawJsonBody?: string;
      }>("/api/parse-curl", { curl: curlInput });
      const targetRequestTypeId = !data.backofficeId && data.url ? "custom_http" : selectedRequestTypeId;
      const applyToTarget = (update: Partial<RequestTypeConfig>) =>
        updateRequestTypeById(targetRequestTypeId, update);

      if (data.backofficeId) handleBackofficeChange(data.backofficeId);
      if (data.url) applyToTarget({ customUrl: data.url });
      if (data.method) applyToTarget({ httpMethod: data.method });
      if (data.orgId) setOrgId(data.orgId);
      if (data.startDate) setStartDate(data.startDate.slice(0, 10));
      if (data.endDate) setEndDate(data.endDate.slice(0, 10));
      if (data.branchUuids && data.branchUuids.length) {
        setBranches((prev) => {
          const merged = uniquePreserveOrder([...prev.map((b) => b.id), ...data.branchUuids!]);
          return merged.map((id) => ({ id, selected: true }));
        });
      }
      if (data.cookie) setCookie(data.cookie);
      if (data.origin) setOrigin(data.origin);
      if (data.referer) setReferer(data.referer);
      if (data.headers) {
        const customHeaders = { ...data.headers };
        delete customHeaders.cookie;
        delete customHeaders.Cookie;
        delete customHeaders.origin;
        delete customHeaders.Origin;
        delete customHeaders.referer;
        delete customHeaders.Referer;
        applyToTarget({ headersJson: JSON.stringify(customHeaders, null, 2) });
      }
      if (data.operationName) applyToTarget({ operationName: data.operationName });
      if (data.query) applyToTarget({ queryTemplate: data.query });
      if (data.rawJsonBody) applyToTarget({ rawJsonBody: data.rawJsonBody, useCurl: true });
      if (data.url && !data.backofficeId) setSelectedRequestTypeId("custom_http");
    } catch (e: any) {
      setCurlError(e.message || "Failed to parse curl");
    }
  }

  function buildRunPayload() {
    const cleanCookie = (() => {
      const trimmed = cookie.trim();
      const lower = trimmed.toLowerCase();
      if (lower.startsWith("cookie:")) {
        return trimmed.slice(7).trim();
      }
      return trimmed;
    })();
    const mapping = safeJsonParse(selectedType.mappingJson);
    const variables = safeJsonParse(selectedType.variablesJson);
    const headers = safeJsonParse(selectedType.headersJson);

    const csvSchema = selectedType.csvSchema
      ? selectedType.csvSchema.split(",").map((v) => v.trim()).filter(Boolean)
      : undefined;

    return {
      cookie: cleanCookie,
      backofficeId,
      orgId,
      branchUuids: selectedBranches,
      startDate: startDate ? `${startDate}T00:00:00.000Z` : undefined,
      endDate: endDate ? `${endDate}T23:59:59.999Z` : undefined,
      pageSize,
      maxPages: INTERNAL_MAX_PAGES,
      sleepSeconds,
      timeoutSeconds,
      origin: origin || undefined,
      referer: referer || undefined,
      requestTypeId: selectedType.id,
      requestConfig: {
        queryTemplate: selectedType.queryTemplate || undefined,
        operationName: selectedType.operationName || undefined,
        variables: variables || undefined,
        rawJsonBody:
          selectedType.useCurl || isCustomHttpType ? selectedType.rawJsonBody || undefined : undefined,
        customUrl: isCustomHttpType ? selectedType.customUrl || undefined : undefined,
        httpMethod: isCustomHttpType ? selectedType.httpMethod || undefined : undefined,
        headers: headers as Record<string, string> | undefined,
        responsePath: isCustomHttpType ? selectedType.responsePath || undefined : undefined,
        mapping: mapping || undefined,
        csvSchema: csvSchema || undefined,
        useCurl: selectedType.useCurl,
      },
      previewLimit: 200,
    };
  }

  async function handleRun() {
    setRunError("");
    setRunResponse(null);
    setRunLoading(true);
    setPage(1);
    const payload = buildRunPayload();

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      const resp = await fetch("http://127.0.0.1:8000/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: abortRef.current.signal,
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `Request failed: ${resp.status}`);
      }

      const data = (await resp.json()) as RunResponse;
      setRunResponse(data);
    } catch (e: any) {
      if (e.name === "AbortError") {
        setRunError("Request cancelled.");
      } else {
        setRunError(e.message || "Run failed");
      }
    } finally {
      setRunLoading(false);
    }
  }

  async function handleExportCsv() {
    setRunError("");
    const payload = buildRunPayload();
    try {
      const blob = await postCsv("/api/export-csv", payload);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${selectedType.name.replace(/\s+/g, "_").toLowerCase()}_${timestamp}.csv`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setRunError(e.message || "CSV export failed");
    }
  }

  function clearResults() {
    setRunResponse(null);
    setRunError("");
    setTableSearch("");
    setSortKey(null);
    setSortDir("asc");
  }

  function cancelRun() {
    abortRef.current?.abort();
  }

  const selectedBackoffice = getBackofficeConfig(backofficeId);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>Alifs Chora Request App</h1>
          <p>Query GraphQL via FastAPI proxy and export CSV.</p>
        </div>
        <div className="header-actions">
          <button className="secondary" onClick={clearResults}>Clear Results</button>
          <button className="secondary" onClick={cancelRun} disabled={!runLoading}>Cancel</button>
          <button className="primary" onClick={handleRun} disabled={!canRun}>
            {runLoading ? "Running..." : "Run"}
          </button>
        </div>
      </header>

      <div className="layout">
        <section className="panel">
          <h2>Authentication</h2>
          <label>Cookie header</label>
          <textarea
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            placeholder="Paste full Cookie header value here"
            rows={4}
          />
          <div className="row">
            <label className="checkbox">
              <input
                type="checkbox"
                checked={saveCookie}
                onChange={(e) => setSaveCookie(e.target.checked)}
              />
              Save cookie locally (sensitive)
            </label>
            {!saveCookie && <span className="muted">Cookie is not stored.</span>}
          </div>

          <h2>Global Settings</h2>
          <div className="grid">
            <label>Backoffice</label>
            <select value={backofficeId} onChange={(e) => handleBackofficeChange(e.target.value as BackofficeId)}>
              {BACKOFFICE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>{option.name}</option>
              ))}
            </select>
            <label>Organization ID</label>
            <input value={orgId} onChange={(e) => setOrgId(e.target.value)} />
            <label>Page size</label>
            <input
              type="number"
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value))}
            />
            <label>Start date</label>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            <label>End date</label>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            <label>Sleep between requests (s)</label>
            <input
              type="number"
              step="0.01"
              value={sleepSeconds}
              onChange={(e) => setSleepSeconds(Number(e.target.value))}
            />
            <label>Timeout (s)</label>
            <input
              type="number"
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
            />
            <label>Origin override</label>
            <input
              value={origin}
              onChange={(e) => setOrigin(e.target.value)}
              placeholder={selectedBackoffice.origin}
            />
            <label>Referer override</label>
            <input
              value={referer}
              onChange={(e) => setReferer(e.target.value)}
              placeholder={selectedBackoffice.referer}
            />
          </div>

          <h2>Branch Manager</h2>
          <div className="row">
            <textarea
              value={branchPaste}
              onChange={(e) => setBranchPaste(e.target.value)}
              placeholder="Paste many BranchUUID values"
              rows={3}
            />
            <button className="secondary" onClick={addBranchesFromPaste}>
              Add branches
            </button>
          </div>
          <div className="row">
            <input
              value={singleBranch}
              onChange={(e) => setSingleBranch(e.target.value)}
              placeholder="Add single branch"
            />
            <button className="secondary" onClick={addSingleBranch}>Add</button>
          </div>
          <div className="row space-between">
            <div>
              <button className="ghost" onClick={() => selectAllBranches(true)}>Select all</button>
              <button className="ghost" onClick={() => selectAllBranches(false)}>Clear</button>
            </div>
            <div className="muted">Total branches: {branches.length}</div>
          </div>
          <input
            value={branchSearch}
            onChange={(e) => setBranchSearch(e.target.value)}
            placeholder="Search branches"
          />
          <div className="branch-list">
            {filteredBranches.map((b) => (
              <div key={b.id} className="branch-row">
                <label className="checkbox">
                  <input type="checkbox" checked={b.selected} onChange={() => toggleBranch(b.id)} />
                  <span>{b.id}</span>
                </label>
                <button className="ghost" onClick={() => removeBranch(b.id)}>Remove</button>
              </div>
            ))}
            {!filteredBranches.length && <div className="muted">No branches found.</div>}
          </div>
        </section>

        <section className="panel">
          <h2>Request Types</h2>
          <div className="row">
            <select
              value={selectedRequestTypeId}
              onChange={(e) => setSelectedRequestTypeId(e.target.value)}
            >
              {requestTypes.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            <span className="muted">{selectedType.description}</span>
          </div>

          <h3>cURL Import Helper</h3>
          <textarea
            value={curlInput}
            onChange={(e) => setCurlInput(e.target.value)}
            placeholder="Paste full curl from Chrome"
            rows={4}
          />
          <div className="row">
            <button className="secondary" onClick={handleParseCurl}>Parse curl</button>
            {curlError && <span className="error">{curlError}</span>}
          </div>

          {isCustomHttpType ? (
            <>
              <h3>Custom Request</h3>
              <label>Request URL</label>
              <input
                value={selectedType.customUrl}
                onChange={(e) => updateRequestType({ customUrl: e.target.value })}
                placeholder="https://example.com/api"
              />
              <label>HTTP method</label>
              <input
                value={selectedType.httpMethod}
                onChange={(e) => updateRequestType({ httpMethod: e.target.value.toUpperCase() })}
                placeholder="GET"
              />
              <label>Headers JSON</label>
              <textarea
                value={selectedType.headersJson}
                onChange={(e) => updateRequestType({ headersJson: e.target.value })}
                placeholder='{"Content-Type": "application/json"}'
                rows={4}
              />
              <label>Raw JSON body</label>
              <textarea
                value={selectedType.rawJsonBody}
                onChange={(e) => updateRequestType({ rawJsonBody: e.target.value })}
                placeholder='{"query": "..."}'
                rows={5}
              />
              <label>Response path (optional)</label>
              <input
                value={selectedType.responsePath}
                onChange={(e) => updateRequestType({ responsePath: e.target.value })}
                placeholder="data.items"
              />
              <div className="muted">
                Supports placeholders like {"{{BRANCH_UUID}}"}, {"{{ORG_ID}}"}, {"{{START_DATE}}"}, and {"{{END_DATE}}"}.
                Branches are optional in this mode.
              </div>
            </>
          ) : (
            <>
              <div className="row space-between">
                <h3>Request Template</h3>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={selectedType.useCurl}
                    onChange={(e) => updateRequestType({ useCurl: e.target.checked })}
                  />
                  Use raw JSON body from curl
                </label>
              </div>
              <label>Operation name</label>
              <input
                value={selectedType.operationName}
                onChange={(e) => updateRequestType({ operationName: e.target.value })}
                placeholder="OperationName"
              />
              <label>GraphQL query template</label>
              <textarea
                value={selectedType.queryTemplate}
                onChange={(e) => updateRequestType({ queryTemplate: e.target.value })}
                placeholder="Paste query template. Use {{BRANCH_UUID}}, {{PAGE_NUMBER}}, {{PAGE_SIZE}}, {{ORG_ID}}, {{START_DATE}}, {{END_DATE}}"
                rows={8}
              />
              <label>Variables JSON</label>
              <textarea
                value={selectedType.variablesJson}
                onChange={(e) => updateRequestType({ variablesJson: e.target.value })}
                placeholder='{"key": "value"}'
                rows={3}
              />
              <label>Raw JSON body (curl)</label>
              <textarea
                value={selectedType.rawJsonBody}
                onChange={(e) => updateRequestType({ rawJsonBody: e.target.value })}
                placeholder='{"operationName": "...", "query": "...", "variables": {}}'
                rows={4}
              />
            </>
          )}

          <h3>Field Mapping</h3>
          <label>Mapping JSON (column {"->"} path)</label>
          <textarea
            value={selectedType.mappingJson}
            onChange={(e) => updateRequestType({ mappingJson: e.target.value })}
            placeholder='{"OrderNumber": "OrderNumber", "FirstItem": "OrderProducts[0].Name"}'
            rows={4}
          />
          <label>CSV columns (comma separated)</label>
          <input
            value={selectedType.csvSchema}
            onChange={(e) => updateRequestType({ csvSchema: e.target.value })}
            placeholder="Column1,Column2,..."
          />
        </section>
      </div>

      <section className="panel">
        <h2>Run Status</h2>
        {runError && <div className="error">{runError}</div>}
        {runResponse && (
          <div className="status-grid">
            <div><strong>Total rows:</strong> {runResponse.totalRows}</div>
            <div><strong>Branches completed:</strong> {runResponse.branchesCompleted} / {runResponse.totalBranches}</div>
            <div><strong>Errors:</strong> {runResponse.errors.length}</div>
          </div>
        )}
        {runResponse && runResponse.events.length > 0 && (
          <div className="event-list">
            {runResponse.events.map((e, idx) => (
              <div key={`${e.branch}-${e.page}-${idx}`} className={`event ${e.status}`}>
                <span>{e.branch}</span>
                <span>page {e.page}</span>
                <span>{e.status}</span>
                {e.message && <span className="muted">{e.message}</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="row space-between results-toolbar">
          <h2>Results</h2>
          <div className="row results-actions">
            <button className="secondary" onClick={handleExportCsv} disabled={!canRun}>
              Export CSV
            </button>
            <input
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              placeholder="Search results"
            />
          </div>
        </div>

        {runResponse && runResponse.rows.length > 0 ? (
          <>
            <div className="results-table-wrap">
              <table className="results-table">
                <thead>
                  <tr>
                    {runResponse.columns.map((col) => (
                      <th
                        key={col}
                        onClick={() => {
                          if (sortKey === col) {
                            setSortDir(sortDir === "asc" ? "desc" : "asc");
                          } else {
                            setSortKey(col);
                            setSortDir("asc");
                          }
                        }}
                      >
                        {col}
                        {sortKey === col ? (sortDir === "asc" ? " ▲" : " ▼") : ""}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((row, idx) => (
                    <tr key={idx}>
                      {runResponse.columns.map((col) => (
                        <td key={col}>{String(row[col] ?? "")}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row space-between">
              <span className="muted">
                Page {page} of {totalPages}
              </span>
              <div className="row">
                <button className="ghost" onClick={() => setPage(1)} disabled={page === 1}>First</button>
                <button className="ghost" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>Prev</button>
                <button className="ghost" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>Next</button>
                <button className="ghost" onClick={() => setPage(totalPages)} disabled={page === totalPages}>Last</button>
              </div>
            </div>
          </>
        ) : (
          <div className="muted">No results to display yet.</div>
        )}
      </section>

      {runResponse?.rawSample && runResponse.rawSample.length > 0 && (
        <section className="panel">
          <h2>Raw JSON Preview</h2>
          <pre>{JSON.stringify(runResponse.rawSample.slice(0, 5), null, 2)}</pre>
        </section>
      )}
    </div>
  );
}

export default App;
