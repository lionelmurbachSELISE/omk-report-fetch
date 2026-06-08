"""OMK Pay KPI Service - Fetch settlements, calculate fees, and generate KPIs per organization."""

import json
import logging
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import requests
from pydantic import BaseModel

logger = logging.getLogger("omk_pay_kpi")

# Auth URLs
_CMS_IDENTITY_URL = "https://cms.ordermonkey.com/api/identity/v100/identity/token"
_BLOCKS_API = "https://api.seliseblocks.com"
_CMS_ORIGIN = "https://cms.ordermonkey.com"
_X_BLOCKS_KEY = "Df2bcc056a20948d7b124d1be4c5925e0"

# Fee structure: (Card Type) -> (total %, fix CHF)
CARD_TYPE_FEES = {
    "MC Credit": (0.0088, 0.050),
    "Visa Credit": (0.0078, 0.050),
    "MC Debit": (0.0060, 0.050),
    "Maestro": (0.0060, 0.050),
    "Visa Debit": (0.0059, 0.050),
    "Twint": (0.0090, 0.050),
}

# Map payment methods to card types (adapts to various API response formats)
PAYMENT_METHOD_MAPPING = {
    "mastercard_credit": "MC Credit",
    "visa_credit": "Visa Credit",
    "mastercard_debit": "MC Debit",
    "maestro": "Maestro",
    "visa_debit": "Visa Debit",
    "twint": "Twint",
    "mc_credit": "MC Credit",
    "visa": "Visa Credit",
    "mastercard": "MC Credit",
    "debit": "MC Debit",
}

# Paths
_ORGS_PATH = Path(__file__).parent.parent / "orgs.json"
_RESULTS_PATH = Path(__file__).parent.parent / "omk_pay_kpi_results.json"


class OrgConfig(BaseModel):
    name: str
    orgId: str
    email: str
    password: str


def load_orgs() -> List[OrgConfig]:
    """Load organizations from orgs.json."""
    if not _ORGS_PATH.exists():
        logger.warning(f"orgs.json not found at {_ORGS_PATH}")
        return []
    try:
        with open(_ORGS_PATH) as f:
            data = json.load(f)
        return [OrgConfig(**org) for org in data]
    except Exception as e:
        logger.error(f"Failed to load orgs.json: {e}")
        return []


