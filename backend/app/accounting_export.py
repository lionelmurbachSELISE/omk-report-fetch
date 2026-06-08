from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from io import BytesIO
from typing import Any, DefaultDict, Dict, Iterable, List, Tuple

import httpx
from openpyxl import Workbook
from openpyxl.utils import get_column_letter
from openpyxl.styles import Alignment, Font, PatternFill

from .models import ProgressEvent, RunRequest
from .service import _build_headers, _handle_response, _refresh_access_token, _resolve_backoffice


KITCHEN_REUNION_BRANCHES = {
    "7302bb40a44f4efa816524e20a8f186a": "Kitchen Reunion - Welle 7",
    "eab690581d2a4ca0a793c212ff3ab58f": "Shoppyland, Schoenbuehl",
    "796a0ca675b44eafa46649a40c59bfd5": "Shoppy Tivoli, Thai Wok",
    "a3b12f0836f14011a28c81a7057cf4f9": "Shoppy Tivoli, Guapo Mexicano",
    "ae14f5980672453192b492ea7ed42092": "Mall Of Switzerland",
    "a863fcd8c4034bcdb843d9354ac2f0b4": "Stueckipark",
}

ACCOUNTING_QUERY_TEMPLATE = """query findData {
  PlOrders(Model: {PageNumber: {{PAGE_NUMBER}}, Filter: "{ 'OrganizationId': '{{ORG_ID}}', 'BranchUUID': '{{BRANCH_UUID}}' ,'CreateDate': {'$lte': ISODate('{{END_DATE}}'), '$gte': ISODate('{{START_DATE}}') }, }", Sort: "{CreateDate: -1}", PageSize: {{PAGE_SIZE}}}) {
    Data {
      ItemId
      CreateDate
      OrderNumber
      BranchUUID
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
}"""

MONEY_QUANT = Decimal("0.01")


@dataclass
class SummaryBucket:
    gross_total: Decimal = Decimal("0")
    net_total: Decimal = Decimal("0")
    discounts_total: Decimal = Decimal("0")
    tips_total: Decimal = Decimal("0")
    tax_due_81: Decimal = Decimal("0")
    tax_due_26: Decimal = Decimal("0")
    revenue_81: Decimal = Decimal("0")
    revenue_26: Decimal = Decimal("0")
    payment_methods: DefaultDict[str, Decimal] | None = None

    def __post_init__(self) -> None:
        if self.payment_methods is None:
            self.payment_methods = defaultdict(lambda: Decimal("0"))


def _normalize_branch_id(value: str) -> str:
    return value.strip().lower().replace("-", "")


def _branch_label(branch_id: str) -> str:
    return KITCHEN_REUNION_BRANCHES.get(_normalize_branch_id(branch_id), branch_id)


def _decimal(value: Any) -> Decimal:
    if value in (None, ""):
        return Decimal("0")
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return Decimal("0")


def _money(value: Decimal) -> float:
    return float(value.quantize(MONEY_QUANT, rounding=ROUND_HALF_UP))


def _bucket_for_rate(rate: Decimal) -> str | None:
    rounded = rate.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
    if rounded == Decimal("8.1"):
        return "81"
    if rounded == Decimal("2.6"):
        return "26"
    return None


def _modifier_total(product: Dict[str, Any]) -> Decimal:
    modifiers = product.get("OrderProductModifiers") or []
    if not isinstance(modifiers, list):
        return Decimal("0")

    total = Decimal("0")
    for modifier in modifiers:
        if not isinstance(modifier, dict):
            continue
        total += _decimal(modifier.get("Price")) * _decimal(modifier.get("Quantity"))
    return total


def _line_amounts(product: Dict[str, Any]) -> Tuple[Decimal, Decimal, Decimal, Decimal]:
    unit_price = _decimal(product.get("UnitPrice"))
    quantity = _decimal(product.get("Quantity"))
    discount = _decimal(product.get("DiscountAmount"))
    rate = _decimal(product.get("TaxRate"))
    modifiers_total = _modifier_total(product)

    gross = (unit_price * quantity) + modifiers_total - discount
    if gross < 0:
        gross = Decimal("0")

    if rate <= 0:
        net = gross
        tax = Decimal("0")
    else:
        divisor = Decimal("1") + (rate / Decimal("100"))
        net = gross / divisor
        tax = gross - net

    return gross, net, tax, rate


