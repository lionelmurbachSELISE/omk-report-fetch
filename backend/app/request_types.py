from __future__ import annotations

from typing import Any, Dict, List, Optional

from .utils import get_path


SUBWAY_URL = "https://backoffice.subway.ch//api/gqlquery/v100/graphql"


class RequestType:
    def __init__(self, type_id: str, name: str, description: str):
        self.type_id = type_id
        self.name = name
        self.description = description

    def build_payload(
        self,
        *,
        org_id: str,
        branch_uuid: str,
        page_number: int,
        page_size: int,
        request_config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        raise NotImplementedError

    def parse_items(self, data: Dict[str, Any]) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def transform_rows(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return items

    def csv_schema(self) -> List[str]:
        return []


class RefundedProductsRequest(RequestType):
    def __init__(self) -> None:
        super().__init__(
            type_id="refunded_products",
            name="Refunded Products",
            description="Returned orders with refunded product rows.",
        )

    def build_payload(
        self,
        *,
        org_id: str,
        branch_uuid: str,
        page_number: int,
        page_size: int,
        request_config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        query = (
            "query findData {\n"
            "  PlOrders(Model: {PageNumber: %d, Filter: \"{ 'OrganizationId': '%s','BranchUUID': '%s', 'ReturnType': { $ne: null } }\", Sort: \"{CreateDate: -1}\", PageSize: %d}) {\n"
            "    Data {\n"
            "      CreateDate\n"
            "      BranchUUID\n"
            "      OrderNumber\n"
            "      ChannelOrderDisplayId\n"
            "      PaymentMethod\n"
            "      PaymentReferenceId\n"
            "      OrderStatus\n"
            "      OrderType\n"
            "      OrderProducts {\n"
            "        Name\n"
            "        ProductId\n"
            "        ProductVariationName\n"
            "        ProductVariationPrice\n"
            "        Quantity\n"
            "        RefundedInfo {\n"
            "          RefundedReason\n"
            "          RefundedQuantity\n"
            "          RefundedTime\n"
            "          EmployeeId\n"
            "          ManagerId\n"
            "        }\n"
            "      }\n"
            "    }\n"
            "    Success\n"
            "    ErrorMessage\n"
            "    TotalCount\n"
            "  }\n"
            "}\n"
            % (page_number, org_id, branch_uuid, page_size)
        )

        return {"operationName": "findData", "variables": {}, "query": query}

    def parse_items(self, data: Dict[str, Any]) -> List[Dict[str, Any]]:
        d = data.get("data") or {}
        if isinstance(d, dict) and isinstance(d.get("PlOrders"), dict):
            pl = d["PlOrders"]
        else:
            find_data = d.get("findData")
            if isinstance(find_data, dict) and isinstance(find_data.get("PlOrders"), dict):
                pl = find_data["PlOrders"]
            else:
                raise RuntimeError("Could not find PlOrders in response")

        if pl.get("Success") is False:
            raise RuntimeError("Backend returned Success=false. " + str(pl.get("ErrorMessage")))

        items = pl.get("Data") or []
        if not isinstance(items, list):
            raise RuntimeError("PlOrders.Data is not a list")
        return items

    def transform_rows(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []
        for o in items:
            order_products = o.get("OrderProducts") or []
            if not isinstance(order_products, list):
                order_products = []

            for op in order_products:
                refunded_info = op.get("RefundedInfo")
                if not refunded_info:
                    continue

                price = op.get("ProductVariationPrice")
                qty = op.get("Quantity")

                try:
                    price_f = float(price) if price is not None and price != "" else 0.0
                except Exception:
                    price_f = 0.0

                try:
                    qty_f = float(qty) if qty is not None and qty != "" else 0.0
                except Exception:
                    qty_f = 0.0

                refunded_amount = price_f * qty_f

                rows.append(
                    {
                        "BranchUUID": o.get("BranchUUID"),
                        "CreateDate": o.get("CreateDate"),
                        "OrderNumber": o.get("OrderNumber"),
                        "ChannelOrderDisplayId": o.get("ChannelOrderDisplayId"),
                        "PaymentMethod": o.get("PaymentMethod"),
                        "PaymentReferenceId": o.get("PaymentReferenceId"),
                        "OrderStatus": o.get("OrderStatus"),
                        "OrderType": o.get("OrderType"),
                        "ProductName": op.get("Name"),
                        "ProductId": op.get("ProductId"),
                        "ProductVariationName": op.get("ProductVariationName"),
                        "ProductVariationPrice": op.get("ProductVariationPrice"),
                        "Quantity": op.get("Quantity"),
                        "RefundedAmount": refunded_amount,
                        "RefundedReason": refunded_info.get("RefundedReason") if isinstance(refunded_info, dict) else None,
                        "RefundedQuantity": refunded_info.get("RefundedQuantity") if isinstance(refunded_info, dict) else None,
                        "RefundedTime": refunded_info.get("RefundedTime") if isinstance(refunded_info, dict) else None,
                        "RefundedEmployeeId": refunded_info.get("EmployeeId") if isinstance(refunded_info, dict) else None,
                        "RefundedManagerId": refunded_info.get("ManagerId") if isinstance(refunded_info, dict) else None,
                    }
                )
        return rows

    def csv_schema(self) -> List[str]:
        return [
            "BranchUUID",
            "CreateDate",
            "OrderNumber",
            "ChannelOrderDisplayId",
            "PaymentMethod",
            "PaymentReferenceId",
            "OrderStatus",
            "OrderType",
            "ProductName",
            "ProductId",
            "ProductVariationName",
            "ProductVariationPrice",
            "Quantity",
            "RefundedAmount",
            "RefundedReason",
            "RefundedQuantity",
            "RefundedTime",
            "RefundedEmployeeId",
            "RefundedManagerId",
        ]


class AllOrdersRequest(RequestType):
    def __init__(self) -> None:
        super().__init__(
            type_id="all_orders",
            name="All Orders",
            description="User-supplied GraphQL or curl for all orders.",
        )

    def build_payload(
        self,
        *,
        org_id: str,
        branch_uuid: str,
        page_number: int,
        page_size: int,
        request_config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if not request_config:
            raise RuntimeError("Missing request config for all orders")

        query_template = request_config.get("queryTemplate")
        raw_json_body = request_config.get("rawJsonBody")
        operation_name = request_config.get("operationName")
        variables = request_config.get("variables") or {}

        replacements = {
            "{{ORG_ID}}": org_id,
            "{{BRANCH_UUID}}": branch_uuid,
            "{{PAGE_NUMBER}}": str(page_number),
            "{{PAGE_SIZE}}": str(page_size),
        }

        def replace_all(value: str) -> str:
            out = value
            for k, v in replacements.items():
                out = out.replace(k, v)
            return out

        if raw_json_body:
            body = replace_all(raw_json_body)
            return _safe_json_load(body)

        if not query_template:
            raise RuntimeError("Missing query template for all orders")

        query = replace_all(query_template)

        return {
            "operationName": operation_name or "",
            "variables": variables,
            "query": query,
        }

    def parse_items(self, data: Dict[str, Any]) -> List[Dict[str, Any]]:
        if not isinstance(data, dict):
            raise RuntimeError("Response JSON is not an object")

        payload = data.get("data")
        if not isinstance(payload, dict):
            raise RuntimeError("Response missing data object")

        # Heuristic: pick the first list found under data
        for value in payload.values():
            if isinstance(value, dict) and isinstance(value.get("Data"), list):
                return value.get("Data")
            if isinstance(value, list):
                return value

        raise RuntimeError("Could not locate list results in response")

    def transform_rows(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return items

    def csv_schema(self) -> List[str]:
        return []


REQUEST_TYPES: Dict[str, RequestType] = {
    "refunded_products": RefundedProductsRequest(),
    "all_orders": AllOrdersRequest(),
}


def _safe_json_load(body: str) -> Dict[str, Any]:
    import json

    try:
        data = json.loads(body)
    except Exception as e:
        raise RuntimeError("Invalid JSON body in curl template") from e

    if not isinstance(data, dict):
        raise RuntimeError("Curl JSON body must be an object")

    return data


def apply_mapping(items: List[Dict[str, Any]], mapping: Dict[str, str]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for item in items:
        row: Dict[str, Any] = {}
        for col, path in mapping.items():
            row[col] = get_path(item, path)
        rows.append(row)
    return rows
