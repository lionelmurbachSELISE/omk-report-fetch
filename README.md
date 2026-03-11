# Subway Backoffice Local App

Local internal web app for querying Subway Backoffice GraphQL via a FastAPI proxy and exporting results to CSV.

## Structure

- `backend/` FastAPI API proxy
- `frontend/` React + Vite UI
- `examples/` example request type config + branch list import

## Requirements

- Python 3.10+
- Node 18+

## Local Run

### 1) Backend

```bash
cd "/Users/alifchowdhury/Desktop/My Apps/Perosnla dashboard/subway-backoffice-app/backend"
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### 2) Frontend

```bash
cd "/Users/alifchowdhury/Desktop/My Apps/Perosnla dashboard/subway-backoffice-app/frontend"
npm install
npm run dev
```

Open `http://localhost:5173`.

## Core Notes

- The browser **never** calls the Subway endpoint directly. All traffic goes through FastAPI.
- Cookie is not logged, and is only stored locally if you explicitly enable "Save cookie locally".
- Curl parser is best-effort for Chrome “Copy as cURL”.
- CSV export re-runs the request on the backend to generate a full CSV.

## Request Type Templates

- Use placeholders in GraphQL templates or raw JSON body:
  - `{{ORG_ID}}`
  - `{{BRANCH_UUID}}`
  - `{{PAGE_NUMBER}}`
  - `{{PAGE_SIZE}}`

## Adding a New Request Type

1. Duplicate one of the request type configs in the UI.
2. Set a `queryTemplate` or `rawJsonBody`.
3. Add `mappingJson` to map columns to paths (e.g. `OrderProducts[0].Name`).
4. Enter `csvSchema` if you need a strict column order.

## Example Files

- Example request type: `examples/refunded_products_request_type.json`
- Example branch list: `examples/branches.txt`

## Security

- Cookie is only kept in memory for requests.
- Cookie is not sent back to the frontend in responses.
- No secrets are hardcoded.

## Troubleshooting

- 401/403 indicates missing or expired cookie.
- Non‑JSON responses show a snippet in error messages.
- If a single branch fails, results for other branches continue.
