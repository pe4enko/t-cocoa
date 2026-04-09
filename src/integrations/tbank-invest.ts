import { DateTime } from "luxon";

import type { AppConfig } from "../config";
import type { QuoteSnapshot } from "../domain/market";

interface TBankQuotation {
  units?: string | number;
  nano?: string | number;
}

interface TBankOrder {
  price?: TBankQuotation | null;
}

interface TBankOrderBookResponse {
  bids?: TBankOrder[];
  asks?: TBankOrder[];
  time?: string;
}

interface TBankLastPriceItem {
  price?: TBankQuotation | null;
  time?: string;
}

interface TBankLastPricesResponse {
  lastPrices?: TBankLastPriceItem[];
}

interface TBankFutureResponse {
  instrument?: {
    ticker?: string;
    classCode?: string;
    uid?: string;
    minPriceIncrement?: TBankQuotation | null;
    basicAssetSize?: TBankQuotation | null;
  };
}

interface TBankFuturesMarginResponse {
  minPriceIncrementAmount?: TBankQuotation | null;
}

interface TBankFutureMetadata {
  ticker: string;
  classCode: string;
  uid: string;
  minPriceIncrement: number;
  basicAssetSize: number;
}

interface PriceSelection {
  pointsPrice: number;
  observedAt: DateTime;
  sourceLabel: string;
}

export class TBankInvestService {
  private readonly metadataCache = new Map<string, TBankFutureMetadata>();

  constructor(private readonly config: AppConfig) {}

  isEnabled(): boolean {
    return this.config.liveQuotes.enabled && Boolean(this.config.liveQuotes.tbankApiToken);
  }

  async getLocalCocoaSnapshot(
    contract: QuoteSnapshot
  ): Promise<QuoteSnapshot> {
    return this.getFutureSnapshot({
      symbol: contract.symbol,
      displaySymbol: contract.displaySymbol,
      expiresAt: contract.expiresAt
    }, "orderbook");
  }

  async getUsdRubSnapshot(): Promise<QuoteSnapshot> {
    return this.getFutureSnapshot({
      symbol: this.config.liveQuotes.tbankUsdRubSymbol
    }, "last-price-only");
  }

  private async getFutureSnapshot(
    params: {
      symbol: string;
      displaySymbol?: string;
      expiresAt?: DateTime;
    },
    mode: "orderbook" | "last-price-only"
  ): Promise<QuoteSnapshot> {
    const symbol = params.symbol.trim().toUpperCase();
    const metadata = await this.getFutureMetadata(symbol);
    const priceSelection =
      mode === "orderbook"
        ? await this.getOrderBookPriceSelection(metadata)
        : await this.getLastPriceSelection(metadata, "T-Bank (last price)");
    const minPriceIncrementAmount = await this.getMinPriceIncrementAmount(metadata.uid);
    const price = this.convertPointsToMoney(
      priceSelection.pointsPrice,
      metadata.minPriceIncrement,
      minPriceIncrementAmount,
      metadata.basicAssetSize
    );

    return {
      symbol,
      displaySymbol: params.displaySymbol ?? symbol,
      price,
      observedAt: priceSelection.observedAt,
      sourceLabel: priceSelection.sourceLabel,
      expiresAt: params.expiresAt
    };
  }

  private async getOrderBookPriceSelection(
    metadata: TBankFutureMetadata
  ): Promise<PriceSelection> {
    const orderBook = await this.request<TBankOrderBookResponse>(
      "/tinkoff.public.invest.api.contract.v1.MarketDataService/GetOrderBook",
      {
        instrumentId: metadata.uid,
        depth: Math.max(1, Math.trunc(this.config.liveQuotes.tbankOrderbookDepth))
      }
    );

    const orderBookTime = this.parseObservedAt(orderBook.time);
    const bestBid = this.getQuotationNumber(orderBook.bids?.[0]?.price);
    const bestAsk = this.getQuotationNumber(orderBook.asks?.[0]?.price);

    if (bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk > 0) {
      return {
        pointsPrice: (bestBid + bestAsk) / 2,
        observedAt: orderBookTime,
        sourceLabel: "T-Bank (mid bid/ask)"
      };
    }

    if (bestBid !== null && bestBid > 0) {
      return {
        pointsPrice: bestBid,
        observedAt: orderBookTime,
        sourceLabel: "T-Bank (best bid)"
      };
    }

    if (bestAsk !== null && bestAsk > 0) {
      return {
        pointsPrice: bestAsk,
        observedAt: orderBookTime,
        sourceLabel: "T-Bank (best ask)"
      };
    }

    const lastPriceSelection = await this.getLastPriceSelection(
      metadata,
      "T-Bank (last price fallback)"
    );

    console.warn(
      `[T-Bank live quotes] ${metadata.ticker}: bid/ask unavailable, fallback to last price.`,
      {
        bestBid,
        bestAsk,
        orderBookTime: orderBook.time ?? null,
        lastPrice: lastPriceSelection.pointsPrice,
        lastPriceTime: lastPriceSelection.observedAt.toISO()
      }
    );

    return lastPriceSelection;
  }

