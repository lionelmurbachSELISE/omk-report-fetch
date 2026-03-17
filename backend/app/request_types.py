from __future__ import annotations

from typing import Any, Dict, List, Optional

from .utils import get_path


BACKOFFICES = {
    "subway": {
        "name": "Subway",
        "graphql_url": "https://backoffice.subway.ch/api/gqlquery/v100/graphql",
        "origin": "https://backoffice.subway.ch",
        "referer": "https://backoffice.subway.ch/orders/returned-orders",
    },
    "ordermonkey": {
        "name": "Ordermonkey",
        "graphql_url": "https://cms.ordermonkey.com/api/gqlquery/v100/graphql",
        "origin": "https://cms.ordermonkey.com",
        "referer": "https://cms.ordermonkey.com",
    },
}


def _failure_message(node: Dict[str, Any]) -> str:
    message = node.get("ErrorMessage")
    validation = node.get("ValidationResult")
    details = {
        "ErrorMessage": message,
        "ValidationResult": validation,
        "keys": list(node.keys()),
    }
    return "Backend returned Success=false. " + str(details)


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
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        request_config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        raise NotImplementedError

    def parse_items(self, data: Dict[str, Any]) -> List[Dict[str, Any]]:
        raise NotImplementedError

    def transform_rows(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return items

    def csv_schema(self) -> List[str]:
        return []

    def supports_pagination(self) -> bool:
        return True


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
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        request_config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        date_filter = ""
        if start_date and end_date:
            date_filter = f", 'CreateDate': {{ $gte: '{start_date}', $lte: '{end_date}' }}"

        query = (
            "query findData {\n"
            "  PlOrders(Model: {PageNumber: %d, Filter: \"{ 'OrganizationId': '%s','BranchUUID': '%s', 'ReturnType': { $ne: null }%s }\", Sort: \"{CreateDate: -1}\", PageSize: %d}) {\n"
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
            % (page_number, org_id, branch_uuid, date_filter, page_size)
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
            raise RuntimeError(_failure_message(pl))

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
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
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
            "{{START_DATE}}": start_date or "",
            "{{END_DATE}}": end_date or "",
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

        def find_items(node: Any) -> Optional[List[Dict[str, Any]]]:
            if isinstance(node, dict):
                if node.get("Success") is False:
                    raise RuntimeError(_failure_message(node))

                items = node.get("Data")
                if isinstance(items, list):
                    return items

                for value in node.values():
                    found = find_items(value)
                    if found is not None:
                        return found

            if isinstance(node, list):
                if node and all(isinstance(item, dict) for item in node):
                    return node

                for value in node:
                    found = find_items(value)
                    if found is not None:
                        return found

            return None

        items = find_items(payload)
        if items is not None:
            return items

        raise RuntimeError("Could not locate list results in response")

    def transform_rows(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return items

    def csv_schema(self) -> List[str]:
        return []


class CustomHttpRequest(RequestType):
    def __init__(self) -> None:
        super().__init__(
            type_id="custom_http",
            name="Custom HTTP / cURL",
            description="Run an arbitrary JSON HTTP request and export the result to CSV.",
        )

    def build_payload(
        self,
        *,
        org_id: str,
        branch_uuid: str,
        page_number: int,
        page_size: int,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        request_config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        if not request_config:
            raise RuntimeError("Missing request config for custom request")

        custom_url = request_config.get("customUrl")
        if not custom_url:
            raise RuntimeError("Custom URL is required")

        raw_json_body = request_config.get("rawJsonBody")
        headers = request_config.get("headers") or {}
        if headers and not isinstance(headers, dict):
            raise RuntimeError("Headers must be a JSON object")

        replacements = {
            "{{ORG_ID}}": org_id,
            "{{BRANCH_UUID}}": branch_uuid,
            "{{PAGE_NUMBER}}": str(page_number),
            "{{PAGE_SIZE}}": str(page_size),
            "{{START_DATE}}": start_date or "",
            "{{END_DATE}}": end_date or "",
        }

        def replace_all(value: str) -> str:
            out = value
            for k, v in replacements.items():
                out = out.replace(k, v)
            return out

        parsed_headers = {str(k): replace_all(str(v)) for k, v in headers.items()}
        payload: Dict[str, Any] = {
            "url": replace_all(str(custom_url)),
            "method": str(request_config.get("httpMethod") or "GET").upper(),
            "headers": parsed_headers,
        }
        if raw_json_body:
            payload["json"] = _safe_json_value_load(replace_all(raw_json_body))
        return payload

    def parse_items(self, data: Any, response_path: Optional[str] = None) -> List[Dict[str, Any]]:
        target = get_path(data, response_path) if response_path else data

        if isinstance(target, list):
            return [item if isinstance(item, dict) else {"value": item} for item in target]

        if isinstance(target, dict):
            first_list = _find_first_list(target)
            if first_list is not None:
                return [item if isinstance(item, dict) else {"value": item} for item in first_list]
            return [_flatten_value(target)]

        return [{"value": target}]

    def transform_rows(self, items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [_flatten_value(item) for item in items]

    def csv_schema(self) -> List[str]:
        return []

    def supports_pagination(self) -> bool:
        return False


REQUEST_TYPES: Dict[str, RequestType] = {
    "refunded_products": RefundedProductsRequest(),
    "all_orders": AllOrdersRequest(),
    "custom_http": CustomHttpRequest(),
}


def _safe_json_value_load(body: str) -> Any:
    import json

    try:
        data = json.loads(body)
    except Exception as e:
        raise RuntimeError("Invalid JSON body in curl template") from e

    return data


def _safe_json_load(body: str) -> Dict[str, Any]:
    data = _safe_json_value_load(body)

    if not isinstance(data, dict):
        raise RuntimeError("Curl JSON body must be an object")

    return data


def _find_first_list(data: Any) -> Optional[List[Any]]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for value in data.values():
            found = _find_first_list(value)
            if found is not None:
                return found
    return None


def _flatten_value(value: Any, prefix: str = "") -> Dict[str, Any]:
    if isinstance(value, dict):
        row: Dict[str, Any] = {}
        for key, item in value.items():
            child_prefix = f"{prefix}.{key}" if prefix else str(key)
            row.update(_flatten_value(item, child_prefix))
        return row

    if isinstance(value, list):
        row: Dict[str, Any] = {}
        for idx, item in enumerate(value):
            child_prefix = f"{prefix}[{idx}]" if prefix else f"[{idx}]"
            row.update(_flatten_value(item, child_prefix))
        if row:
            return row

    column = prefix or "value"
    return {column: value}


def apply_mapping(items: List[Dict[str, Any]], mapping: Dict[str, str]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for item in items:
        row: Dict[str, Any] = {}
        for col, path in mapping.items():
            row[col] = get_path(item, path)
        rows.append(row)
    return rows
