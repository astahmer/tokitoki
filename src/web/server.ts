import fs from "node:fs";
import path from "node:path";

import { apiAnomalies, apiExport, apiGrid, apiSessionDetail, apiSessions, apiSources, apiSummary, apiTable, apiTimeseries, type WindowParams } from "./api.ts";

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
  return path.join(import.meta.dir, "..", "..", "dist", "web");
}

/** Start the dashboard. Returns the Bun server (caller keeps it alive). */
export function startWebServer(options: WebServerOptions = {}): Bun.Server<undefined> {
  const staticRoot = options.staticRoot ?? defaultStaticRoot();
  const indexHtml = path.join(staticRoot, "index.html");
  return Bun.serve({
    port: options.port ?? 7788,
    async fetch(request) {
      const url = new URL(request.url);
      const { pathname } = url;
      try {
        if (pathname.startsWith("/api/")) {
          return api(request, pathname, url);
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

  function api(request: Request, pathname: string, url: URL): Response {
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
        return json(apiTimeseries(by, { ...win(), days: Number.isFinite(days) ? days : 30 }));
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
      case "/api/sources":
        return json(apiSources());
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
