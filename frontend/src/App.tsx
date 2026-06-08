import { useEffect, useMemo, useRef, useState } from "react";
import { postBlob, postCsv, postJson } from "./utils/api";
import { clearLocal, loadLocal, saveLocal } from "./utils/storage";
import { useAuth } from "./auth/AuthContext";
import { HealthDashboard } from "./HealthDashboard";

type AppView = "tool" | "dashboard" | "omk-pay";

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

const BURGERMEISTER_BRANCHES = [
  { id: "1d470650-0375-4959-8bfc-d7030248ca20", name: "BM Kaserne" },
  { id: "e35ed519-74f8-463a-b2a2-f408fcd72151", name: "BM Altstetten" },
  { id: "b7443793-591d-4e4c-93b5-8583f7c9083b", name: "BM Gerbergasse" },
  { id: "27eb7c62-0f77-4d0d-81b0-f93a6baad65c", name: "BM Enge" },
  { id: "d9c34c58-a92e-4872-bd09-8283079d85a6", name: "BM Spisertor" },
  { id: "091b0b59-c82c-4d83-97f0-4a7947c0dc38", name: "BM Claraplatz" },
  { id: "963321fc-85c3-4f9e-a55e-0c2215a290a6", name: "BM Eschenvorstadt" },
  { id: "6e93fdc5-8b80-4263-a002-2e138d7785ce", name: "BM Escherwyss" },
  { id: "4a4c04f0-5566-4880-9e86-18b8afc0f4fb", name: "BM Langstrasse" },
  { id: "9b7ce726-a94d-4eac-9e7f-ac8e891f2c7f", name: "BM Limmatplatz" },
  { id: "976ebb76-56be-4600-86d7-8f2fa1ce9772", name: "BM Oberdorf" },
  { id: "46cfdc64-8fb8-4c0b-ad5b-40fe5e6f0bee", name: "BM Oerlikon" },
  { id: "142f98a7-6055-4108-aba5-4c34c558fde7", name: "BM Winterthur" },
] as const;

const KITCHEN_REUNION_BRANCHES = [
  { id: "7302bb40-a44f-4efa-8165-24e20a8f186a", name: "Kitchen Reunion - Welle 7" },
  { id: "eab69058-1d2a-4ca0-a793-c212ff3ab58f", name: "Shoppyland, Schoenbuehl" },
  { id: "796a0ca6-75b4-4eaf-a466-49a40c59bfd5", name: "Shoppy Tivoli, Thai Wok" },
  { id: "a3b12f08-36f1-4011-a28c-81a7057cf4f9", name: "Shoppy Tivoli, Guapo Mexicano" },
  { id: "ae14f598-0672-4531-92b4-92ea7ed42092", name: "Mall Of Switzerland" },
  { id: "a863fcd8-c403-4bcd-b843-d9354ac2f0b4", name: "Stueckipark" },
] as const;

const OH_MY_GREEK_BRANCHES = [
  {
    id: "dd87e0bfc1bc426f99774429b7c263d2",
    name: "Oh My Greek - Oerlikon",
    orgId: "2a9cf8c3-9bad-40a2-bfd1-580a8059360b",
  },
  {
    id: "73354c9dd4e846f2978d1fdfe4535fe3",
    name: "Oh My Greek - Zurich HB",
    orgId: "61b38dba-21c1-426a-b841-938667d55e59",
  },
  {
    id: "c526cd3c2e8f41ea824cd5c19f9f0bea",
    name: "Oh My Greek - Winterthur",
    orgId: "e5e0333f-83a1-4a9f-9820-4055971a0435",
  },
] as const;

function normalizeBranchId(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "");
}

const BRANCH_NAME_BY_ID = new Map(
  [...BURGERMEISTER_BRANCHES, ...KITCHEN_REUNION_BRANCHES, ...OH_MY_GREEK_BRANCHES].map((branch) => [
    normalizeBranchId(branch.id),
    branch.name,
  ])
);

function getBranchLabel(branchId: string): string {
  return BRANCH_NAME_BY_ID.get(normalizeBranchId(branchId)) ?? branchId;
}

