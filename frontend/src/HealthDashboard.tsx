import { useCallback, useEffect, useState } from "react";
import { API_BASE } from "./utils/api";

interface ChannelStats {
  orders: number;
  revenue: number;
}

interface OrgHealthResult {
  name: string;
  orgId: string;
  orders7d: number | null;
  revenue7d: number | null;
  lastOrderDate: string | null;
  byChannel: Record<string, ChannelStats>;
  error: string | null;
  fetchedAt: string;
}

interface HealthResults {
  results: OrgHealthResult[];
  runAt: string;
  durationSeconds: number | null;
}

type OrgStatus = "ok" | "warn" | "error";
type SortDir = "desc" | "asc";

function formatCHF(value: number): string {
  return new Intl.NumberFormat("de-CH", { style: "currency", currency: "CHF" }).format(value);
}

function formatRelative(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);
  if (hours < 1) return "< 1h ago";
  if (hours < 24) return `${hours}h ago`;
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", { dateStyle: "short", timeStyle: "short" });
}

function allChannels(results: OrgHealthResult[]): string[] {
  const seen = new Set<string>();
  for (const r of results) {
    for (const ch of Object.keys(r.byChannel ?? {})) seen.add(ch);
  }
  return Array.from(seen).sort();
}

function getStatus(result: OrgHealthResult): OrgStatus {
  if (result.error) return "error";
  const hoursAgo = result.lastOrderDate
    ? (Date.now() - new Date(result.lastOrderDate).getTime()) / 3_600_000
    : Infinity;
  if (hoursAgo > 120) return "error";
  if (hoursAgo > 72) return "warn";
  return "ok";
}

function getLastOrderStatus(lastOrderDate: string | null): OrgStatus {
  if (!lastOrderDate) return "error";
  const hoursAgo = (Date.now() - new Date(lastOrderDate).getTime()) / 3_600_000;
  if (hoursAgo > 120) return "error";
  if (hoursAgo > 72) return "warn";
  return "ok";
}

function StatusBadge({ status }: { status: OrgStatus }) {
  const config: Record<OrgStatus, { cls: string; label: string }> = {
    ok:    { cls: "health-badge--ok",    label: "Active" },
    warn:  { cls: "health-badge--warn",  label: "Slow" },
    error: { cls: "health-badge--error", label: "Inactive" },
  };
  const { cls, label } = config[status];
  return <span className={`health-badge ${cls}`}>{label}</span>;
}

function HealthSummary({ results }: { results: OrgHealthResult[] }) {
  const counts: Record<OrgStatus, number> = { ok: 0, warn: 0, error: 0 };
  for (const r of results) counts[getStatus(r)]++;

  return (
    <div className="health-summary">
      <div className="health-summary-stat health-summary-stat--ok">
        <span className="health-summary-dot" />
        <span>{counts.ok} Active</span>
      </div>
      {counts.warn > 0 && (
        <div className="health-summary-stat health-summary-stat--warn">
          <span className="health-summary-dot" />
          <span>{counts.warn} Slow</span>
        </div>
      )}
      {counts.error > 0 && (
        <div className="health-summary-stat health-summary-stat--error">
          <span className="health-summary-dot" />
          <span>{counts.error} Inactive</span>
        </div>
      )}
      <div className="health-summary-spacer" />
      <span className="health-summary-total">{results.length} orgs</span>
    </div>
  );
}

function OrgCard({ result, channel }: { result: OrgHealthResult; channel: string | null }) {
  const status = getStatus(result);
  const orders = channel
    ? (result.byChannel?.[channel]?.orders ?? 0)
    : (result.orders7d ?? 0);
  const revenue = channel
    ? (result.byChannel?.[channel]?.revenue ?? 0)
    : (result.revenue7d ?? 0);
  const lastOrderStatus = getLastOrderStatus(result.lastOrderDate);
  const channelNames = Object.keys(result.byChannel ?? {});

  return (
    <div className={`health-card health-card--${status}`}>
      <div className="health-card-header">
        <span className="health-card-name">{result.name}</span>
        <StatusBadge status={status} />
      </div>

      {result.error ? (
        <div className="health-card-error">{result.error}</div>
      ) : (
        <div className="health-card-metrics">
          <div className="health-metric">
            <span className="health-metric-value">{orders.toLocaleString("de-CH")}</span>
            <span className="health-metric-label">Orders · 7d</span>
          </div>
          <div className="health-metric">
            <span className="health-metric-value">{formatCHF(revenue)}</span>
            <span className="health-metric-label">Revenue · 7d</span>
          </div>
          <div className={`health-metric health-metric--${lastOrderStatus}`}>
            <span className="health-metric-value">
              {result.lastOrderDate ? formatRelative(result.lastOrderDate) : "—"}
            </span>
            <span className="health-metric-label">Last order</span>
          </div>
        </div>
      )}

      <div className="health-card-footer">
        <div className="health-card-channels">
          {channelNames.length > 0
            ? channelNames.map((ch) => <span key={ch} className="health-channel-tag">{ch}</span>)
            : <span className="health-no-channels">No active channels</span>
          }
        </div>
        <span className="health-fetched-at">{formatDateTime(result.fetchedAt)}</span>
      </div>
    </div>
  );
}

