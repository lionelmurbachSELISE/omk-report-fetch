import { useState } from "react";

interface TopProduct { name: string; qty: number }
interface BoxStat    { orders: number; revenue: number }
interface TimelineEntry { hour: number; orders: number }

interface Match {
  date: string;
  weekday: string;
  orders: number;
  revenue: number;
  avg_order: number;
  kiosk_orders: number;
  app_orders: number;
  kiosk_pct: number;
  app_pct: number;
  kiosk_avg: number;
  app_avg: number;
  peak_hour: number | null;
  peak_hour_orders: number;
  timeline: TimelineEntry[];
  top_products: TopProduct[];
  by_box: Record<string, BoxStat>;
}

interface Season {
  match_count: number;
  total_revenue: number;
  total_orders: number;
  avg_revenue_per_match: number;
  avg_order_value: number;
  best_match:  { date: string; revenue: number; weekday: string };
  worst_match: { date: string; revenue: number; weekday: string };
  kiosk_pct: number;
  app_pct: number;
  top_products_overall: TopProduct[];
}

export interface YBDashboardData {
  matches: Match[];
  season: Season;
  errors: string[];
}

const CHF = (n: number) =>
  "CHF " + n.toLocaleString("de-CH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtDate = (d: string) =>
  new Date(d + "T12:00:00").toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" });

const BOX_COLORS: Record<string, string> = {
  "BOX 6 - Pizza":  "#f59e0b",
  "BOX 7 - Pommes": "#10b981",
  "BOX 8 - Grill":  "#3b82f6",
  "BOX 9 - Döner":  "#ef4444",
};
const BOX_SHORT: Record<string, string> = {
  "BOX 6 - Pizza":  "Pizza",
  "BOX 7 - Pommes": "Pommes",
  "BOX 8 - Grill":  "Grill",
  "BOX 9 - Döner":  "Döner",
};

function MiniBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div style={{ background: "#e5e7eb", borderRadius: 4, height: 8, overflow: "hidden", flex: 1 }}>
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color, height: "100%", borderRadius: 4, transition: "width .4s" }} />
    </div>
  );
}

function KpiTile({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div style={{
      background: "var(--kpi-bg, #f8fafc)",
      border: "1px solid var(--kpi-border, #e2e8f0)",
      borderRadius: 12,
      padding: "16px 20px",
      display: "flex",
      flexDirection: "column",
      gap: 4,
      minWidth: 140,
      flex: "1 1 140px",
    }}>
      <span style={{ fontSize: 11, color: "#94a3b8", textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 700, color: accent ?? "var(--fg, #0f172a)", lineHeight: 1.2 }}>{value}</span>
      {sub && <span style={{ fontSize: 12, color: "#64748b" }}>{sub}</span>}
    </div>
  );
}

