import type { DateTime } from "luxon";

export interface QuoteSnapshot {
  symbol: string;
  displaySymbol: string;
  price: number;
  observedAt: DateTime;
  sourceLabel: string;
  expiresAt?: DateTime;
}

export interface CocoaMarketSnapshot {
  localCocoa: QuoteSnapshot;
  usdRub: QuoteSnapshot;
  worldClose: QuoteSnapshot;
  foreignCloseTarget: DateTime;
}
