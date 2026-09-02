import { useRef, useState } from "react";
import { postBlob } from "./utils/api";

interface InfluencerEntry {
  name: string;
  count: number;
}

interface Props {
  cookie: string;
  orgId: string;
  branchUuid: string;
}

function getPrevWeek(): { start: string; end: string } {
  const today = new Date();
  const dow = today.getDay(); // 0=Sun … 6=Sat
  const sinceMonday = (dow + 6) % 7;
  const lastMonday = new Date(today);
  lastMonday.setDate(today.getDate() - sinceMonday - 7);
  const lastSunday = new Date(lastMonday);
  lastSunday.setDate(lastMonday.getDate() + 6);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(lastMonday), end: fmt(lastSunday) };
}

export function VapianoReport({ cookie, orgId, branchUuid }: Props) {
  const [dateMode, setDateMode] = useState<"prev" | "custom">("prev");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [leatCsvText, setLeatCsvText] = useState("");
  const [leatRowCount, setLeatRowCount] = useState(0);
  const [influencers, setInfluencers] = useState<InfluencerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = (ev.target?.result as string) || "";
      setLeatCsvText(text);

      const lines = text.split("\n");
      const header = lines[0]?.split(";").map((h) => h.trim()) ?? [];
      const creatorIdx = ["Creator", "Influencers", "Influencer"]
        .map((name) => header.indexOf(name))
        .find((idx) => idx !== -1) ?? -1;
      if (creatorIdx === -1) {
        setLeatRowCount(lines.filter((l) => l.trim()).length - 1);
        return;
      }
      const creators = new Set<string>();
      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        const cols = line.split(";");
        const c = cols[creatorIdx]?.trim();
        if (c) creators.add(c);
      }
      // Merge: keep existing entries, add names from CSV not already listed
      setInfluencers((prev) => {
        const existingNames = new Set(prev.map((e) => e.name.trim().toLowerCase()));
        const newEntries = [...creators]
          .filter((name) => !existingNames.has(name.toLowerCase()))
          .map((name) => ({ name, count: 0 }));
        return [...prev, ...newEntries];
      });
      setLeatRowCount(lines.filter((l) => l.trim()).length - 1);
    };
    reader.readAsText(file, "utf-8");
  }

  function addInfluencer() {
    setInfluencers((prev) => [...prev, { name: "", count: 0 }]);
  }

  function removeInfluencer(idx: number) {
    setInfluencers((prev) => prev.filter((_, i) => i !== idx));
  }

  function updateInfluencer(idx: number, field: "name" | "count", value: string | number) {
    setInfluencers((prev) => {
      const updated = [...prev];
      updated[idx] = { ...updated[idx], [field]: value };
      return updated;
    });
  }

  async function handleGenerate() {
    setError("");
    const { start, end } =
      dateMode === "prev" ? getPrevWeek() : { start: startDate, end: endDate };

    if (!start || !end) {
      setError("Bitte Zeitraum angeben.");
      return;
    }
    if (!leatCsvText) {
      setError("Bitte LEAT CSV hochladen.");
      return;
    }

    setLoading(true);
    try {
      const payload = {
        cookie,
        orgId,
        branchUuid,
        startDate: start,
        endDate: end,
        leatCsvText,
        influencerSignups: Object.fromEntries(
          influencers.filter((i) => i.name.trim()).map((i) => [i.name.trim(), i.count])
        ),
        locationName: "Vapiano",
        backofficeId: "ordermonkey",
      };
      const { blob } = await postBlob("/api/vapiano-report", payload);
      if (blob.size === 0) {
        setError("Report ist leer — Cookie abgelaufen?");
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `vapiano_kpi_${start}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e: unknown) {
      setError((e as Error).message || "Fehler beim Generieren des Reports.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginTop: "20px", borderTop: "1px solid #ddd", paddingTop: "16px" }}>
      <div style={{ fontWeight: 700, fontSize: "14px", marginBottom: "12px" }}>
        KPI Report (Influencer Pilot)
      </div>

      {/* Week selector */}
      <div style={{ marginBottom: "10px" }}>
        <label style={{ fontSize: "12px", fontWeight: 600, display: "block", marginBottom: "4px" }}>
          Zeitraum
        </label>
        <div style={{ display: "flex", gap: "6px", marginBottom: "6px" }}>
          <button
            className={dateMode === "prev" ? "primary" : "secondary"}
            style={{ padding: "4px 10px", fontSize: "12px" }}
            onClick={() => setDateMode("prev")}
          >
            Vorherige Woche
          </button>
          <button
            className={dateMode === "custom" ? "primary" : "secondary"}
            style={{ padding: "4px 10px", fontSize: "12px" }}
            onClick={() => setDateMode("custom")}
          >
            Benutzerdefiniert
          </button>
        </div>
        {dateMode === "prev" && (() => {
          const { start, end } = getPrevWeek();
          return (
            <div style={{ fontSize: "11px", color: "#666" }}>
              {start} – {end}
            </div>
          );
        })()}
        {dateMode === "custom" && (
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              style={{ fontSize: "12px" }}
            />
            <span>–</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              style={{ fontSize: "12px" }}
            />
          </div>
        )}
      </div>

      {/* LEAT CSV upload */}
      <div style={{ marginBottom: "10px" }}>
        <label style={{ fontSize: "12px", fontWeight: 600, display: "block", marginBottom: "4px" }}>
          LEAT CSV
        </label>
        <input ref={fileRef} type="file" accept=".csv" onChange={handleCsvUpload} style={{ fontSize: "12px" }} />
        {leatCsvText && (
          <div style={{ fontSize: "11px", color: "#666", marginTop: "3px" }}>
            {leatRowCount} Transaktionen geladen
          </div>
        )}
      </div>

      {/* Influencer list — manual + auto-detected */}
      <div style={{ marginBottom: "12px" }}>
        <label style={{ fontSize: "12px", fontWeight: 600, display: "block", marginBottom: "6px" }}>
          Influencer & Signups
        </label>
        {influencers.length > 0 && (
          <div style={{ marginBottom: "6px" }}>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 80px 28px",
                gap: "4px",
                marginBottom: "4px",
                fontSize: "11px",
                color: "#888",
                fontWeight: 600,
              }}
            >
              <span>Name</span>
              <span>Signups</span>
              <span />
            </div>
            {influencers.map((inf, i) => (
              <div
                key={i}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 80px 28px",
                  gap: "4px",
                  marginBottom: "4px",
                  alignItems: "center",
                }}
              >
                <input
                  type="text"
                  value={inf.name}
                  placeholder="Influencer Name"
                  onChange={(e) => updateInfluencer(i, "name", e.target.value)}
                  style={{ fontSize: "12px", padding: "2px 6px" }}
                />
                <input
                  type="number"
                  min={0}
                  value={inf.count}
                  onChange={(e) => updateInfluencer(i, "count", parseInt(e.target.value) || 0)}
                  style={{ fontSize: "12px", padding: "2px 4px", width: "100%" }}
                />
                <button
                  onClick={() => removeInfluencer(i)}
                  style={{
                    fontSize: "12px",
                    padding: "1px 6px",
                    background: "none",
                    border: "1px solid #ccc",
                    borderRadius: "3px",
                    cursor: "pointer",
                    color: "#888",
                    lineHeight: "1.4",
                  }}
                  title="Entfernen"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={addInfluencer}
          style={{
            fontSize: "12px",
            padding: "3px 10px",
            background: "none",
            border: "1px dashed #aaa",
            borderRadius: "4px",
            cursor: "pointer",
            color: "#555",
          }}
        >
          + Influencer hinzufügen
        </button>
      </div>

      {error && (
        <div style={{ color: "#c00", fontSize: "12px", marginBottom: "8px" }}>{error}</div>
      )}

      <button
        className="secondary"
        onClick={handleGenerate}
        disabled={loading || !cookie || !leatCsvText}
        style={{ fontSize: "13px" }}
      >
        {loading ? "Generiere PDF..." : "KPI Report herunterladen (PDF)"}
      </button>
    </div>
  );
}
