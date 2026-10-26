/** Workspace credits are provider units, separate from money and earned resets. */
export function workspaceCreditsLabel(credits: { unlimited: boolean; balance?: string | null } | undefined): string {
  if (credits === undefined) return "";
  if (credits.unlimited) return "Unlimited workspace credits";
  return credits.balance == null ? "" : `Workspace credits ${credits.balance}`;
}
