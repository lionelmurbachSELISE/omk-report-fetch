from __future__ import annotations

import csv
import io
from typing import Any, Dict, List


def to_csv_bytes(columns: List[str], rows: List[Dict[str, Any]]) -> bytes:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(columns)
    for row in rows:
        writer.writerow([row.get(col) for col in columns])
    return buffer.getvalue().encode("utf-8")
