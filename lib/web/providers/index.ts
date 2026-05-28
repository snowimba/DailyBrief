import { dailyProvider } from "./daily-provider";
import { positionsProvider } from "../positions/provider";
import { stocksProvider } from "./stocks-provider";
import type { TabId, TabProvider } from "../types";

const PROVIDERS: TabProvider[] = [dailyProvider, stocksProvider, positionsProvider];

export function getProviders(): TabProvider[] {
  return PROVIDERS;
}

export function getProvider(id: string): TabProvider | undefined {
  return PROVIDERS.find((provider) => provider.id === (id as TabId));
}
