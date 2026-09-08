export const WIDGET_STATUS_SCHEMA = 1;

export interface WidgetStatusWindow {
  since: string;
  until: string | null;
  label: string;
}

export interface WidgetStatusStats {
  costUsd: number;
  requests: number;
  sessions: number;
  tokens: number;
  cachePct: number;
}

export interface WidgetStatusProvider {
  id: string;
  costUsd: number;
  requests: number;
  sessions: number;
  tokens: number;
}

export interface WidgetStatusBudget {
  scope: string;
  label: string;
  ratio: number;
  state: "ok" | "warn" | "exceeded";
  used: number;
  cap: number;
  daysLeft: number;
}

export interface WidgetStatusPayload {
  schema: typeof WIDGET_STATUS_SCHEMA;
  app: "tokitoki";
  generatedAt: string;
  window: WidgetStatusWindow;
  stats: WidgetStatusStats;
  providers: WidgetStatusProvider[];
  budgets: WidgetStatusBudget[];
}
