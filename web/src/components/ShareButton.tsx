import { useCallback, useEffect, useState } from "react";

import { Badge, Banner, Button, Dialog, Text } from "@cloudflare/kumo";

interface ShareStatus {
  enabled: boolean;
  lastPublished: { cid: string; rkey: string; at: string; scope: string } | null;
  atprotoConfigured: boolean;
}

interface SharePreview {
  lines: string[];
}

/**
 * Opt-in public sharing. The dialog lists EXACTLY what a publish sends
 * before the user confirms — same privacy model as `tokitoki share`.
 */
export function ShareButton(): React.ReactNode {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ShareStatus | null>(null);
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [scope, setScope] = useState<"week" | "month">("week");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    fetch("/api/share")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
    loadPreview("week", false);
  }, [open]);

  const loadPreview = useCallback((s: "week" | "month", repos: boolean) => {
    setPreview(null);
    fetch(`/api/share/preview?scope=${s}${repos ? "&include-repos=1" : ""}`)
      .then((r) => r.json())
      .then(setPreview)
      .catch(() => setPreview(null));
  }, []);

  const publish = (): void => {
    setBusy(true);
    setError(null);
    setResult(null);
    fetch("/api/share/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: true, scope, includeRepos: false }),
    })
      .then(async (r) => (await r.json()) as { ok?: boolean; error?: string; cid?: string })
      .then((body) => {
        if (body.error !== undefined) throw new Error(body.error);
        setResult(`published ✓ · cid ${body.cid ?? "?"}`);
        setStatus(null); // refetch on next open
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        title="share sanitized stats publicly (opt-in)"
      >
        {status?.enabled === true ? "◉ share" : "○ share"}
      </Button>
      <Dialog.Root
        open={open}
        onOpenChange={(nextOpen: boolean) => {
          setOpen(nextOpen);
          if (!nextOpen) {
            setResult(null);
            setError(null);
          }
        }}
      >
        <Dialog size="sm" className="p-6">
          <div className="mb-3 flex items-center justify-between gap-4">
            <Dialog.Title className="text-base font-semibold">Public sharing</Dialog.Title>
            <Badge tone={status?.enabled ? "success" : "neutral"}>
              {status?.enabled ? "enabled" : "disabled"}
            </Badge>
          </div>

          {status?.atprotoConfigured === false && (
            <Banner tone="warning" className="mb-3">
              no [sync] handle/app-password configured — add them to config to publish
            </Banner>
          )}

          {status?.lastPublished !== null && status?.lastPublished !== undefined && (
            <Text size="xs" tone="subtle" className="mb-3 block">
              last: dev.tokitoki.share/{status.lastPublished.rkey} · {status.lastPublished.at}
            </Text>
          )}

          <div className="mb-2 flex gap-2">
            {(["week", "month"] as const).map((s) => (
              <Button
                key={s}
                size="sm"
                variant={scope === s ? "primary" : "secondary"}
                onClick={() => {
                  setScope(s);
                  loadPreview(s, false);
                }}
              >
                {s}
              </Button>
            ))}
          </div>

          <div className="mb-3 rounded-lg bg-kumo-recessed p-3 text-xs">
            <p className="mb-1 font-medium">this will publish:</p>
            {(preview?.lines ?? ["…"]).map((line) => (
              <p key={line} className="text-kumo-subtle whitespace-pre-line">
                • {line}
              </p>
            ))}
          </div>

          {result !== null && (
            <Banner tone="success" className="mb-2">
              {result}
            </Banner>
          )}
          {error !== null && (
            <Banner tone="danger" className="mb-2">
              {error}
            </Banner>
          )}

          <div className="flex justify-end gap-2">
            <Dialog.Close render={(props) => <Button {...props} variant="secondary" size="sm" />}>
              close
            </Dialog.Close>
            <Button size="sm" variant="primary" disabled={busy || !status?.atprotoConfigured} onClick={publish}>
              {busy ? "publishing…" : "enable & publish"}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
}
