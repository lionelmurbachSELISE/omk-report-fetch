export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";

export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `Request failed: ${resp.status}`);
  }

  return resp.json() as Promise<T>;
}

export interface CsvResult {
  blob: Blob;
  partialErrors: string | null;
  errorCount: number;
}

export async function postBlob(path: string, body: unknown): Promise<CsvResult> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text();
    let message = `Request failed: ${resp.status}`;
    try {
      const json = JSON.parse(text);
      message = json?.detail || json?.message || text || message;
    } catch {
      message = text || message;
    }
    throw new Error(message);
  }

  const blob = await resp.blob();
  const partialErrors = resp.headers.get("X-Export-Errors");
  const errorCount = parseInt(resp.headers.get("X-Export-Error-Count") || "0", 10);
  return { blob, partialErrors, errorCount };
}

export async function postCsv(path: string, body: unknown): Promise<CsvResult> {
  return postBlob(path, body);
}