const TEMPLATES = [
  {
    id: "custom",
    name: "Custom",
    backofficeId: "subway" as BackofficeId,
    orgId: "",
    branches: [] as string[],
  },
  {
    id: "burgermeister",
    name: "Burgermeister",
    backofficeId: "ordermonkey" as BackofficeId,
    orgId: "64cbdabb-8473-4110-b99b-862a0dd0d0c5",
    branches: BURGERMEISTER_BRANCHES.map((branch) => normalizeBranchId(branch.id)),
  },
  {
    id: "kitchen_reunion",
    name: "Kitchen Reunion",
    backofficeId: "ordermonkey" as BackofficeId,
    orgId: "04675bce-b515-4eea-89d0-b74cf0db1bd5",
    branches: KITCHEN_REUNION_BRANCHES.map((branch) => normalizeBranchId(branch.id)),
  },
  {
    id: "oh_my_greek",
    name: "Oh My Greek",
    backofficeId: "ordermonkey" as BackofficeId,
    orgId: OH_MY_GREEK_BRANCHES[0].orgId,
    branches: OH_MY_GREEK_BRANCHES.map((branch) => normalizeBranchId(branch.id)),
    branchOrgIds: Object.fromEntries(
      OH_MY_GREEK_BRANCHES.map((branch) => [normalizeBranchId(branch.id), branch.orgId])
    ),
  },
];

