export type TabId = "daily" | "stocks" | "positions";

export interface RefreshResult {
  tabId: TabId;
  date: string;
  ok: true;
  refreshedAt: string;
  title: string;
  html: string;
  summary?: string;
  sourceFiles?: string[];
  meta?: Record<string, unknown>;
}

export interface TabProvider {
  id: TabId;
  label: string;
  description: string;
  refreshLabel: string;
  loadLatest(): Promise<RefreshResult | null>;
  loadDate?(date: string): Promise<RefreshResult | null>;
  listDates?(): Promise<string[]>;
  refresh(): Promise<RefreshResult>;
}