def authenticate(email: str, password: str) -> str:
    """Authenticate with CMS and return cookie string."""
    body = urllib.parse.urlencode({
        "grant_type": "password",
        "username": email,
        "password": password,
    })

    for url in [_CMS_IDENTITY_URL, f"{_BLOCKS_API}/idp/v1/Authentication/Token"]:
        try:
            resp = requests.post(
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
                logger.debug(f"Auth attempt at {url} returned {resp.status_code}, trying next")
                continue
            data = resp.json()
            access_token = data.get("accessToken") or data.get("access_token")
            refresh_token = data.get("refreshToken") or data.get("refresh_token")
            if not access_token:
                continue
            cookie = f"cms.ordermonkey.com={access_token}; x-blocks-key={_X_BLOCKS_KEY}"
            if refresh_token:
                cookie += f"; httpOnlyRefreshToken={refresh_token}"
            logger.info(f"Authenticated {email} via {url}")
            return cookie
        except Exception as e:
            logger.debug(f"Auth attempt at {url} failed: {e}")
            continue
    
    raise RuntimeError(f"Authentication failed for {email}")


def normalize_payment_method(method: str) -> str:
    """Normalize payment method to card type."""
    if not method:
        return "MC Credit"  # fallback
    normalized = method.lower().strip().replace(" ", "_")
    return PAYMENT_METHOD_MAPPING.get(normalized, "MC Credit")


def calculate_fee(amount: float, card_type: str) -> float:
    """Calculate transaction fee for given amount and card type."""
    pct, fixed = CARD_TYPE_FEES.get(card_type, (0.0088, 0.050))
    return amount * pct + fixed


class OMKPayKPIService:
    """Service to fetch settlements and calculate KPIs."""

    def __init__(self, results_file: Path = Path("omk_pay_kpi_results.json")):
        self.results_file = results_file

    def save_results(self, results: Dict[str, Any]) -> None:
        """Save KPI results to file."""
        try:
            with open(self.results_file, "w") as f:
                json.dump(results, f, indent=2, default=str)
            logger.info(f"OMK Pay KPI results saved to {self.results_file}")
        except Exception as e:
            logger.error(f"Failed to save KPI results: {e}")

    def load_results(self) -> Optional[Dict[str, Any]]:
        """Load cached KPI results."""
        if not self.results_file.exists():
            return None
        try:
            with open(self.results_file) as f:
                return json.load(f)
        except Exception as e:
            logger.error(f"Failed to load KPI results: {e}")
            return None

    def fetch_settlements(
        self,
        start_date: str,
        end_date: str,
        org_id: str,
        tenant_id: str,
        branch_ids: List[str],
        cookie: str,
    ) -> List[Dict[str, Any]]:
        """Fetch settlements from OMK API."""
        payload = {
            "StartDate": start_date,
            "EndDate": end_date,
            "FileName": "kpi_export.csv",
            "OrganizationId": org_id,
            "BranchIds": branch_ids or [],
            "TenantId": tenant_id,
        }

        headers = {
            "accept": "application/json, text/plain, */*",
            "content-type": "application/json",
            "user-agent": "OMK-KPI-Service/1.0",
            "origin": "https://cms.ordermonkey.com",
            "referer": "https://cms.ordermonkey.com/payment-report",
            "cookie": cookie,
        }

        url = "https://cms.ordermonkey.com/api/arc-etl/ArcEtlWebService/Kiosk/SettlementReportExport"

        logger.info(f"Fetching settlements: org={org_id}, range={start_date} to {end_date}, branches={len(branch_ids)}")

        try:
            with httpx.Client(timeout=60, verify=True) as client:
                resp = client.post(url, json=payload, headers=headers)
            
            logger.info(f"Settlement response: status={resp.status_code}, content_type={resp.headers.get('content-type')}, text_len={len(resp.text)}")
            
            resp.raise_for_status()

            # Try to parse response - may be JSON or CSV
            try:
                data = resp.json()
                logger.debug(f"Parsed as JSON: {str(data)[:200]}")
                
                # Handle various response formats
                if isinstance(data, dict):
                    # Could be {data: [...], success: ...} or just list
                    if "data" in data:
                        items = data["data"] if isinstance(data["data"], list) else []
                        logger.info(f"Found {len(items)} items in data.data")
                        return items
                    if "transactions" in data:
                        items = data["transactions"]
                        logger.info(f"Found {len(items)} items in data.transactions")
                        return items
                    if "settlements" in data:
                        items = data["settlements"]
                        logger.info(f"Found {len(items)} items in data.settlements")
                        return items
                    # Assume the dict itself is a single transaction
                    logger.info("Returning dict as single item")
                    return [data] if data else []
                if isinstance(data, list):
                    logger.info(f"Found {len(data)} items in root list")
                    return data
                logger.warning(f"Unexpected JSON type: {type(data)}")
                return []
            except Exception as json_err:
                # Response might be CSV - parse as line-based
                logger.warning(f"Failed to parse as JSON: {json_err}, attempting text parsing")
                logger.debug(f"Raw response text (first 500 chars): {resp.text[:500]}")
                
                lines = resp.text.strip().split("\n")
                if len(lines) > 1:
                    # Assume CSV with header
                    headers_row = lines[0].split(",")
                    transactions = []
                    for i, line in enumerate(lines[1:], 1):
                        values = line.split(",")
                        if len(values) == len(headers_row):
                            transactions.append(dict(zip(headers_row, values)))
                        else:
                            logger.debug(f"Line {i+1}: header_count={len(headers_row)} != value_count={len(values)}, skipping")
                    logger.info(f"Parsed {len(transactions)} transactions from CSV")
                    return transactions
                
                logger.warning(f"Response is text but not CSV (lines={len(lines)})")
                return []
        except Exception as e:
            logger.error(f"Failed to fetch settlements: {e}", exc_info=True)
            return []

    def calculate_kpis(
        self, transactions: List[Dict[str, Any]]
    ) -> Dict[str, Any]:
        """Calculate KPIs from transactions, grouped by organization."""
        org_kpis: Dict[str, Dict[str, Any]] = {}

        for txn in transactions:
            try:
                # Extract fields (adapt to API response format)
                org_id = txn.get("OrganizationId") or txn.get("organization_id") or "Unknown"
                amount = float(txn.get("Amount") or txn.get("amount") or 0)
                payment_method = txn.get("PaymentMethod") or txn.get("payment_method") or "MC Credit"
                card_type = normalize_payment_method(payment_method)

                fee = calculate_fee(amount, card_type)
                profit = amount - fee

                # Initialize org entry if needed
                if org_id not in org_kpis:
                    org_kpis[org_id] = {
                        "organization_id": org_id,
                        "total_revenue": 0.0,
                        "total_fees": 0.0,
                        "total_profit": 0.0,
                        "transaction_count": 0,
                        "card_type_breakdown": {},
                    }

                kpi = org_kpis[org_id]
                kpi["total_revenue"] += amount
                kpi["total_fees"] += fee
                kpi["total_profit"] += profit
                kpi["transaction_count"] += 1

                # Breakdown by card type
                if card_type not in kpi["card_type_breakdown"]:
                    kpi["card_type_breakdown"][card_type] = {
                        "count": 0,
                        "revenue": 0.0,
                        "fees": 0.0,
                    }
                kpi["card_type_breakdown"][card_type]["count"] += 1
                kpi["card_type_breakdown"][card_type]["revenue"] += amount
                kpi["card_type_breakdown"][card_type]["fees"] += fee

            except Exception as e:
                logger.warning(f"Failed to process transaction: {txn}, error: {e}")
                continue

        # Calculate margin for each org
        for org_id, kpi in org_kpis.items():
            if kpi["total_revenue"] > 0:
                kpi["profit_margin_pct"] = (kpi["total_profit"] / kpi["total_revenue"]) * 100
            else:
                kpi["profit_margin_pct"] = 0.0

        return org_kpis

    def run_kpi_calculation(
        self,
        start_date: str,
        end_date: str,
        orgs: List[Dict[str, Any]],  # list of {org_id, tenant_id, branch_ids, cookie}
    ) -> Dict[str, Any]:
        """Run full KPI calculation for all organizations."""
        logger.info(f"Starting OMK Pay KPI calculation for {len(orgs)} organization(s)")

        all_transactions = []
        errors = []

        for org_config in orgs:
            try:
                org_id = org_config.get("org_id")
                tenant_id = org_config.get("tenant_id")
                branch_ids = org_config.get("branch_ids", [])
                cookie = org_config.get("cookie", "")

                logger.info(f"Fetching settlements for org: {org_id}")
                transactions = self.fetch_settlements(
                    start_date, end_date, org_id, tenant_id, branch_ids, cookie
                )
                all_transactions.extend(transactions)
                logger.info(f"Fetched {len(transactions)} transactions for org: {org_id}")
            except Exception as e:
                msg = f"Error fetching org {org_config.get('org_id')}: {e}"
                logger.error(msg)
                errors.append(msg)

        # Calculate KPIs
        org_kpis = self.calculate_kpis(all_transactions)

        results = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "start_date": start_date,
            "end_date": end_date,
            "total_transactions": len(all_transactions),
            "total_organizations": len(org_kpis),
            "organizations": org_kpis,
            "errors": errors,
        }

        self.save_results(results)
        return results

    def run_auto_kpi(self, days_back: int = 7) -> Dict[str, Any]:
        """Automatically run KPI calculation for all orgs from orgs.json.
        
        Authenticates using email/password from orgs.json and fetches settlements
        for the last N days for each organization.
        """
        orgs = load_orgs()
        if not orgs:
            return {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "total_organizations": 0,
                "organizations": {},
                "errors": ["No organizations found in orgs.json"],
            }
        
        now = datetime.now(timezone.utc)
        start = now - timedelta(days=days_back)
        start_date = start.strftime("%Y-%m-%d")
        end_date = now.strftime("%Y-%m-%d")
        
        logger.info(f"Running auto KPI calculation for {len(orgs)} orgs from {start_date} to {end_date}")
        
        all_transactions = []
        errors = []
        
        for org in orgs:
            try:
                logger.info(f"[{org.name}] Authenticating...")
                cookie = authenticate(org.email, org.password)
                logger.info(f"[{org.name}] Auth OK, fetching settlements...")
                
                transactions = self.fetch_settlements(
                    start_date=start_date,
                    end_date=end_date,
                    org_id=org.orgId,
                    tenant_id="default",
                    branch_ids=[],
                    cookie=cookie,
                )
                all_transactions.extend(transactions)
                logger.info(f"[{org.name}] Fetched {len(transactions)} transactions")
            except Exception as e:
                msg = f"[{org.name}] Error: {e}"
                logger.error(msg)
                errors.append(msg)
        
        org_kpis = self.calculate_kpis(all_transactions)
        
        results = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "start_date": start_date,
            "end_date": end_date,
            "total_transactions": len(all_transactions),
            "total_organizations": len(org_kpis),
            "organizations": org_kpis,
            "errors": errors,
        }
        
        self.save_results(results)
        return results