function sortedResults(results: OrgHealthResult[], dir: SortDir): OrgHealthResult[] {
  return [...results].sort((a, b) => {
    const ta = a.lastOrderDate ? new Date(a.lastOrderDate).getTime() : 0;
    const tb = b.lastOrderDate ? new Date(b.lastOrderDate).getTime() : 0;
    return dir === "desc" ? tb - ta : ta - tb;
  });
}

export function HealthDashboard() {
  const [data, setData] = useState<HealthResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [channel, setChannel] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [statusFilter, setStatusFilter] = useState<OrgStatus | null>(null);

  const fetchResults = useCallback(async () => {
    try {
      const resp = await fetch(`${API_BASE}/api/customer-health/results`);
      if (resp.status === 404) { setData(null); return; }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setData(await resp.json());
    } catch (e: any) {
      setError(e.message || "Failed to load results");
    }
  }, []);

  useEffect(() => { fetchResults(); }, [fetchResults]);

  async function handleRunNow() {
    setError(null);
    setLoading(true);
    try {
      const resp = await fetch(`${API_BASE}/api/customer-health/run`, { method: "POST" });
      if (resp.status === 409) { setError("Health check already running — please wait."); return; }
      if (!resp.ok) throw new Error(await resp.text() || `HTTP ${resp.status}`);
      const result: HealthResults = await resp.json();
      setData(result);
      const channels = allChannels(result.results);
      if (channel && !channels.includes(channel)) setChannel(null);
    } catch (e: any) {
      setError(e.message || "Run failed");
    } finally {
      setLoading(false);
    }
  }

  const channels = data ? allChannels(data.results) : [];
  const filteredByStatus = data
    ? (statusFilter ? data.results.filter((r) => getStatus(r) === statusFilter) : data.results)
    : [];
  const displayed = sortedResults(filteredByStatus, sortDir);

  return (
    <div>
      <div className="health-toolbar">
        <div className="health-run-meta">
          {data && (
            <span className="muted">
              Last run: {formatDateTime(data.runAt)}
              {data.durationSeconds != null && ` · ${data.durationSeconds}s`}
            </span>
          )}
        </div>
        <div className="health-toolbar-actions">
          {data && (
            <button
              className="secondary"
              onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
            >
              Last order {sortDir === "desc" ? "↓" : "↑"}
            </button>
          )}
          <button className="primary" onClick={handleRunNow} disabled={loading}>
            {loading ? "Running…" : "Run Now"}
          </button>
        </div>
      </div>

      {error && <div className="error" style={{ marginBottom: 16 }}>{error}</div>}

      {data && !loading && <HealthSummary results={data.results} />}

      {data && !loading && (
        <div className="health-status-filter">
          <button
            className={`channel-btn ${!statusFilter ? "channel-btn--active" : ""}`}
            onClick={() => setStatusFilter(null)}
          >
            All
          </button>
          {(["ok", "warn", "error"] as OrgStatus[]).map((s) => (
            <button
              key={s}
              className={`status-filter-btn status-filter-btn--${s}${statusFilter === s ? " status-filter-btn--active" : ""}`}
              onClick={() => setStatusFilter(statusFilter === s ? null : s)}
            >
              {s === "ok" ? "Active" : s === "warn" ? "Slow" : "Inactive"}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className="health-loading">
          <svg className="health-spinner" width="22" height="22" viewBox="0 0 22 22" fill="none">
            <circle cx="11" cy="11" r="9" stroke="var(--border)" strokeWidth="2.5" />
            <path d="M11 2a9 9 0 0 1 9 9" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          Fetching metrics from all organizations — this may take a minute…
        </div>
      )}

      {!loading && data && channels.length > 0 && (
        <div className="health-channel-filter">
          <button
            className={`channel-btn ${channel === null ? "channel-btn--active" : ""}`}
            onClick={() => setChannel(null)}
          >
            All
          </button>
          {channels.map((ch) => (
            <button
              key={ch}
              className={`channel-btn ${channel === ch ? "channel-btn--active" : ""}`}
              onClick={() => setChannel(ch === channel ? null : ch)}
            >
              {ch}
            </button>
          ))}
        </div>
      )}

      {!loading && data && displayed.length > 0 && (
        <div className="health-grid">
          {displayed.map((r) => (
            <OrgCard key={r.orgId + r.name} result={r} channel={channel} />
          ))}
        </div>
      )}

      {!loading && !data && !error && (
        <div className="health-loading">
          No data yet — click <strong>Run Now</strong> to fetch metrics.
        </div>
      )}
    </div>
  );
}
