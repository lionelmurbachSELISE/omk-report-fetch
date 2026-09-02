from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

_ASSETS = Path(__file__).parent / "assets"
_OMK_LOGO = str(_ASSETS / "omk_logo.png")

import httpx
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from fpdf import FPDF

from .service import _build_headers, _refresh_access_token, _resolve_backoffice

# SubTotal = gross basket before discount; DiscountAmount to count discounted orders.
_QUERY = (
    "query findData {{"
    "  PlOrders(Model: {{PageNumber: {page}, "
    "Filter: \"{{ 'OrganizationId': '{org}', 'BranchUUID': '{branch}'"
    " ,'CreateDate': {{'$lte': ISODate('{end}'), '$gte': ISODate('{start}') }} }}\","
    " Sort: \"{{CreateDate: -1}}\", PageSize: 100}}) {{"
    "    Data {{ ItemId SubTotal DiscountAmount CustomerEmail OrderStatus }}"
    "    Success ErrorMessage"
    "  }}"
    "}}"
)

_RED = "#CC1212"

plt.rcParams.update({
    "font.size": 8,
    "axes.spines.top": False,
    "axes.spines.right": False,
})


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class WeekData:
    label: str
    total: int = 0
    leat: int = 0
    guest: int = 0
    discounted: int = 0
    avg_basket: float = 0.0  # based on SubTotal (before discount)


@dataclass
class InfluencerData:
    name: str
    signups: int
    orders: int = 0
    discounted_orders: int = 0
    subtotal: float = 0.0  # sum of SubTotal (before discount)

    @property
    def avg_basket(self) -> float:
        return self.subtotal / self.orders if self.orders > 0 else 0.0


# ── LEAT CSV parsing ──────────────────────────────────────────────────────────

def _parse_leat(csv_text: str) -> Dict[str, str]:
    """Returns {lowercase_email: creator_name} (first creator wins per email)."""
    email_to_creator: Dict[str, str] = {}
    reader = csv.DictReader(io.StringIO(csv_text.strip()), delimiter=";")
    for row in reader:
        email = (row.get("Email") or "").strip().lower()
        creator = (row.get("Creator") or row.get("Influencers") or row.get("Influencer") or "").strip()
        if email and creator and email not in email_to_creator:
            email_to_creator[email] = creator
    return email_to_creator


# ── OMK order fetching ────────────────────────────────────────────────────────

def _start_iso(d: date) -> str:
    return d.strftime("%Y-%m-%dT00:00:00.000Z")


def _end_iso(d: date) -> str:
    return d.strftime("%Y-%m-%dT23:59:59.999Z")


def _fetch_orders(
    cookie: str,
    org_id: str,
    branch_uuid: str,
    start_iso: str,
    end_iso: str,
    client: httpx.Client,
    headers: dict,
    backoffice: dict,
) -> List[Dict[str, Any]]:
    all_orders: List[Dict[str, Any]] = []
    for page in range(1, 51):
        query = _QUERY.format(
            page=page, org=org_id, branch=branch_uuid,
            start=start_iso, end=end_iso,
        )
        resp = client.post(
            backoffice["graphql_url"],
            headers=headers,
            json={"operationName": "", "variables": {}, "query": query},
        )
        resp.raise_for_status()
        data = resp.json().get("data") or {}
        orders = (data.get("PlOrders") or {}).get("Data") or []
        all_orders.extend(orders)
        if len(orders) < 100:
            break
    return all_orders


def _week_stats(
    orders: List[Dict[str, Any]],
    label: str,
    leat_emails: Optional[set] = None,
) -> WeekData:
    seen: set = set()
    subtotal_sum = 0.0
    leat = 0
    guest = 0
    discounted = 0
    for order in orders:
        oid = order.get("ItemId", "")
        if oid in seen:
            continue
        seen.add(oid)
        subtotal_sum += float(order.get("SubTotal") or 0)
        if float(order.get("DiscountAmount") or 0) > 0:
            discounted += 1
        if leat_emails is not None:
            email = (order.get("CustomerEmail") or "").strip().lower()
            if email and email in leat_emails:
                leat += 1
            else:
                guest += 1
    n = len(seen)
    return WeekData(
        label=label,
        total=n,
        leat=leat,
        guest=guest,
        discounted=discounted,
        avg_basket=subtotal_sum / n if n else 0.0,
    )