def _build_payload(req: RunRequest, branch_uuid: str, page_number: int) -> Dict[str, Any]:
    replacements = {
        "{{ORG_ID}}": req.orgId or "",
        "{{BRANCH_UUID}}": branch_uuid,
        "{{PAGE_NUMBER}}": str(page_number),
        "{{PAGE_SIZE}}": str(req.pageSize),
        "{{START_DATE}}": req.startDate or "",
        "{{END_DATE}}": req.endDate or "",
    }
    query = ACCOUNTING_QUERY_TEMPLATE
    for key, value in replacements.items():
        query = query.replace(key, value)
    return {"operationName": "", "variables": {}, "query": query}


def _parse_orders(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    payload = data.get("data") or {}
    pl_orders = payload.get("PlOrders")
    if not isinstance(pl_orders, dict):
        raise RuntimeError("Could not find PlOrders in response")
    if pl_orders.get("Success") is False:
        raise RuntimeError(str(pl_orders.get("ErrorMessage") or "Backend returned Success=false"))
    items = pl_orders.get("Data") or []
    if not isinstance(items, list):
        raise RuntimeError("PlOrders.Data is not a list")
    return items


def fetch_accounting_orders(req: RunRequest) -> Tuple[List[Dict[str, Any]], List[ProgressEvent], List[str]]:
    timeout = httpx.Timeout(req.timeoutSeconds)
    backoffice = _resolve_backoffice(req.backofficeId)
    headers = _build_headers(req.cookie, req.origin, req.referer, backoffice)
    events: List[ProgressEvent] = []
    errors: List[str] = []
    all_orders: List[Dict[str, Any]] = []

    if not req.branchUuids:
        return all_orders, events, errors

    with httpx.Client(timeout=timeout, trust_env=False) as client:
        for branch in req.branchUuids:
            for page in range(1, req.maxPages + 1):
                try:
                    if req.cookie:
                        refreshed_cookie = _refresh_access_token(req.cookie, client)
                        if refreshed_cookie != req.cookie:
                            req.cookie = refreshed_cookie
                            headers["cookie"] = refreshed_cookie

                    payload = _build_payload(req, branch, page)
                    resp = client.post(backoffice["graphql_url"], headers=headers, json=payload)
                    data = _handle_response(resp)
                    orders = _parse_orders(data)
                    all_orders.extend(orders)
                    events.append(ProgressEvent(branch=branch, page=page, status="ok"))

                    if len(orders) < req.pageSize:
                        break
                except Exception as exc:
                    errors.append(f"branch={branch}, page={page}, error={exc}")
                    events.append(ProgressEvent(branch=branch, page=page, status="error", message=str(exc)))
                    break

    return all_orders, events, errors


def _summarize_orders(
    orders: Iterable[Dict[str, Any]]
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    buckets: Dict[str, SummaryBucket] = {"All Branches": SummaryBucket()}
    detail_rows: List[Dict[str, Any]] = []
    seen_orders: set[str] = set()

    for order in orders:
        item_id = str(order.get("ItemId") or "")
        branch_id = str(order.get("BranchUUID") or "")
        branch_name = _branch_label(branch_id)
        bucket = buckets.setdefault(branch_name, SummaryBucket())

        if item_id and item_id not in seen_orders:
            seen_orders.add(item_id)
            discounts_total = _decimal(order.get("DiscountAmount"))
            tips_total = _decimal(order.get("TipAmount"))
            kiosk_sales = _decimal(order.get("SubTotal"))
            gross_total = _decimal(order.get("TotalAmount")) + discounts_total + tips_total
            net_total = kiosk_sales + discounts_total + tips_total
            payment_method = str(order.get("PaymentMethod") or "Unknown")

            for target in (buckets["All Branches"], bucket):
                target.gross_total += gross_total
                target.net_total += net_total
                target.discounts_total += discounts_total
                target.tips_total += tips_total
                target.payment_methods[payment_method] += gross_total

        order_products = order.get("OrderProducts") or []
        if not isinstance(order_products, list):
            order_products = []

        rate_gross_map: Dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
        for product in order_products:
            if not isinstance(product, dict):
                continue

            gross_line, net_line, tax_line, rate = _line_amounts(product)
            rate_bucket = _bucket_for_rate(rate)

            if rate_bucket is not None:
                rate_gross_map[rate_bucket] += gross_line

            detail_rows.append(
                {
                    "BranchName": branch_name,
                    "BranchUUID": branch_id,
                    "ItemId": order.get("ItemId"),
                    "CreateDate": order.get("CreateDate"),
                    "OrderNumber": order.get("OrderNumber"),
                    "OrderType": order.get("OrderType"),
                    "OrderStatus": order.get("OrderStatus"),
                    "PaymentMethod": order.get("PaymentMethod"),
                    "PaymentReferenceId": order.get("PaymentReferenceId"),
                    "TotalAmount": _money(_decimal(order.get("TotalAmount"))),
                    "SubTotal": _money(_decimal(order.get("SubTotal"))),
                    "DiscountAmount": _money(_decimal(order.get("DiscountAmount"))),
                    "TaxAmount": _money(_decimal(order.get("TaxAmount"))),
                    "TipAmount": _money(_decimal(order.get("TipAmount"))),
                    "DeliveryCost": _money(_decimal(order.get("DeliveryCost"))),
                    "ProductName": product.get("Name"),
                    "ProductId": product.get("ProductId"),
                    "ProductVariationName": product.get("ProductVariationName"),
                    "CategoryName": product.get("CategoryName"),
                    "Quantity": float(_decimal(product.get("Quantity"))),
                    "UnitPrice": _money(_decimal(product.get("UnitPrice"))),
                    "LineDiscountAmount": _money(_decimal(product.get("DiscountAmount"))),
                    "TaxRate": float(rate),
                    "LineGrossRevenue": _money(gross_line),
                    "LineNetRevenue": _money(net_line),
                    "LineTaxAmount": _money(tax_line),
                    "ModifierTotal": _money(_modifier_total(product)),
                }
            )

        order_total_amount = _decimal(order.get("TotalAmount"))
        line_total_amount = sum(rate_gross_map.values(), Decimal("0"))
        if line_total_amount > 0 and order_total_amount >= 0:
            scaling_factor = order_total_amount / line_total_amount
            for rate_bucket, gross_amount in list(rate_gross_map.items()):
                rate_gross_map[rate_bucket] = gross_amount * scaling_factor

        for target in (buckets["All Branches"], bucket):
            gross_81 = rate_gross_map.get("81", Decimal("0"))
            gross_26 = rate_gross_map.get("26", Decimal("0"))

            target.revenue_81 += gross_81
            target.revenue_26 += gross_26

            if gross_81 > 0:
                net_81 = gross_81 / (Decimal("1") + (Decimal("8.1") / Decimal("100")))
                target.tax_due_81 += gross_81 - net_81
            if gross_26 > 0:
                net_26 = gross_26 / (Decimal("1") + (Decimal("2.6") / Decimal("100")))
                target.tax_due_26 += gross_26 - net_26

    summary_rows: List[Dict[str, Any]] = []
    for scope, bucket in buckets.items():
        summary_rows.append(
            {
                "Scope": scope,
                "Brutto Total": _money(bucket.gross_total),
                "Netto Total": _money(bucket.net_total),
                "Total zu zahlende Mehrwertsteuer 8.1%": _money(bucket.tax_due_81),
                "Total zu zahlende Mehrwertsteuer 2.6%": _money(bucket.tax_due_26),
                "Total Umsatz mit 8.1 % Mehrwertsteuer": _money(bucket.revenue_81),
                "Total Umsatz mit 2.6 % Mehrwertsteuer": _money(bucket.revenue_26),
                "Total Rabatte": _money(bucket.discounts_total),
                "Total Trinkgelder": _money(bucket.tips_total),
            }
        )

    payment_rows: List[Dict[str, Any]] = []
    for scope, bucket in buckets.items():
        for payment_method, total in sorted(bucket.payment_methods.items()):
            payment_rows.append(
                {
                    "Scope": scope,
                    "PaymentMethod": payment_method,
                    "Total Zahlungsmethode": _money(total),
                }
            )

    return summary_rows, payment_rows, detail_rows


def _apply_currency_format(sheet, start_row: int, end_row: int, columns: Iterable[int]) -> None:
    for row in range(start_row, end_row + 1):
        for column in columns:
            sheet.cell(row=row, column=column).number_format = '#,##0.00'


def _style_table_header(sheet, row: int, fill_color: str = "D26A1D") -> None:
    fill = PatternFill(fill_type="solid", fgColor=fill_color)
    for cell in sheet[row]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = fill
        cell.alignment = Alignment(horizontal="center", vertical="center")


def build_accounting_workbook(req: RunRequest) -> Tuple[bytes, List[str], List[ProgressEvent]]:
    orders, events, errors = fetch_accounting_orders(req)
    any_ok = any(event.status == "ok" for event in events)
    if not orders and errors and not any_ok:
        raise RuntimeError("Export failed - no rows collected. Errors: " + "; ".join(errors[:5]))

    summary_rows, payment_rows, detail_rows = _summarize_orders(orders)

    workbook = Workbook()
    summary_sheet = workbook.active
    summary_sheet.title = "Summary"
    summary_sheet.merge_cells("A1:I1")
    summary_sheet["A1"] = "Kitchen Reunion Accounting Summary"
    summary_sheet["A1"].font = Font(bold=True, size=16)
    summary_sheet["A1"].alignment = Alignment(horizontal="center")
    summary_sheet["A2"] = "Zeitraum"
    summary_sheet["B2"] = f"{req.startDate or '-'} bis {req.endDate or '-'}"
    summary_sheet["A3"] = "Erstellt am"
    summary_sheet["B3"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    summary_sheet["A5"] = "Gesamt und pro Betrieb"
    summary_sheet["A5"].font = Font(bold=True, size=12)
    summary_sheet.freeze_panes = "A6"

    summary_table_header_row = 6
    summary_sheet.append(
        [
            "Scope",
            "Brutto Total",
            "Netto Total",
            "Total zu zahlende Mehrwertsteuer 8.1%",
            "Total zu zahlende Mehrwertsteuer 2.6%",
            "Total Umsatz mit 8.1 % Mehrwertsteuer",
            "Total Umsatz mit 2.6 % Mehrwertsteuer",
            "Total Rabatte",
            "Total Trinkgelder",
        ]
    )
    _style_table_header(summary_sheet, summary_table_header_row)

    summary_data_start = summary_sheet.max_row + 1
    for row in summary_rows:
        summary_sheet.append(
            [
                row["Scope"],
                row["Brutto Total"],
                row["Netto Total"],
                row["Total zu zahlende Mehrwertsteuer 8.1%"],
                row["Total zu zahlende Mehrwertsteuer 2.6%"],
                row["Total Umsatz mit 8.1 % Mehrwertsteuer"],
                row["Total Umsatz mit 2.6 % Mehrwertsteuer"],
                row["Total Rabatte"],
                row["Total Trinkgelder"],
            ]
        )
    summary_data_end = summary_sheet.max_row
    _apply_currency_format(summary_sheet, summary_data_start, summary_data_end, range(2, 10))
    if summary_data_start <= summary_data_end:
        for cell in summary_sheet[summary_data_start]:
            cell.font = Font(bold=True)
            cell.fill = PatternFill(fill_type="solid", fgColor="F7E4D5")

    payment_title_row = summary_sheet.max_row + 2
    summary_sheet.cell(row=payment_title_row, column=1, value="Zahlungsmethoden nach Betrieb")
    summary_sheet.cell(row=payment_title_row, column=1).font = Font(bold=True, size=12)
    payment_header_row = payment_title_row + 1
    summary_sheet.append(["Scope", "PaymentMethod", "Total"])
    _style_table_header(summary_sheet, payment_header_row, fill_color="6B6152")
    payment_data_start = summary_sheet.max_row + 1
    for row in payment_rows:
        summary_sheet.append([row["Scope"], row["PaymentMethod"], row["Total Zahlungsmethode"]])
    payment_data_end = summary_sheet.max_row
    _apply_currency_format(summary_sheet, payment_data_start, payment_data_end, [3])

    details_sheet = workbook.create_sheet("Details")
    detail_columns = [
        "BranchName",
        "BranchUUID",
        "ItemId",
        "CreateDate",
        "OrderNumber",
        "OrderType",
        "OrderStatus",
        "PaymentMethod",
        "PaymentReferenceId",
        "TotalAmount",
        "SubTotal",
        "DiscountAmount",
        "TaxAmount",
        "TipAmount",
        "DeliveryCost",
        "ProductName",
        "ProductId",
        "ProductVariationName",
        "CategoryName",
        "Quantity",
        "UnitPrice",
        "LineDiscountAmount",
        "ModifierTotal",
        "TaxRate",
        "LineGrossRevenue",
        "LineNetRevenue",
        "LineTaxAmount",
    ]
    details_sheet.append(detail_columns)
    _style_table_header(details_sheet, 1, fill_color="1E1B16")
    for row in detail_rows:
        details_sheet.append([row.get(column) for column in detail_columns])
    details_sheet.freeze_panes = "A2"
    details_sheet.auto_filter.ref = details_sheet.dimensions
    if detail_rows:
        _apply_currency_format(details_sheet, 2, details_sheet.max_row, [10, 11, 12, 13, 14, 20, 21, 23, 24, 25])

    for sheet in (summary_sheet, details_sheet):
        for index, column_cells in enumerate(sheet.columns, start=1):
            max_length = max(len(str(cell.value or "")) for cell in column_cells)
            sheet.column_dimensions[get_column_letter(index)].width = min(max_length + 2, 40)

    output = BytesIO()
    workbook.save(output)
    return output.getvalue(), errors, events
