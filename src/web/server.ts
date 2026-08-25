import fs from "node:fs";
import path from "node:path";

import { apiAnomalies, apiBudgets, apiExport, apiGrid, apiSessionDetail, apiSessionSearch, apiSessions, apiSources, apiSummary, apiTable, apiTimeseries, type WindowParams } from "./api.ts";
import { atprotoConfig, buildSharePayload, describePayload, publishShare, readShareState } from "../share.ts";

export interface WebServerOptions {
  port?: number;
  /** Override for tests; defaults to <repo>/dist/web next to src/. */
  staticRoot?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function defaultStaticRoot(): string {
  // Running from source: prefer the repo's own build so web edits show up
  // immediately; the stable copy is only a fallback for old installs.
  const dataHome = process.env.XDG_DATA_HOME ?? path.join(process.env.HOME ?? "~", ".local", "share");
  const stable = path.join(dataHome, "tokitoki", "web");
  // Source layout: src/web/server.ts → <repo>/dist/web. Packaged layout:
  // dist/cli.js → sibling dist/web. Repo build wins so edits show up live;
  // the stable copy is only a fallback.
  const candidates = [
    path.join(import.meta.dir, "..", "..", "dist", "web"),
    path.join(import.meta.dir, "web"),
  ];
  return pickStaticRoot(candidates, stable);
}

/** First candidate containing index.html, else the fallback if valid, else
 *  the first candidate so error paths report the canonical location. */
export function pickStaticRoot(candidateDirs: string[], fallbackDir: string): string {
  for (const dir of candidateDirs) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return fs.existsSync(path.join(fallbackDir, "index.html")) ? fallbackDir : candidateDirs[0]!;
}

/** True when running from a source checkout that can rebuild the SPA. */
function isSourceCheckout(): boolean {
  return fs.existsSync(path.join(import.meta.dir, "..", "..", "web", "vite.config.ts"));
}

/** Start the dashboard. Returns the Bun server (caller keeps it alive). */
export function startWebServer(options: WebServerOptions = {}): Bun.Server<undefined> {
  let staticRoot = options.staticRoot ?? defaultStaticRoot();
  // Auto-build once when the SPA was never built (fresh clone / new machine).
  // Built assets are gitignored, so this is a normal first-run state. Only
  // possible in a source checkout — published packages ship dist/web prebuilt.
  if (options.staticRoot === undefined && !fs.existsSync(path.join(staticRoot, "index.html")) && isSourceCheckout()) {
    try {
      const repoRoot = path.resolve(import.meta.dir, "..", "..");
      console.error("web UI not built — building once (`bun run web:build`)…");
      const bun = Bun.which("bun") ?? process.execPath;
      const result = Bun.spawnSync([bun, "run", "web:build"], { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
      if (result.exitCode === 0) {
        staticRoot = path.join(repoRoot, "dist", "web");
      }
    } catch {
      // build failure surfaces as the 503 hint below
    }
  }
  const indexHtml = path.join(staticRoot, "index.html");
  return Bun.serve({
    port: options.port ?? 7788,
    async fetch(request) {
      const url = new URL(request.url);
      const { pathname } = url;
      try {
        if (pathname.startsWith("/api/")) {
          // await (not return) so rejections hit the catch below → 400s stay 400s
          return await api(request, pathname, url);
        }
        if (pathname === "/" || pathname === "/index.html") {
          if (!fs.existsSync(indexHtml)) {
            return text(
              "tokitoki web UI not built — run `bun run web:build` first\n",
              503,
            );
          }
          return file(indexHtml);
        }
        // Static assets from the built SPA (path-traversal safe: resolve and
        // verify containment).
        const candidate = path.resolve(staticRoot, "." + pathname);
        if (candidate.startsWith(path.resolve(staticRoot)) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return file(candidate);
        }
        // SPA fallback
        if (fs.existsSync(indexHtml)) return file(indexHtml);
        return text("not found\n", 404);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  });

  function file(p: string): Response {
    const ext = path.extname(p);
    return new Response(Bun.file(p), {
      headers: { "content-type": MIME[ext] ?? "application/octet-stream" },
    });
  }

  async function api(request: Request, pathname: string, url: URL): Promise<Response> {
    const win = (): WindowParams => ({
      last: url.searchParams.get("last") ?? undefined,
      from: url.searchParams.get("from") ?? undefined,
      to: url.searchParams.get("to") ?? undefined,
    });
    switch (pathname) {
      case "/api/summary":
        return json(apiSummary(win()));
      case "/api/timeseries": {
        const by = url.searchParams.get("by") ?? "provider";
        const days = Number(url.searchParams.get("days") ?? "30");
        return json(apiTimeseries(by, { ...win(), days: Number.isFinite(days) ? days : 30, metric: url.searchParams.get("metric") === "cost" ? "cost" : "tokens" }));
      }
      case "/api/table": {
        const by = url.searchParams.get("by") ?? "model";
        const period = url.searchParams.get("period") ?? "week";
        const account = url.searchParams.get("account") ?? undefined;
        const providers = url.searchParams.getAll("provider").filter((p) => p.length > 0);
        const delta = url.searchParams.get("delta") !== "0";
        const showEmail = url.searchParams.get("showEmail") === "1";
        return json(apiTable(by, win(), period, account === "" ? undefined : account, providers, delta, showEmail));
      }
      case "/api/anomalies": {
        const metric = url.searchParams.get("metric") ?? "tokens";
        return json(apiAnomalies(win(), metric));
      }
      case "/api/grid": {
        const days = Number(url.searchParams.get("days") ?? "365");
        const metric = url.searchParams.get("metric") ?? "tokens";
        return json(apiGrid({ ...win(), days: Number.isFinite(days) ? days : 365 }, metric));
      }
      case "/api/sessions": {
        const period = url.searchParams.get("period") ?? "week";
        const account = url.searchParams.get("account") ?? undefined;
        const providers = url.searchParams.getAll("provider").filter((p) => p.length > 0);
        const top = Number(url.searchParams.get("top") ?? "25");
        return json(apiSessions(win(), providers, account === "" ? undefined : account, top, period));
      }
      case "/api/budgets":
        return json(apiBudgets());
      case "/api/sources":
        return json(apiSources());
      case "/api/share": {
        const state = readShareState();
        return json({
          enabled: state.enabled,
          lastPublished: state.lastPublished ?? null,
          atprotoConfigured: atprotoConfig() !== null,
        });
      }
      case "/api/share/preview": {
        const scope = url.searchParams.get("scope") === "month" ? "month" : "week";
        const includeRepos = url.searchParams.get("include-repos") === "1";
        const payload = buildSharePayload(scope, { includeRepos });
        return json({ payload, lines: describePayload(payload, includeRepos) });
      }
      case "/api/share/publish": {
        if (request.method !== "POST") return text("method not allowed\n", 405);
        const body = (await request.json().catch(() => ({}))) as {
          scope?: string;
          includeRepos?: boolean;
          confirm?: boolean;
        };
        if (body.confirm !== true) return text("confirmation required\n", 400);
        const scope = body.scope === "month" ? "month" : "week";
        const state = readShareState();
        if (!state.enabled) return json({ error: "public sharing is disabled" }, 403);
        return publishShare(scope, { includeRepos: body.includeRepos === true })
          .then((r) => json({ ok: true, cid: r.cid, rkey: r.rkey, at: r.at }))
          .catch((err: unknown) =>
            json({ error: err instanceof Error ? err.message : String(err) }, 502));
      }
      case "/api/export": {
        const format = url.searchParams.get("format") ?? "json";
        const by = url.searchParams.get("by") ?? "model";
        const account = url.searchParams.get("account") ?? undefined;
        const providers = url.searchParams.getAll("provider").filter((p) => p.length > 0);
        const exp = apiExport(format, by, win(), account === "" ? undefined : account, providers);
        return new Response(exp.content, {
          headers: {
            "content-type": exp.contentType,
            "content-disposition": `attachment; filename="${exp.filename}"`,
          },
        });
      }
      case "/api/sessions/search": {
        const q = url.searchParams.get("q") ?? "";
        if (q.trim().length === 0) return text("q is required\n", 400);
        const page = Number(url.searchParams.get("page") ?? "1");
        const providers = url.searchParams.getAll("provider").filter((p) => p.length > 0);
        return json(apiSessionSearch(win(), q, providers, Number.isFinite(page) ? page : 1));
      }
      case "/api/sessions/detail": {
        const provider = url.searchParams.get("provider");
        const sessionId = url.searchParams.get("id");
        if (provider === null || provider.length === 0 || sessionId === null || sessionId.length === 0) {
          return text("provider and id are required\n", 400);
        }
        return json(apiSessionDetail(provider, sessionId));
      }
      default:
        if (request.method !== "GET") return text("method not allowed\n", 405);
        return text("not found\n", 404);
    }
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