# ── Chart generation ──────────────────────────────────────────────────────────

def _bar_chart(
    labels: List[str],
    values: List[float],
    title: str,
    fmt: str = "{:.0f}",
) -> io.BytesIO:
    fig, ax = plt.subplots(figsize=(3.5, 2.4), dpi=130)
    bars = ax.bar(labels, values, color=_RED, width=0.45)
    ax.set_title(title, fontsize=9, fontweight="bold", pad=6)
    ax.tick_params(labelsize=8)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    max_v = max(values) if values else 1
    ax.set_ylim(0, max_v * 1.2)
    for bar, val in zip(bars, values):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            bar.get_height() + max_v * 0.03,
            fmt.format(val),
            ha="center", va="bottom", fontsize=7.5,
        )
    fig.tight_layout(pad=0.5)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=130)
    plt.close(fig)
    buf.seek(0)
    return buf


def _line_chart(
    labels: List[str],
    values: List[float],
    title: str,
    current: float,
) -> io.BytesIO:
    fig, ax = plt.subplots(figsize=(3.5, 2.4), dpi=130)
    ax.plot(labels, values, color=_RED, marker="o", linewidth=1.5, markersize=4, zorder=3)
    ax.set_title(title, fontsize=9, fontweight="bold", pad=6)
    ax.tick_params(labelsize=7)
    ax.tick_params(axis="x", rotation=45)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    if labels and values:
        ax.annotate(
            f"Aktuell: CHF {current:.2f}",
            xy=(len(labels) - 1, values[-1]),
            xytext=(-45, 8),
            textcoords="offset points",
            fontsize=7,
            color="#666666",
            arrowprops=dict(arrowstyle="->", color="#999999", lw=0.8),
        )
    fig.tight_layout(pad=0.5)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=130)
    plt.close(fig)
    buf.seek(0)
    return buf


# ── PDF ───────────────────────────────────────────────────────────────────────

class _PDF(FPDF):
    def __init__(self, gen_time: str):
        super().__init__()
        self._gen_time = gen_time

    def footer(self):
        self.set_y(-13)
        self.set_font("Helvetica", "I", 7)
        self.set_text_color(140, 140, 140)
        self.cell(0, 5, "Vapiano Pilot - Report erstellt durch ORDERMONKEY", align="L")
        self.set_y(-13)
        self.cell(0, 5, f"Generiert am: {self._gen_time}", align="R")


def _kpi_card(pdf: FPDF, x: float, y: float, w: float, h: float, label: str, value: str) -> None:
    pdf.set_draw_color(200, 200, 200)
    pdf.set_line_width(0.3)
    pdf.rect(x, y, w, h)
    pdf.set_xy(x + 2, y + 2.5)
    pdf.set_font("Helvetica", "", 7)
    pdf.set_text_color(110, 110, 110)
    pdf.cell(w - 4, 5, label)
    pdf.set_xy(x + 2, y + 9)
    is_chf = value.startswith("CHF")
    pdf.set_font("Helvetica", "B", 9 if is_chf else 12)
    pdf.set_text_color(25, 25, 25)
    pdf.cell(w - 4, 8, value)