function MatchCard({ m, avgRevenue }: { m: Match; avgRevenue: number }) {
  const [open, setOpen] = useState(false);
  const maxBoxRev = Math.max(...Object.values(m.by_box).map(b => b.revenue), 1);
  const delta = m.revenue - avgRevenue;
  const deltaStr = (delta >= 0 ? "+" : "") + CHF(delta) + " vs. Ø";

  return (
    <div style={{
      background: "var(--card-bg, #fff)",
      border: "1px solid var(--card-border, #e2e8f0)",
      borderRadius: 14,
      overflow: "hidden",
      boxShadow: "0 1px 4px rgba(0,0,0,.06)",
    }}>
      {/* Header */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "14px 20px", cursor: "pointer",
          background: "var(--card-header, #f8fafc)",
          borderBottom: open ? "1px solid var(--card-border, #e2e8f0)" : "none",
        }}
      >
        <div style={{ flex: "0 0 auto" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>{fmtDate(m.date)}</div>
          <div style={{ fontSize: 11, color: "#94a3b8" }}>{m.weekday}</div>
        </div>

        <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
          {/* Revenue */}
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#0f172a" }}>{CHF(m.revenue)}</div>
            <div style={{ fontSize: 11, color: delta >= 0 ? "#10b981" : "#ef4444" }}>{deltaStr}</div>
          </div>
          {/* Orders */}
          <div style={{ textAlign: "center", padding: "2px 14px", background: "#f1f5f9", borderRadius: 8 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{m.orders}</div>
            <div style={{ fontSize: 10, color: "#64748b" }}>Bestellungen</div>
          </div>
          {/* Avg */}
          <div style={{ textAlign: "center", padding: "2px 14px", background: "#f1f5f9", borderRadius: 8 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{CHF(m.avg_order)}</div>
            <div style={{ fontSize: 10, color: "#64748b" }}>Ø Bestellwert</div>
          </div>
        </div>

        <span style={{ color: "#94a3b8", fontSize: 18, userSelect: "none" }}>{open ? "▲" : "▼"}</span>
      </div>

      {/* Expanded Detail */}
      {open && (
        <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Row: Kiosk vs App + Peak */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>

            {/* Kiosk / App split */}
            <div style={{ flex: "1 1 220px", background: "#f8fafc", borderRadius: 10, padding: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 12, color: "#64748b", marginBottom: 12 }}>KANAL-SPLIT</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 12, width: 60 }}>🖥 Kiosk</span>
                <MiniBar pct={m.kiosk_pct} color="#3b82f6" />
                <span style={{ fontSize: 12, fontWeight: 600, width: 46, textAlign: "right" }}>{m.kiosk_pct}%</span>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
                <span style={{ fontSize: 12, width: 60 }}>📱 App</span>
                <MiniBar pct={m.app_pct} color="#a78bfa" />
                <span style={{ fontSize: 12, fontWeight: 600, width: 46, textAlign: "right" }}>{m.app_pct}%</span>
              </div>
              <div style={{ display: "flex", gap: 12, fontSize: 11, color: "#64748b" }}>
                <span>Kiosk Ø {CHF(m.kiosk_avg)}</span>
                <span>App Ø {CHF(m.app_avg)}</span>
              </div>
            </div>

            {/* Peak hour */}
            <div style={{ flex: "1 1 160px", background: "#f8fafc", borderRadius: 10, padding: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 12, color: "#64748b", marginBottom: 12 }}>PEAK-STUNDE</div>
              {m.peak_hour !== null ? (
                <>
                  <div style={{ fontSize: 32, fontWeight: 800, color: "#f59e0b" }}>{m.peak_hour}:00</div>
                  <div style={{ fontSize: 12, color: "#64748b" }}>{m.peak_hour_orders} Bestellungen</div>
                </>
              ) : <div style={{ color: "#94a3b8" }}>–</div>}
            </div>

            {/* Timeline mini sparkline */}
            {m.timeline.length > 1 && (
              <div style={{ flex: "1 1 200px", background: "#f8fafc", borderRadius: 10, padding: 16 }}>
                <div style={{ fontWeight: 600, fontSize: 12, color: "#64748b", marginBottom: 12 }}>STUNDENVERLAUF</div>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 40 }}>
                  {(() => {
                    const maxO = Math.max(...m.timeline.map(t => t.orders), 1);
                    return m.timeline.map(t => (
                      <div key={t.hour} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                        <div
                          style={{
                            width: "100%",
                            height: `${Math.round(t.orders / maxO * 36)}px`,
                            background: t.hour === m.peak_hour ? "#f59e0b" : "#94a3b8",
                            borderRadius: "3px 3px 0 0",
                          }}
                        />
                        <span style={{ fontSize: 8, color: "#94a3b8" }}>{t.hour}</span>
                      </div>
                    ));
                  })()}
                </div>
              </div>
            )}
          </div>

          {/* Box breakdown */}
          <div style={{ background: "#f8fafc", borderRadius: 10, padding: 16 }}>
            <div style={{ fontWeight: 600, fontSize: 12, color: "#64748b", marginBottom: 12 }}>UMSATZ PRO BOX</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {Object.entries(m.by_box).map(([box, stat]) => (
                <div key={box} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{
                    fontSize: 11, fontWeight: 600, width: 56,
                    color: BOX_COLORS[box] ?? "#64748b",
                  }}>{BOX_SHORT[box] ?? box}</span>
                  <MiniBar pct={maxBoxRev > 0 ? stat.revenue / maxBoxRev * 100 : 0} color={BOX_COLORS[box] ?? "#94a3b8"} />
                  <span style={{ fontSize: 11, fontWeight: 600, width: 80, textAlign: "right" }}>{CHF(stat.revenue)}</span>
                  <span style={{ fontSize: 10, color: "#94a3b8", width: 60 }}>{stat.orders} Bestellg.</span>
                </div>
              ))}
            </div>
          </div>

          {/* Top products */}
          {m.top_products.length > 0 && (
            <div style={{ background: "#f8fafc", borderRadius: 10, padding: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 12, color: "#64748b", marginBottom: 10 }}>TOP PRODUKTE</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {m.top_products.map((p, i) => (
                  <div key={p.name} style={{
                    display: "flex", alignItems: "center", gap: 6,
                    background: "#fff", border: "1px solid #e2e8f0",
                    borderRadius: 8, padding: "5px 10px",
                  }}>
                    <span style={{ fontSize: 13, color: ["#f59e0b","#94a3b8","#cd7c3a"][i] ?? "#94a3b8" }}>
                      {["🥇","🥈","🥉","4.","5."][i]}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{p.name}</span>
                    <span style={{ fontSize: 11, color: "#64748b" }}>{p.qty}×</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function YBSeasonDashboard({ data }: { data: YBDashboardData }) {
  const { matches, season, errors } = data;
  if (!matches.length) {
    return (
      <div style={{ padding: 24, color: "#ef4444" }}>
        Keine Daten gefunden.
        {errors.length > 0 && <div style={{ marginTop: 8, fontSize: 12 }}>{errors.join(" | ")}</div>}
      </div>
    );
  }

  const maxRev = Math.max(...matches.map(m => m.revenue), 1);

  return (
    <div style={{ padding: "24px 0", display: "flex", flexDirection: "column", gap: 24 }}>

      {/* ── Season Header ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <img src="https://upload.wikimedia.org/wikipedia/de/thumb/b/bc/BSC_Young_Boys_Logo.svg/120px-BSC_Young_Boys_Logo.svg.png"
          alt="YB" style={{ width: 44, height: 44, objectFit: "contain" }} onError={e => (e.currentTarget.style.display = "none")} />
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--fg, #0f172a)" }}>BSC Young Boys — Season Dashboard</div>
          <div style={{ fontSize: 13, color: "#64748b" }}>{season.match_count} Match{season.match_count !== 1 ? "es" : ""}</div>
        </div>
      </div>

      {errors.length > 0 && (
        <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, padding: 12, fontSize: 12, color: "#dc2626" }}>
          ⚠ {errors.join(" | ")}
        </div>
      )}

      {/* ── Season KPI Tiles ── */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <KpiTile label="Gesamt-Umsatz"      value={CHF(season.total_revenue)}          sub={`${season.match_count} Matches`} />
        <KpiTile label="Ø Umsatz / Match"   value={CHF(season.avg_revenue_per_match)}  />
        <KpiTile label="Gesamt-Bestellungen" value={season.total_orders.toString()}     sub={`Ø ${CHF(season.avg_order_value)} / Bestellung`} />
        <KpiTile label="Bester Match"        value={CHF(season.best_match.revenue)}     sub={`${fmtDate(season.best_match.date)} · ${season.best_match.weekday}`} accent="#10b981" />
        <KpiTile label="Schwächster Match"   value={CHF(season.worst_match.revenue)}    sub={`${fmtDate(season.worst_match.date)} · ${season.worst_match.weekday}`} accent="#ef4444" />
        <KpiTile label="Kiosk-Anteil"        value={`${season.kiosk_pct}%`}             sub={`App ${season.app_pct}%`} />
      </div>

      {/* ── Revenue bar overview ── */}
      <div style={{ background: "var(--card-bg, #fff)", border: "1px solid var(--card-border, #e2e8f0)", borderRadius: 14, padding: "18px 20px" }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: "#64748b", marginBottom: 14 }}>UMSATZ PRO MATCH</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 80 }}>
          {matches.map(m => (
            <div key={m.date} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <div style={{ fontSize: 10, color: "#64748b", fontWeight: 600 }}>{CHF(m.revenue).replace("CHF ", "")}</div>
              <div style={{
                width: "100%",
                height: `${Math.round(m.revenue / maxRev * 60)}px`,
                background: m.revenue === season.best_match.revenue ? "#10b981" : "#3b82f6",
                borderRadius: "4px 4px 0 0",
                minHeight: 4,
              }} />
              <div style={{ fontSize: 9, color: "#94a3b8", textAlign: "center" }}>{fmtDate(m.date).slice(0, 5)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Top Products Overall ── */}
      {season.top_products_overall?.length > 0 && (
        <div style={{ background: "var(--card-bg, #fff)", border: "1px solid var(--card-border, #e2e8f0)", borderRadius: 14, padding: "18px 20px" }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: "#64748b", marginBottom: 14 }}>TOP PRODUKTE — GESAMTSAISON</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {season.top_products_overall.map((p, i) => {
              const maxQ = season.top_products_overall[0].qty;
              return (
                <div key={p.name} style={{ flex: "1 1 160px", background: "#f8fafc", borderRadius: 10, padding: "10px 14px" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 700 }}>
                      {["🥇","🥈","🥉","4.","5."][i]} {p.name}
                    </span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: "#0f172a" }}>{p.qty}×</span>
                  </div>
                  <MiniBar pct={p.qty / maxQ * 100} color="#f59e0b" />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Match Cards ── */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontWeight: 700, fontSize: 13, color: "#64748b" }}>ALLE MATCHES (klicken für Details)</div>
        {[...matches].sort((a, b) => b.date.localeCompare(a.date)).map(m => (
          <MatchCard key={m.date} m={m} avgRevenue={season.avg_revenue_per_match} />
        ))}
      </div>
    </div>
  );
}
