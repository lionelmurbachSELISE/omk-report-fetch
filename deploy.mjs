#!/usr/bin/env node
/**
 * deploy.mjs — Blocks Release deploy for omk-report-fetch
 *
 * Workaround: the Blocks CLI uses api.seliseblocks.com as base, but the Release
 * service lives at release.seliseblocks.com/api/*. This script:
 *   1. Starts a local reverse-proxy on port 9876 that routes correctly
 *   2. Patches the CLI's RELEASE_API path from /release/v4/api → /api
 *   3. Runs blocks release deploy (or setup for first-time)
 *   4. Cleans up
 *
 * Usage:
 *   node deploy.mjs           # trigger a new build (deploy)
 *   node deploy.mjs --setup   # first-time setup (creates namespace + webhook)
 *   node deploy.mjs --wait    # deploy and wait until build finishes
 *   node deploy.mjs --dry-run # print what would happen, don't actually deploy
 */

import http from "http";
import https from "https";
import { execSync, spawn } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { createRequire } from "module";

const PROXY_PORT = 9876;
const CLI_RELEASE_LIB = new URL(
  "file:///C:/Users/lione/AppData/Roaming/npm/node_modules/@seliseblocks/cli-os/dist/lib/release.js"
).pathname.replace(/^\//, "");

// ── 1. Patch CLI ────────────────────────────────────────────────────────────
function patchCli() {
  const src = readFileSync(CLI_RELEASE_LIB, "utf8");
  const patched = src.replace(
    'export const RELEASE_API = "/release/v4/api";',
    'export const RELEASE_API = "/api"; // patched by deploy.mjs'
  );
  if (patched === src && !src.includes("patched by deploy.mjs")) {
    console.error("Warning: RELEASE_API constant not found — CLI may have been updated. Check deploy.mjs.");
  }
  writeFileSync(CLI_RELEASE_LIB, patched, "utf8");
}

function unpatchCli() {
  const src = readFileSync(CLI_RELEASE_LIB, "utf8");
  const restored = src.replace(
    'export const RELEASE_API = "/api"; // patched by deploy.mjs',
    'export const RELEASE_API = "/release/v4/api";'
  );
  writeFileSync(CLI_RELEASE_LIB, restored, "utf8");
}

// ── 2. Local reverse-proxy ──────────────────────────────────────────────────
function startProxy() {
  const server = http.createServer((req, res) => {
    const targetHost = req.url.startsWith("/api/")
      ? "release.seliseblocks.com"
      : "api.seliseblocks.com";

    const options = {
      hostname: targetHost,
      port: 443,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: targetHost },
    };

    const proxyReq = https.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on("error", (e) => {
      res.writeHead(502);
      res.end(e.message);
    });

    req.pipe(proxyReq, { end: true });
  });

  return new Promise((resolve) => {
    server.listen(PROXY_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ── 3. Main ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isSetup = args.includes("--setup");
const isDryRun = args.includes("--dry-run");
const doWait = args.includes("--wait") || isSetup; // setup always waits

let proxy;
try {
  patchCli();
  proxy = await startProxy();
  console.log(`✓ Proxy on http://localhost:${PROXY_PORT}`);

  const apiUrl = `http://localhost:${PROXY_PORT}`;
  const cmd = isSetup ? "setup" : "deploy";
  const extraFlags = [
    `--api-url ${apiUrl}`,
    isDryRun ? "--dry-run" : "--yes",
    doWait ? "--wait" : "",
    "--json",
  ].filter(Boolean).join(" ");

  const fullCmd = `blocks release ${cmd} ${extraFlags}`;
  console.log(`▶ ${fullCmd}\n`);

  const child = spawn("blocks", ["release", cmd, "--api-url", apiUrl,
    ...(isDryRun ? ["--dry-run"] : ["--yes"]),
    ...(doWait ? ["--wait"] : []),
    "--json",
  ], { stdio: "inherit", shell: true });

  await new Promise((resolve, reject) => {
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`Exit ${code}`))));
  });
} finally {
  proxy?.close();
  unpatchCli();
  console.log("\n✓ Cleanup done.");
}