def build_vapiano_report(
    cookie: str,
    org_id: str,
    branch_uuid: str,
    start_date: str,
    end_date: str,
    leat_csv_text: str,
    influencer_signups: Dict[str, int],
    location_name: str = "Vapiano",
    backoffice_id: str = "ordermonkey",
) -> bytes:
    # ── LEAT ──────────────────────────────────────────────────────────────────
    email_to_creator = _parse_leat(leat_csv_text)
    leat_emails = set(email_to_creator.keys())

    # ── Date maths ────────────────────────────────────────────────────────────
    start_dt = datetime.strptime(start_date, "%Y-%m-%d").date()
    end_dt = datetime.strptime(end_date, "%Y-%m-%d").date()
    iso_year, iso_week, _ = start_dt.isocalendar()
    week_label = f"{iso_year}-W{iso_week:02d}"
    period_str = f"{start_dt.strftime('%d.%m.%Y')} - {end_dt.strftime('%d.%m.%Y')}"

    # ── Fetch data ────────────────────────────────────────────────────────────
    backoffice = _resolve_backoffice(backoffice_id)
    headers = _build_headers(
        cookie, "https://cms.ordermonkey.com", "https://cms.ordermonkey.com", backoffice
    )
    history: List[WeekData] = []

    with httpx.Client(timeout=httpx.Timeout(300), trust_env=False) as client:
        # 7 historical weeks (avg basket trend only, no LEAT match needed)
        for weeks_back in range(7, 0, -1):
            w_start = start_dt - timedelta(weeks=weeks_back)
            w_end = w_start + timedelta(days=6)
            iy, iw, _ = w_start.isocalendar()
            lbl = f"{iy}-W{iw:02d}"
            try:
                ref = _refresh_access_token(cookie, client)
                if ref != cookie:
                    cookie = ref
                    headers["cookie"] = cookie
                w_orders = _fetch_orders(
                    cookie, org_id, branch_uuid,
                    _start_iso(w_start), _end_iso(w_end),
                    client, headers, backoffice,
                )
                history.append(_week_stats(w_orders, lbl))
            except Exception:
                history.append(WeekData(label=lbl))

        # Current week
        ref = _refresh_access_token(cookie, client)
        if ref != cookie:
            cookie = ref
            headers["cookie"] = cookie
        current_orders = _fetch_orders(
            cookie, org_id, branch_uuid,
            _start_iso(start_dt), _end_iso(end_dt),
            client, headers, backoffice,
        )

    current = _week_stats(current_orders, week_label, leat_emails)
    all_weeks = history + [current]

    # ── Per-influencer stats ──────────────────────────────────────────────────
    influencers = [
        InfluencerData(name=name, signups=count)
        for name, count in influencer_signups.items()
    ]
    seen_ids: set = set()
    for order in current_orders:
        oid = order.get("ItemId", "")
        if oid in seen_ids:
            continue
        seen_ids.add(oid)
        email = (order.get("CustomerEmail") or "").strip().lower()
        creator = email_to_creator.get(email)
        if not creator:
            continue
        for inf in influencers:
            if inf.name == creator:
                inf.orders += 1
                inf.subtotal += float(order.get("SubTotal") or 0)
                if float(order.get("DiscountAmount") or 0) > 0:
                    inf.discounted_orders += 1

    # ── Charts ────────────────────────────────────────────────────────────────
    chart_lg = _bar_chart(
        ["LEAT eingeloggt", "Gast"],
        [float(current.leat), float(current.guest)],
        "LEAT eingeloggt vs. Gast (Bestellungen)",
    )
    chart_trend = _line_chart(
        [w.label for w in all_weeks],
        [w.avg_basket for w in all_weeks],
        "Wöchtl. Ø Warenkorbwert (vor Rabatt)",
        current.avg_basket,
    )
    chart_inf_orders = (
        _bar_chart(
            [i.name for i in influencers],
            [float(i.orders) for i in influencers],
            "Bestellungen pro Influencer",
        )
        if influencers else None
    )
    chart_inf_basket = (
        _bar_chart(
            [i.name for i in influencers],
            [i.avg_basket for i in influencers],
            "Ø Warenkorbwert pro Influencer (vor Rabatt)",
            fmt="{:.2f}",
        )
        if influencers else None
    )

    # ── PDF layout ────────────────────────────────────────────────────────────
    gen_time = datetime.now().strftime("%d.%m.%Y %H:%M")
    pdf = _PDF(gen_time)
    pdf.set_auto_page_break(auto=True, margin=13)
    pdf.add_page()
    pdf.set_margins(15, 15, 15)

    # Header
    pdf.set_font("Helvetica", "B", 14)
    pdf.set_text_color(25, 25, 25)
    pdf.cell(0, 10, "Vapiano Pilot - Wöchentlicher KPI-Report", ln=True)

    pdf.set_font("Helvetica", "", 8.5)
    pdf.set_text_color(90, 90, 90)
    pdf.cell(
        0, 6,
        f"Standort: {location_name}  |  Woche: {week_label}  |  Zeitraum: {period_str}",
        ln=True,
    )

    pdf.set_draw_color(204, 18, 18)
    pdf.set_line_width(0.5)
    y_line = pdf.get_y() + 3
    pdf.line(15, y_line, 195, y_line)
    pdf.set_y(y_line + 6)

    # KPI cards — 5 cards across full width
    card_y = pdf.get_y()
    n_cards = 5
    gap = 2.0
    card_w = (180.0 - gap * (n_cards - 1)) / n_cards  # = 34.4mm
    card_h = 22.0
    cards = [
        ("Bestellungen", str(current.total)),
        ("LEAT eingeloggt", str(current.leat)),
        ("Gast", str(current.guest)),
        ("Ø Warenkorbwert*", f"CHF {current.avg_basket:.2f}"),
        ("Davon mit Rabatt", str(current.discounted)),
    ]
    for i, (lbl, val) in enumerate(cards):
        _kpi_card(pdf, 15 + i * (card_w + gap), card_y, card_w, card_h, lbl, val)
    pdf.set_y(card_y + card_h + 3)

    # Footnote for avg basket
    pdf.set_font("Helvetica", "I", 6.5)
    pdf.set_text_color(140, 140, 140)
    pdf.cell(0, 5, "* Ø Warenkorbwert basiert auf SubTotal (Brutto vor Willkommens-Rabatt)", ln=True)
    pdf.ln(3)

    # Charts row 1
    cw, ch = 86.0, 58.0
    y1 = pdf.get_y()
    pdf.image(chart_lg, x=15, y=y1, w=cw, h=ch)
    pdf.image(chart_trend, x=109, y=y1, w=cw, h=ch)
    pdf.set_y(y1 + ch + 5)

    # Charts row 2 (only if influencers present)
    if chart_inf_orders and chart_inf_basket:
        y2 = pdf.get_y()
        pdf.image(chart_inf_orders, x=15, y=y2, w=cw, h=ch)
        pdf.image(chart_inf_basket, x=109, y=y2, w=cw, h=ch)
        pdf.set_y(y2 + ch + 7)

    # Influencer table
    if influencers:
        pdf.set_font("Helvetica", "B", 11)
        pdf.set_text_color(25, 25, 25)
        pdf.cell(0, 7, "Influencer Übersicht", ln=True)

        col_w = [62.0, 25.0, 30.0, 28.0, 35.0]
        col_hdrs = ["Influencer", "Signups", "Bestellungen", "Rabatt-Best.", "Gesamtumsatz"]
        pdf.set_font("Helvetica", "B", 8.5)
        pdf.set_text_color(204, 18, 18)
        for w, h in zip(col_w, col_hdrs):
            pdf.cell(w, 7, h, border="B")
        pdf.ln()

        pdf.set_font("Helvetica", "", 8.5)
        pdf.set_text_color(25, 25, 25)
        for inf in influencers:
            pdf.cell(col_w[0], 6.5, inf.name)
            pdf.cell(col_w[1], 6.5, str(inf.signups))
            pdf.cell(col_w[2], 6.5, str(inf.orders))
            pdf.cell(col_w[3], 6.5, str(inf.discounted_orders))
            pdf.cell(col_w[4], 6.5, f"CHF {inf.subtotal:.2f}")
            pdf.ln()

    return bytes(pdf.output())