const STORAGE_KEYS = {
  settings: "subway_settings",
  branches: "subway_branches",
  requestTypes: "subway_request_types",
  lastRequestType: "subway_last_request_type",
  savedCookie: "subway_cookie",
  saveCookie: "subway_save_cookie",
  template: "subway_template",
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
  PlOrders(Model: {PageNumber: {{PAGE_NUMBER}}, Filter: "{ 'OrganizationId': '{{ORG_ID}}', 'BranchUUID': '{{BRANCH_UUID}}' ,'CreateDate': {'$lte': ISODate('{{END_DATE}}'), '$gte': ISODate('{{START_DATE}}') }, }", Sort: "{CreateDate: -1}", PageSize: {{PAGE_SIZE}}}) {
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
  "ItemId,CreateDate,OrderNumber,ChannelOrderDisplayId,TotalAmount,SubTotal,DiscountAmount,TaxAmount,TipAmount,DeliveryCost,PaymentMethod,PaymentReferenceId,OrderStatus,OrderType,CustomerName,CustomerEmail,CustomerPhoneNumber,BranchUUID,FirstProductName,FirstProductId,FirstProductVariation,FirstProductUnitPrice,FirstProductQuantity";

const FAILED_ORDERS_QUERY_TEMPLATE = `query findData {
  PlOrders(Model: {PageNumber: {{PAGE_NUMBER}}, Filter: "{ 'OrganizationId': '{{ORG_ID}}', 'BranchUUID': '{{BRANCH_UUID}}', '$or': [{'OrderStatus': 'Failed'}, {'OrderNote': 'failed'}] ,'CreateDate': {'$lte': ISODate('{{END_DATE}}'), '$gte': ISODate('{{START_DATE}}') }, }", Sort: "{CreateDate: -1}", PageSize: {{PAGE_SIZE}}}) {
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

const FAILED_ORDERS_MAPPING_JSON = ALL_ORDERS_MAPPING_JSON;

const FAILED_ORDERS_CSV_SCHEMA = ALL_ORDERS_CSV_SCHEMA;

const ALL_PRODUCTS_QUERY_TEMPLATE = `query findData {
  PlOrders(Model: {PageNumber: {{PAGE_NUMBER}}, Filter: "{ 'OrganizationId': '{{ORG_ID}}', 'BranchUUID': '{{BRANCH_UUID}}' ,'CreateDate': {'$lte': ISODate('{{END_DATE}}'), '$gte': ISODate('{{START_DATE}}') }, }", Sort: "{CreateDate: -1}", PageSize: {{PAGE_SIZE}}}) {
    Data {
      ItemId
      CreateDate
      OrderNumber
      BranchUUID
      TotalAmount
      OrderType
      PaymentMethod
      OrderProducts {
        Name
        ProductId
        ProductVariationName
        UnitPrice
        Quantity
        CategoryName
        TaxId
        TaxRate
        DiscountAmount
        OrderProductModifiers {
          Name
          Price
          Quantity
        }
      }
    }
    TotalCount
    Success
    ErrorMessage
  }
}
`;

const ALL_PRODUCTS_MAPPING_JSON = JSON.stringify(
  {
    OrderNumber: "OrderNumber",
    CreateDate: "CreateDate",
    BranchUUID: "BranchUUID",
    OrderType: "OrderType",
    PaymentMethod: "PaymentMethod",
    TotalAmount: "TotalAmount",
    ProductName: "OrderProducts[0].Name",
    ProductId: "OrderProducts[0].ProductId",
    ProductVariation: "OrderProducts[0].ProductVariationName",
    UnitPrice: "OrderProducts[0].UnitPrice",
    Quantity: "OrderProducts[0].Quantity",
    CategoryName: "OrderProducts[0].CategoryName",
    TaxRate: "OrderProducts[0].TaxRate",
    DiscountAmount: "OrderProducts[0].DiscountAmount",
  },
  null,
  2
);

const ALL_PRODUCTS_CSV_SCHEMA =
  "OrderNumber,CreateDate,BranchUUID,OrderType,PaymentMethod,TotalAmount,ProductName,ProductId,ProductVariation,UnitPrice,Quantity,CategoryName,TaxRate,DiscountAmount";

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
    name: "All Orders (Summary)",
    description: "Order-level summary with totals, payment, and first product.",
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
    id: "failed_orders",
    name: "Failed Orders",
    description: "Orders filtered to OrderStatus = failed.",
    queryTemplate: FAILED_ORDERS_QUERY_TEMPLATE,
    operationName: "findData",
    variablesJson: "{}",
    rawJsonBody: "",
    customUrl: "",
    httpMethod: "POST",
    headersJson: "{}",
    responsePath: "",
    mappingJson: FAILED_ORDERS_MAPPING_JSON,
    csvSchema: FAILED_ORDERS_CSV_SCHEMA,
    useCurl: false,
  },
  {
    id: "all_products",
    name: "All Orders (Products)",
    description: "Product-level breakdown with TaxRate, CategoryName, and UnitPrice per product.",
    queryTemplate: ALL_PRODUCTS_QUERY_TEMPLATE,
    operationName: "findData",
    variablesJson: "{}",
    rawJsonBody: "",
    customUrl: "",
    httpMethod: "POST",
    headersJson: "{}",
    responsePath: "",
    mappingJson: ALL_PRODUCTS_MAPPING_JSON,
    csvSchema: ALL_PRODUCTS_CSV_SCHEMA,
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
      .map((v) => normalizeBranchId(v))
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

function cleanCookieHeader(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith("cookie:") ? trimmed.slice(7).trim() : trimmed;
}

function App() {
  const { user, logout } = useAuth();
  const [appView, setAppView] = useState<AppView>("tool");
  const defaults = defaultDateRange();
  const [cookie, setCookie] = useState("");
  const [branchCookies, setBranchCookies] = useState<Record<string, string>>({});
  const [saveCookie, setSaveCookie] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState("custom");
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

  const [omkKpiStartDate, setOmkKpiStartDate] = useState(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 30);
    return start.toISOString().slice(0, 10);
  });
  const [omkKpiEndDate, setOmkKpiEndDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [omkKpiResults, setOmkKpiResults] = useState<any | null>(null);
  const [omkKpiLoading, setOmkKpiLoading] = useState(false);
  const [omkKpiError, setOmkKpiError] = useState("");

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const storedTemplate = loadLocal<string>(STORAGE_KEYS.template, "custom");
    setSelectedTemplateId(storedTemplate);

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
  const selectedTemplate = TEMPLATES.find((t) => t.id === selectedTemplateId);
  const selectedTemplateBranchOrgIds =
    selectedTemplate && "branchOrgIds" in selectedTemplate ? selectedTemplate.branchOrgIds : undefined;
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
    const value = normalizeBranchId(singleBranch);
    if (!value) return;
    setBranches((prev) => {
      const merged = uniquePreserveOrder([...prev.map((b) => b.id), value]);
      return merged.map((id) => ({ id, selected: true }));
    });
    setSingleBranch("");
  }

  function handleTemplateChange(templateId: string) {
    setSelectedTemplateId(templateId);
    saveLocal(STORAGE_KEYS.template, templateId);
    const tpl = TEMPLATES.find((t) => t.id === templateId);
    if (!tpl || tpl.id === "custom") return;
    setBackofficeId(tpl.backofficeId);
    setOrgId(tpl.orgId);
    if (tpl.branches.length > 0) {
      setBranches(tpl.branches.map((id) => ({ id, selected: true })));
    }
    if ("branchOrgIds" in tpl) {
      setBranchCookies(
        Object.fromEntries(tpl.branches.map((id) => [id, branchCookies[id] || ""]))
      );
    } else {
      setBranchCookies({});
    }
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
    const cleanCookie = cleanCookieHeader(cookie);
    const mapping = safeJsonParse(selectedType.mappingJson);
    const variables = safeJsonParse(selectedType.variablesJson);
    const headers = safeJsonParse(selectedType.headersJson);

    const csvSchema = selectedType.csvSchema
      ? selectedType.csvSchema.split(",").map((v) => v.trim()).filter(Boolean)
      : undefined;
    const branchOrgIds =
      selectedTemplateBranchOrgIds
        ? Object.fromEntries(
            selectedBranches
              .map((branch) => [branch, selectedTemplateBranchOrgIds[normalizeBranchId(branch)]])
              .filter((entry): entry is [string, string] => Boolean(entry[1]))
          )
        : undefined;
    const cleanedBranchCookies = Object.fromEntries(
      selectedBranches
        .map((branch) => [branch, cleanCookieHeader(branchCookies[normalizeBranchId(branch)] || "")])
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
    );

    return {
      cookie: cleanCookie,
      backofficeId,
      orgId,
      branchUuids: selectedBranches,
      branchOrgIds,
      branchCookies: Object.keys(cleanedBranchCookies).length ? cleanedBranchCookies : undefined,
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
      const { blob, partialErrors, errorCount } = await postCsv("/api/export-csv", payload);
      if (blob.size === 0) {
        setRunError("Export returned an empty file. Your session cookie may have expired — refresh it and try again.");
        return;
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${selectedType.name.replace(/\s+/g, "_").toLowerCase()}_${timestamp}.csv`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (partialErrors) {
        setRunError(`Downloaded partial results. ${errorCount} branch${errorCount !== 1 ? "es" : ""} failed:\n${partialErrors}`);
      }
    } catch (e: any) {
      setRunError(e.message || "CSV export failed");
    }
  }

  async function handleExportAccountingXlsx() {
    setRunError("");
    const payload = buildRunPayload();
    try {
      const { blob, partialErrors, errorCount } = await postBlob("/api/export-accounting-xlsx", payload);
      if (blob.size === 0) {
        setRunError("Accounting export returned an empty file.");
        return;
      }
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `kitchen_reunion_accounting_${timestamp}.xlsx`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (partialErrors) {
        setRunError(`Downloaded partial results. ${errorCount} branch${errorCount !== 1 ? "es" : ""} failed:\n${partialErrors}`);
      }
    } catch (e: any) {
      setRunError(e.message || "Accounting XLSX export failed");
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

  async function loadOmkKpiResults() {
    setOmkKpiError("");
    try {
      const res = await fetch("http://127.0.0.1:8000/api/omk-pay/kpi/results");
      if (!res.ok) {
        throw new Error(`Failed to load KPI results: ${res.status}`);
      }
      const data = await res.json();
      setOmkKpiResults(data);
    } catch (e: any) {
      setOmkKpiError(e.message || "Failed to load KPI results");
    }
  }

  async function runOmkKpiCalculation() {
    setOmkKpiLoading(true);
    setOmkKpiError("");
    setOmkKpiResults(null);
    try {
      const daysBack = Math.floor((new Date(omkKpiEndDate).getTime() - new Date(omkKpiStartDate).getTime()) / (1000 * 60 * 60 * 24)) || 7;
      const res = await fetch(`http://127.0.0.1:8000/api/omk-pay/kpi/run-auto?days_back=${daysBack}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        throw new Error(`KPI calculation failed: ${res.status}`);
      }
      const data = await res.json();
      setOmkKpiResults(data);
    } catch (e: any) {
      setOmkKpiError(e.message || "KPI calculation failed");
    } finally {
      setOmkKpiLoading(false);
    }
  }

  useEffect(() => {
    loadOmkKpiResults();
  }, []);

  const selectedBackoffice = getBackofficeConfig(backofficeId);

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>OMK Operations</h1>
          <p>GraphQL query tool &amp; customer health dashboard</p>
        </div>
        <div className="header-actions">
          {user && <span className="header-user">{user.email}</span>}
          {appView === "tool" && (
            <>
              <button className="secondary" onClick={clearResults}>Clear Results</button>
              <button className="secondary" onClick={cancelRun} disabled={!runLoading}>Cancel</button>
              <button className="primary" onClick={handleRun} disabled={!canRun}>
                {runLoading ? "Running..." : "Run"}
              </button>
            </>
          )}
          <button className="ghost" onClick={logout} title="Sign out">Sign out</button>
        </div>
      </header>

      <nav className="app-nav">
        <button
          className={`nav-tab ${appView === "tool" ? "nav-tab--active" : ""}`}
          onClick={() => setAppView("tool")}
        >
          Query Tool
        </button>
        <button
          className={`nav-tab ${appView === "dashboard" ? "nav-tab--active" : ""}`}
          onClick={() => setAppView("dashboard")}
        >
          Customer Health
        </button>
        <button
          className={`nav-tab ${appView === "omk-pay" ? "nav-tab--active" : ""}`}
          onClick={() => setAppView("omk-pay")}
        >
          OMK Pay Reporting
        </button>
      </nav>

      {appView === "dashboard" && (
        <section className="panel">
          <h2>Customer Health Dashboard</h2>
          <HealthDashboard />
        </section>
      )}

      {appView === "omk-pay" && (
        <section className="panel">
          <h2>OMK Pay KPI Dashboard</h2>
          <p style={{ color: "#666", fontSize: "0.95rem" }}>
            Automatically fetches settlement data for all organizations from <code>orgs.json</code> and calculates KPIs including revenue, fees, and profit margins.
          </p>
          
          <div style={{ marginBottom: "2rem", padding: "1rem", backgroundColor: "#f9f9f9", borderRadius: "4px" }}>
            <h3 style={{ marginTop: 0 }}>Date Range</h3>
            <div className="grid">
              <div className="form-field">
                <label>Start Date</label>
                <input
                  type="date"
                  value={omkKpiStartDate}
                  onChange={(e) => setOmkKpiStartDate(e.target.value)}
                />
              </div>
              <div className="form-field">
                <label>End Date</label>
                <input
                  type="date"
                  value={omkKpiEndDate}
                  onChange={(e) => setOmkKpiEndDate(e.target.value)}
                />
              </div>
            </div>
            <div className="row">
              <button
                className="primary"
                onClick={runOmkKpiCalculation}
                disabled={omkKpiLoading}
              >
                {omkKpiLoading ? "Auto-Running..." : "Auto-Run KPI for All Orgs"}
              </button>
              <button className="secondary" onClick={loadOmkKpiResults}>
                Reload Results
              </button>
              <button
                className="ghost"
                onClick={async () => {
                  try {
                    const debugRes = await fetch("http://127.0.0.1:8000/api/omk-pay/kpi/debug-settlements", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        org_name: "burgermeister",
                        start_date: omkKpiStartDate,
                        end_date: omkKpiEndDate,
                      }),
                    });
                    const debugData = await debugRes.json();
                    console.log("DEBUG Settlement Response:", debugData);
                    alert("Check console (F12) for DEBUG response - Status: " + (debugData.status_code || "?"));
                  } catch (e) {
                    alert("Debug failed: " + (e as Error).message);
                  }
                }}
              >
                Debug: Raw API Response
              </button>
            </div>
            {omkKpiError && <div style={{ color: "#d32f2f", marginTop: "0.5rem" }}>{omkKpiError}</div>}
          </div>

          {omkKpiResults && (
            <div>
              <div style={{ marginBottom: "1.5rem", padding: "1rem", backgroundColor: "#e8f5e9", borderRadius: "4px" }}>
                <h3 style={{ marginTop: 0 }}>Summary</h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1rem" }}>
                  <div>
                    <div style={{ fontSize: "0.85rem", color: "#666" }}>Total Revenue</div>
                    <div style={{ fontSize: "1.3rem", fontWeight: "bold" }}>
                      CHF {omkKpiResults.organizations
                        ? Object.values(omkKpiResults.organizations as any)
                            .reduce((sum: number, org: any) => sum + (org.total_revenue || 0), 0)
                            .toFixed(2)
                        : "0.00"}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "0.85rem", color: "#666" }}>Total Fees</div>
                    <div style={{ fontSize: "1.3rem", fontWeight: "bold", color: "#d32f2f" }}>
                      CHF {omkKpiResults.organizations
                        ? Object.values(omkKpiResults.organizations as any)
                            .reduce((sum: number, org: any) => sum + (org.total_fees || 0), 0)
                            .toFixed(2)
                        : "0.00"}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "0.85rem", color: "#666" }}>Total Profit</div>
                    <div style={{ fontSize: "1.3rem", fontWeight: "bold", color: "#2e7d32" }}>
                      CHF {omkKpiResults.organizations
                        ? Object.values(omkKpiResults.organizations as any)
                            .reduce((sum: number, org: any) => sum + (org.total_profit || 0), 0)
                            .toFixed(2)
                        : "0.00"}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: "0.85rem", color: "#666" }}>Transactions</div>
                    <div style={{ fontSize: "1.3rem", fontWeight: "bold" }}>
                      {omkKpiResults.total_transactions || 0}
                    </div>
                  </div>
                </div>
              </div>

              <h3>Organization Details</h3>
              {Object.entries(omkKpiResults.organizations || {}).length > 0 ? (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.9rem" }}>
                    <thead>
                      <tr style={{ backgroundColor: "#f5f5f5", borderBottom: "2px solid #ccc" }}>
                        <th style={{ padding: "0.5rem", textAlign: "left" }}>Organization</th>
                        <th style={{ padding: "0.5rem", textAlign: "right" }}>Revenue (CHF)</th>
                        <th style={{ padding: "0.5rem", textAlign: "right" }}>Fees (CHF)</th>
                        <th style={{ padding: "0.5rem", textAlign: "right" }}>Profit (CHF)</th>
                        <th style={{ padding: "0.5rem", textAlign: "right" }}>Margin %</th>
                        <th style={{ padding: "0.5rem", textAlign: "center" }}>Transactions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(omkKpiResults.organizations || {}).map(([key, org]: [string, any]) => (
                        <tr key={key} style={{ borderBottom: "1px solid #eee" }}>
                          <td style={{ padding: "0.5rem", fontFamily: "monospace", fontSize: "0.85rem" }}>
                            {org.organization_id}
                          </td>
                          <td style={{ padding: "0.5rem", textAlign: "right" }}>
                            {org.total_revenue?.toFixed(2) || "0.00"}
                          </td>
                          <td style={{ padding: "0.5rem", textAlign: "right", color: "#d32f2f" }}>
                            {org.total_fees?.toFixed(2) || "0.00"}
                          </td>
                          <td style={{ padding: "0.5rem", textAlign: "right", fontWeight: "bold", color: "#2e7d32" }}>
                            {org.total_profit?.toFixed(2) || "0.00"}
                          </td>
                          <td style={{ padding: "0.5rem", textAlign: "right" }}>
                            {org.profit_margin_pct?.toFixed(2) || "0.00"}%
                          </td>
                          <td style={{ padding: "0.5rem", textAlign: "center" }}>
                            {org.transaction_count || 0}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ color: "#999", padding: "1rem" }}>No organization data available.</div>
              )}

              <h3 style={{ marginTop: "2rem" }}>Card Type Breakdown</h3>
              {Object.entries(omkKpiResults.organizations || {}).map(([key, org]: [string, any]) =>
                Object.entries(org.card_type_breakdown || {}).length > 0 ? (
                  <div key={key} style={{ marginBottom: "1.5rem", padding: "1rem", backgroundColor: "#f9f9f9", borderRadius: "4px" }}>
                    <h4 style={{ marginTop: 0 }}>{org.organization_id}</h4>
                    <div style={{ overflowX: "auto" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" }}>
                        <thead>
                          <tr style={{ backgroundColor: "#f0f0f0", borderBottom: "1px solid #ccc" }}>
                            <th style={{ padding: "0.4rem", textAlign: "left" }}>Card Type</th>
                            <th style={{ padding: "0.4rem", textAlign: "right" }}>Count</th>
                            <th style={{ padding: "0.4rem", textAlign: "right" }}>Revenue (CHF)</th>
                            <th style={{ padding: "0.4rem", textAlign: "right" }}>Fees (CHF)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {Object.entries(org.card_type_breakdown).map(([cardType, breakdown]: [string, any]) => (
                            <tr key={cardType} style={{ borderBottom: "1px solid #eee" }}>
                              <td style={{ padding: "0.4rem" }}>{cardType}</td>
                              <td style={{ padding: "0.4rem", textAlign: "right" }}>{breakdown.count || 0}</td>
                              <td style={{ padding: "0.4rem", textAlign: "right" }}>
                                {breakdown.revenue?.toFixed(2) || "0.00"}
                              </td>
                              <td style={{ padding: "0.4rem", textAlign: "right", color: "#d32f2f" }}>
                                {breakdown.fees?.toFixed(2) || "0.00"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null
              )}
            </div>
          )}
        </section>
      )}

      {appView === "tool" && (
        <>
          <section className="panel">
            <h2>Authentication</h2>
            <label>Cookie header</label>
            <textarea
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              placeholder="Paste full Cookie header value here"
              rows={4}
            />
            {selectedTemplateBranchOrgIds && (
              <div className="branch-cookie-list">
                <h3>Per-branch cookies</h3>
                <div className="muted">
                  Use these when each branch needs a different login. Empty fields use the global cookie above.
                </div>
                {selectedBranches.map((branch) => (
                  <div className="branch-cookie-field" key={branch}>
                    <label>
                      {getBranchLabel(branch)}
                      <span className="muted"> ({branch})</span>
                    </label>
                    <textarea
                      value={branchCookies[normalizeBranchId(branch)] || ""}
                      onChange={(e) =>
                        setBranchCookies((prev) => ({
                          ...prev,
                          [normalizeBranchId(branch)]: e.target.value,
                        }))
                      }
                      placeholder="Paste Cookie header for this branch"
                      rows={3}
                    />
                  </div>
                ))}
              </div>
            )}
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
            <div className="form-field">
              <label>Template</label>
              <select value={selectedTemplateId} onChange={(e) => handleTemplateChange(e.target.value)}>
                {TEMPLATES.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label>Backoffice</label>
              <select value={backofficeId} onChange={(e) => handleBackofficeChange(e.target.value as BackofficeId)}>
                {BACKOFFICE_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label>Organization ID</label>
              <input value={orgId} onChange={(e) => setOrgId(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Page size</label>
              <input
                type="number"
                value={pageSize}
                onChange={(e) => setPageSize(Number(e.target.value))}
              />
            </div>
            <div className="form-field">
              <label>Start date</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="form-field">
              <label>End date</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div className="form-field">
              <label>Sleep between requests (s)</label>
              <input
                type="number"
                step="0.01"
                value={sleepSeconds}
                onChange={(e) => setSleepSeconds(Number(e.target.value))}
              />
            </div>
            <div className="form-field">
              <label>Timeout (s)</label>
              <input
                type="number"
                value={timeoutSeconds}
                onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
              />
            </div>
            <div className="form-field">
              <label>Origin override</label>
              <input
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
                placeholder={selectedBackoffice.origin}
              />
            </div>
            <div className="form-field">
              <label>Referer override</label>
              <input
                value={referer}
                onChange={(e) => setReferer(e.target.value)}
                placeholder={selectedBackoffice.referer}
              />
            </div>
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
                  <span>{getBranchLabel(b.id)} ({b.id})</span>
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
                <span>{getBranchLabel(e.branch)}{getBranchLabel(e.branch) !== e.branch ? ` (${e.branch})` : ""}</span>
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
            {selectedTemplateId === "kitchen_reunion" && (
              <button className="secondary" onClick={handleExportAccountingXlsx} disabled={!canRun}>
                Export Accounting XLSX
              </button>
            )}
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
      </>
      )}
    </div>
  );
}

export default App;