  private async getLastPriceSelection(
    metadata: TBankFutureMetadata,
    sourceLabel: string
  ): Promise<PriceSelection> {
    const lastPrices = await this.request<TBankLastPricesResponse>(
      "/tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices",
      {
        instrumentId: [metadata.uid]
      }
    );
    const lastPriceItem = lastPrices.lastPrices?.[0];
    const lastPrice = this.getQuotationNumber(lastPriceItem?.price);

    if (lastPrice === null) {
      throw new Error(`T-Bank did not return a usable price for ${metadata.ticker}.`);
    }

    return {
      pointsPrice: lastPrice,
      observedAt: this.parseObservedAt(lastPriceItem?.time),
      sourceLabel
    };
  }

  private async getFutureMetadata(symbol: string): Promise<TBankFutureMetadata> {
    const cached = this.metadataCache.get(symbol);
    if (cached) {
      return cached;
    }

    const response = await this.request<TBankFutureResponse>(
      "/tinkoff.public.invest.api.contract.v1.InstrumentsService/FutureBy",
      {
        idType: "INSTRUMENT_ID_TYPE_TICKER",
        id: symbol,
        classCode: this.config.liveQuotes.tbankFuturesClassCode
      }
    );

    const instrument = response.instrument;
    const uid = instrument?.uid?.trim();
    const ticker = instrument?.ticker?.trim().toUpperCase();
    const classCode = instrument?.classCode?.trim().toUpperCase();
    const minPriceIncrement = this.getQuotationNumber(instrument?.minPriceIncrement);
    const basicAssetSize = this.getQuotationNumber(instrument?.basicAssetSize);

    if (
      !uid ||
      !ticker ||
      !classCode ||
      minPriceIncrement === null ||
      minPriceIncrement <= 0 ||
      basicAssetSize === null ||
      basicAssetSize <= 0
    ) {
      throw new Error(`T-Bank did not return complete metadata for ${symbol}.`);
    }

    const metadata: TBankFutureMetadata = {
      ticker,
      classCode,
      uid,
      minPriceIncrement,
      basicAssetSize
    };

    this.metadataCache.set(symbol, metadata);
    return metadata;
  }

  private async getMinPriceIncrementAmount(instrumentId: string): Promise<number> {
    const response = await this.request<TBankFuturesMarginResponse>(
      "/tinkoff.public.invest.api.contract.v1.InstrumentsService/GetFuturesMargin",
      {
        instrumentId
      }
    );

    const value = this.getQuotationNumber(response.minPriceIncrementAmount);
    if (value === null || value <= 0) {
      throw new Error(
        `T-Bank did not return minPriceIncrementAmount for ${instrumentId}.`
      );
    }

    return value;
  }

  private convertPointsToMoney(
    priceInPoints: number,
    minPriceIncrement: number,
    minPriceIncrementAmount: number,
    basicAssetSize: number
  ): number {
    const contractValue =
      (priceInPoints / minPriceIncrement) * minPriceIncrementAmount;

    return contractValue / basicAssetSize;
  }

  private async request<TResponse>(
    path: string,
    body: Record<string, unknown>
  ): Promise<TResponse> {
    const token = this.config.liveQuotes.tbankApiToken;
    if (!token) {
      throw new Error("TBANK_API_TOKEN is not configured.");
    }

    const baseUrl = this.config.liveQuotes.tbankApiBaseUrl.endsWith("/")
      ? this.config.liveQuotes.tbankApiBaseUrl
      : `${this.config.liveQuotes.tbankApiBaseUrl}/`;
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    const url = new URL(normalizedPath, baseUrl);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json"
        },
        body: JSON.stringify(body)
      });
    } catch (error) {
      throw new Error(
        `Не удалось получить данные T-Bank Invest API с ${url.host}. ${this.describeFetchError(error)}.`
      );
    }

    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `T-Bank Invest API request failed with status ${response.status}: ${details.slice(0, 200)}`
      );
    }

    return (await response.json()) as TResponse;
  }

  private getQuotationNumber(value?: TBankQuotation | null): number | null {
    if (!value) {
      return null;
    }

    const units = Number(value.units ?? 0);
    const nano = Number(value.nano ?? 0);

    if (Number.isNaN(units) || Number.isNaN(nano)) {
      return null;
    }

    return units + nano / 1_000_000_000;
  }

  private parseObservedAt(value?: string): DateTime {
    if (value) {
      const parsed = DateTime.fromISO(value, { zone: "utc" }).setZone(
        this.config.marketTimeZone
      );
      if (parsed.isValid) {
        return parsed;
      }
    }

    return DateTime.now().setZone(this.config.marketTimeZone);
  }

  private describeFetchError(error: unknown): string {
    if (!(error instanceof Error)) {
      return "Неизвестная ошибка сети";
    }

    const causeMessage =
      error.cause instanceof Error
        ? error.cause.message
        : typeof error.cause === "string"
          ? error.cause
          : null;

    return causeMessage ? `${error.message} (${causeMessage})` : error.message;
  }
}
