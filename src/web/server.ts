import { apiSummary, apiTable, apiTimeseries } from "./api.ts";
import { pageHtml } from "./page.ts";

export interface WebServerOptions {
  port?: number;
}

/** Start the dashboard. Returns the Bun server (caller keeps it alive). */
export function startWebServer(options: WebServerOptions = {}): Bun.Server<undefined> {
  return Bun.serve({
    port: options.port ?? 7788,
    async fetch(request) {
      const url = new URL(request.url);
      const { pathname } = url;
      try {
        if (pathname === "/" || pathname === "/index.html") {
          return new Response(pageHtml(), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (pathname === "/api/summary") {
          return json(apiSummary());
        }
        if (pathname === "/api/timeseries") {
          const by = url.searchParams.get("by") ?? "provider";
          const days = Number(url.searchParams.get("days") ?? "30");
          return json(apiTimeseries(by, days));
        }
        if (pathname === "/api/table") {
          const by = url.searchParams.get("by") ?? "model";
          const period = url.searchParams.get("period") ?? "week";
          const account = url.searchParams.get("account") ?? undefined;
          return json(apiTable(by, period, account === "" ? undefined : account));
        }
        return new Response("not found\n", { status: 404 });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
