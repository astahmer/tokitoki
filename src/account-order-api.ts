import { z } from "zod";
import { setMenubarAccountOrder, setPreviewAccountOrder, setPreviewAccountVisibility, setSurfaceVisibility } from "./uiToggles.ts";

const AccountIdSchema = z.string().min(3).max(4096).refine((id) => {
  const at = id.indexOf("@");
  return at > 0 && at < id.length - 1;
});
const OrderSchema = z.object({ ids: z.array(AccountIdSchema).max(512), barIds: z.array(AccountIdSchema).max(512).optional() }).strict();
const VisibilitySchema = z.object({ id: AccountIdSchema, hidden: z.boolean().optional(), barHidden: z.boolean().optional() }).strict().refine((value) => value.hidden !== undefined || value.barHidden !== undefined);
const json = (body: unknown, status = 200): Response => Response.json(body, {
  status, headers: { "cache-control": "no-store" },
});

/** A narrow UI preference mutation shared by the native HTTP adapter and dashboard. */
export const handleAccountOrderRequest = async (request: Request): Promise<Response> => {
  if (request.method !== "POST") return json({ error: "use POST" }, 405);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== new URL(request.url).origin) return json({ error: "same-origin request required" }, 403);
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    return json({ error: "application/json required" }, 415);
  }
  const body = await request.json().catch(() => undefined);
  const path = new URL(request.url).pathname;
  if (path.endsWith("/account-visibility")) {
    const visibility = VisibilitySchema.safeParse(body);
    if (!visibility.success) return json({ error: "invalid account visibility" }, 400);
    try {
      const { id, hidden, barHidden } = visibility.data;
      const at = id.indexOf("@");
      if (hidden !== undefined) setSurfaceVisibility(id.slice(0, at) + ":" + id.slice(at + 1), "widget", !hidden);
      if (barHidden !== undefined) setPreviewAccountVisibility(id, !barHidden);
      return json({ ok: true });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }
  const parsed = OrderSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid account order", details: z.treeifyError(parsed.error) }, 400);
  const ids = [...new Set(parsed.data.ids)];
  try {
    if (path.endsWith("/bar-account-order")) {
      setPreviewAccountOrder(ids);
      return json({ ok: true, barAccountOrder: ids });
    }
    setMenubarAccountOrder(ids, parsed.data.barIds);
    return json({ ok: true, accountOrder: ids });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
};
