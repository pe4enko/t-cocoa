import { DateTime } from "luxon";
import * as TradingViewWs from "tradingview-ws";
import type { Candle } from "tradingview-ws";

import type { AppConfig } from "../config";
import {
  resolveForeignMarketCloseTarget,
  resolveNextForeignMarketOpen
} from "../domain/foreign-market-calendar";
import type { QuoteSnapshot } from "../domain/market";

export interface ExternalCocoaSnapshot {
  usdRub: QuoteSnapshot;
  worldClose: QuoteSnapshot;
  foreignCloseTarget: DateTime;
}

interface WorldCloseCacheEntry {
  snapshot: QuoteSnapshot;
  foreignCloseTarget: DateTime;
  validUntil: DateTime;
}

export class TradingViewService {
  private cachedWorldClose?: WorldCloseCacheEntry;

  constructor(private readonly config: AppConfig) {}

  async getUsdRubSnapshot(): Promise<QuoteSnapshot> {
    return this.fetchLatestSnapshot(this.config.usdRubSymbol);
  }

  async getWorldCloseSnapshot(): Promise<{
    worldClose: QuoteSnapshot;
    foreignCloseTarget: DateTime;
  }> {
    const nowMsk = DateTime.now().setZone(this.config.marketTimeZone);
    const foreignCloseTarget = this.resolveForeignCloseTarget(nowMsk);
    const cachedWorldClose = this.config.cache.worldCloseEnabled
      ? this.getCachedWorldClose(nowMsk, foreignCloseTarget)
      : null;

    if (cachedWorldClose) {
      return {
        worldClose: cachedWorldClose,
        foreignCloseTarget
      };
    }

    const [worldCloseCandles] = await this.fetchCandles([this.config.worldCocoaSymbol]);
    const worldClose = this.getSnapshotAtOrBefore(
      this.config.worldCocoaSymbol,
      worldCloseCandles,
      foreignCloseTarget
    );

    if (this.config.cache.worldCloseEnabled) {
      this.cachedWorldClose = {
        snapshot: worldClose,
        foreignCloseTarget,
        validUntil: this.resolveWorldCloseCacheUntil(nowMsk)
      };
    } else {
      this.cachedWorldClose = undefined;
    }

    return {
      worldClose,
      foreignCloseTarget
    };
  }

  async getExternalSnapshot(): Promise<ExternalCocoaSnapshot> {
    const [usdRub, worldCloseSnapshot] = await Promise.all([
      this.getUsdRubSnapshot(),
      this.getWorldCloseSnapshot()
    ]);

    return {
      usdRub,
      worldClose: worldCloseSnapshot.worldClose,
      foreignCloseTarget: worldCloseSnapshot.foreignCloseTarget
    };
  }

  private resolveForeignCloseTarget(nowMsk: DateTime): DateTime {
    return resolveForeignMarketCloseTarget(
      nowMsk,
      this.config.foreignCloseTimeMsk,
      this.config.foreignMarketHolidaysMsk
    );
  }

  private resolveWorldCloseCacheUntil(nowMsk: DateTime): DateTime {
    return resolveNextForeignMarketOpen(
      nowMsk,
      this.config.foreignOpenTimeMsk,
      this.config.foreignMarketHolidaysMsk
    );
  }

  private getCachedWorldClose(
    nowMsk: DateTime,
    foreignCloseTarget: DateTime
  ): QuoteSnapshot | null {
    if (!this.cachedWorldClose) {
      return null;
    }

    if (nowMsk.toMillis() >= this.cachedWorldClose.validUntil.toMillis()) {
      this.cachedWorldClose = undefined;
      return null;
    }

    if (
      this.cachedWorldClose.foreignCloseTarget.startOf("minute").toMillis() !==
      foreignCloseTarget.startOf("minute").toMillis()
    ) {
      return null;
    }

    return this.cachedWorldClose.snapshot;
  }

  private async fetchLatestSnapshot(symbol: string): Promise<QuoteSnapshot> {
    const [candles] = await this.fetchCandles([symbol]);
    return this.getLatestSnapshot(symbol, candles);
  }

  private async fetchCandles(
    symbols: string[]
  ): Promise<Array<Candle[] | undefined>> {
    let connection;
    try {
      connection = await TradingViewWs.connect(
        this.config.tradingViewSessionId
          ? { sessionId: this.config.tradingViewSessionId }
          : {}
      );
    } catch (error) {
      throw new Error(
        `Не удалось подключиться к TradingView. ${this.describeError(error)}.`
      );
    }

    try {
      try {
        return await TradingViewWs.getCandles({
          connection,
          symbols,
          amount: this.config.lookbackBars,
          timeframe: this.config.timeframeMinutes
        });
      } catch (error) {
        throw new Error(
          `Не удалось получить котировки из TradingView. ${this.describeError(error)}.`
        );
      }
    } finally {
      await connection.close();
    }
  }

  private getLatestSnapshot(symbol: string, candles: Candle[] | undefined): QuoteSnapshot {
    const normalizedCandles = this.normalizeCandles(symbol, candles);
    const candle = normalizedCandles.at(-1);
    if (!candle) {
      throw new Error(`TradingView returned no candles for ${symbol}.`);
    }

    return {
      symbol,
      displaySymbol: symbol,
      price: candle.close,
      observedAt: this.getCandleCloseTime(candle),
      sourceLabel: "TradingView"
    };
  }

  private getSnapshotAtOrBefore(
    symbol: string,
    candles: Candle[] | undefined,
    targetTime: DateTime
  ): QuoteSnapshot {
    const normalizedCandles = this.normalizeCandles(symbol, candles);
    const targetUnix = Math.floor(targetTime.toSeconds());
    const candle = [...normalizedCandles]
      .reverse()
      .find((item) => this.getCandleCloseUnix(item) <= targetUnix);

    if (!candle) {
      throw new Error(
        `Unable to find a candle for ${symbol} at or before ${targetTime.toISO()}.`
      );
    }

    return {
      symbol,
      displaySymbol: symbol,
      price: candle.close,
      observedAt: this.getCandleCloseTime(candle),
      sourceLabel: "TradingView"
    };
  }

  private normalizeCandles(symbol: string, candles: Candle[] | undefined): Candle[] {
    if (!candles || candles.length === 0) {
      throw new Error(`TradingView returned no candles for ${symbol}.`);
    }

    return [...candles].sort((left, right) => left.timestamp - right.timestamp);
  }

  private toMoscowTime(unixSeconds: number): DateTime {
    return DateTime.fromSeconds(unixSeconds, { zone: "utc" }).setZone(
      this.config.marketTimeZone
    );
  }

  private getCandleCloseTime(candle: Candle): DateTime {
    return this.toMoscowTime(this.getCandleCloseUnix(candle));
  }

  private getCandleCloseUnix(candle: Candle): number {
    return candle.timestamp + this.config.timeframeMinutes * 60;
  }

  private describeError(error: unknown): string {
    if (!(error instanceof Error)) {
      return "Неизвестная ошибка";
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
