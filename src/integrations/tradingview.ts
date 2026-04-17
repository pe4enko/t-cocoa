import { DateTime } from "luxon";
import * as TradingViewWs from "tradingview-ws";
import type { Candle } from "tradingview-ws";

import type { AppConfig } from "../config";
import {
  normalizeTradingViewCocoaSymbol,
  resolveIceUsCocoaSymbolForExpiry
} from "../domain/ice-cocoa-symbol";
import { resolveNextForeignMarketOpen } from "../domain/foreign-market-calendar";
import type { QuoteSnapshot } from "../domain/market";
import type { IceCocoaHoursService } from "./ice-cocoa-hours";

export interface ExternalCocoaSnapshot {
  usdRub: QuoteSnapshot;
  worldClose: QuoteSnapshot;
  foreignCloseTarget: DateTime;
}

interface WorldCloseCacheEntry {
  snapshot: QuoteSnapshot;
  symbol: string;
  foreignCloseTarget: DateTime;
  validUntil: DateTime;
}

interface WorldCloseRequest {
  localContract?: Pick<QuoteSnapshot, "symbol" | "expiresAt">;
  worldSymbolOverride?: string;
}

interface ResolvedWorldSymbol {
  symbol: string;
  resolutionSourceLabel: string;
}

interface IceCocoaExpiryEntry {
  contractLabel: string;
  tradingViewSymbol: string;
  finalSettlementDate: DateTime;
  lastTradeDate?: DateTime;
}

interface IceCocoaExpiryCacheEntry {
  entries: IceCocoaExpiryEntry[];
  validUntil: DateTime;
}

const ICE_COCOA_EXPIRY_CSV_URL = "https://www.ice.com/api/productguide/spec/7/expiry/csv";

export class TradingViewService {
  private cachedWorldClose?: WorldCloseCacheEntry;
  private cachedIceCocoaExpiry?: IceCocoaExpiryCacheEntry;

  constructor(
    private readonly config: AppConfig,
    private readonly iceCocoaHoursService: IceCocoaHoursService
  ) {}

  clearCache(): void {
    this.cachedWorldClose = undefined;
    this.cachedIceCocoaExpiry = undefined;
  }

  async getUsdRubSnapshot(): Promise<QuoteSnapshot> {
    return this.fetchLatestSnapshot(this.config.usdRubSymbol);
  }

  async getWorldCloseSnapshot(request: WorldCloseRequest = {}): Promise<{
    worldClose: QuoteSnapshot;
    foreignCloseTarget: DateTime;
  }> {
    const nowMsk = DateTime.now().setZone(this.config.marketTimeZone);
    const foreignCloseTarget = await this.resolveForeignCloseTarget(nowMsk);
    const resolvedWorldSymbol = await this.resolveWorldCocoaSymbol(request);
    const worldSymbol = resolvedWorldSymbol.symbol;
    const cachedWorldClose = this.config.cache.worldCloseEnabled
      ? this.getCachedWorldClose(nowMsk, foreignCloseTarget, worldSymbol)
      : null;

    if (cachedWorldClose) {
      return {
        worldClose: {
          ...cachedWorldClose,
          resolutionSourceLabel: resolvedWorldSymbol.resolutionSourceLabel
        },
        foreignCloseTarget
      };
    }

    const [worldCloseCandles] = await this.fetchCandles([worldSymbol]);
    const worldClose = this.getSnapshotAtOrBefore(
      worldSymbol,
      worldCloseCandles,
      foreignCloseTarget
    );
    worldClose.resolutionSourceLabel = resolvedWorldSymbol.resolutionSourceLabel;

    if (
      this.config.cache.worldCloseEnabled &&
      this.isFinalWorldClose(worldClose, foreignCloseTarget)
    ) {
      this.cachedWorldClose = {
        snapshot: worldClose,
        symbol: worldSymbol,
        foreignCloseTarget,
        validUntil: await this.resolveWorldCloseCacheUntil(nowMsk)
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

  private async resolveForeignCloseTarget(nowMsk: DateTime): Promise<DateTime> {
    let session = await this.iceCocoaHoursService.buildSession(nowMsk);

    if (nowMsk < session.marketCloseTime) {
      session = await this.iceCocoaHoursService.buildSession(nowMsk.minus({ days: 1 }));
    }

    while (!this.isTradingDay(session.marketCloseTime)) {
      session = await this.iceCocoaHoursService.buildSession(
        session.marketCloseTime.minus({ days: 1 })
      );
    }

    return session.marketCloseTime;
  }

  private async resolveWorldCloseCacheUntil(nowMsk: DateTime): Promise<DateTime> {
    let nextOpenCandidate = nowMsk.plus({ days: 1 });

    while (!this.isTradingDay(nextOpenCandidate)) {
      nextOpenCandidate = nextOpenCandidate.plus({ days: 1 });
    }

    const nextSession = await this.iceCocoaHoursService.buildSession(nextOpenCandidate);
    return nextSession.marketOpenTime;
  }

  private isFinalWorldClose(
    snapshot: QuoteSnapshot,
    foreignCloseTarget: DateTime
  ): boolean {
    return (
      snapshot.observedAt.startOf("minute").toMillis() >=
      foreignCloseTarget.startOf("minute").toMillis()
    );
  }

  private getCachedWorldClose(
    nowMsk: DateTime,
    foreignCloseTarget: DateTime,
    symbol: string
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

    if (this.cachedWorldClose.symbol !== symbol) {
      return null;
    }

    return this.cachedWorldClose.snapshot;
  }

  private isTradingDay(value: DateTime): boolean {
    return (
      value.weekday <= 5 &&
      !this.config.foreignMarketHolidaysMsk.has(value.toISODate() ?? "")
    );
  }

  private async resolveWorldCocoaSymbol(
    request: WorldCloseRequest
  ): Promise<ResolvedWorldSymbol> {
    const explicitSymbol =
      request.worldSymbolOverride?.trim() ||
      this.config.worldCocoaSymbolOverride?.trim();

    if (explicitSymbol) {
      return {
        symbol: normalizeTradingViewCocoaSymbol(explicitSymbol),
        resolutionSourceLabel: "ручной override"
      };
    }

    if (request.localContract?.expiresAt?.isValid) {
      try {
        const officialSymbol = await this.resolveIceUsCocoaSymbolByOfficialExpiry(
          request.localContract.expiresAt
        );

        if (officialSymbol) {
          return {
            symbol: officialSymbol,
            resolutionSourceLabel: "официальный ICE expiry calendar"
          };
        }
      } catch (error) {
        console.warn(
          "[ICE cocoa expiry] Falling back from official ICE expiry source.",
          error
        );
      }
    }

    const configuredFallbackSymbol = this.resolveIceUsCocoaSymbolByConfiguredFallback(
      request.localContract?.expiresAt
    );

    if (configuredFallbackSymbol) {
      return {
        symbol: configuredFallbackSymbol,
        resolutionSourceLabel: "env fallback таблица ICE"
      };
    }

    return {
      symbol: resolveIceUsCocoaSymbolForExpiry(
        request.localContract?.expiresAt,
        this.config.worldCocoaContinuousSymbol
      ),
      resolutionSourceLabel: "месячный fallback"
    };
  }

  private async resolveIceUsCocoaSymbolByOfficialExpiry(
    localExpiry: DateTime
  ): Promise<string | null> {
    const entries = await this.getIceCocoaExpiryEntries();
    const targetMillis = localExpiry.startOf("day").toMillis();
    const match = entries
      .filter((entry) => entry.finalSettlementDate.toMillis() >= targetMillis)
      .sort(
        (left, right) =>
          left.finalSettlementDate.toMillis() - right.finalSettlementDate.toMillis()
      )[0];

    return match?.tradingViewSymbol ?? null;
  }

  private async getIceCocoaExpiryEntries(): Promise<IceCocoaExpiryEntry[]> {
    const nowMsk = DateTime.now().setZone(this.config.marketTimeZone);

    if (
      this.config.cache.iceCocoaExpiryEnabled &&
      this.cachedIceCocoaExpiry &&
      nowMsk.toMillis() < this.cachedIceCocoaExpiry.validUntil.toMillis()
    ) {
      return this.cachedIceCocoaExpiry.entries;
    }

    try {
      const response = await this.fetchIceCocoaExpiryCsv();
      const entries = this.parseIceCocoaExpiryCsv(response);

      if (this.config.cache.iceCocoaExpiryEnabled) {
        this.cachedIceCocoaExpiry = {
          entries,
          validUntil: nowMsk.endOf("day")
        };
      } else {
        this.cachedIceCocoaExpiry = undefined;
      }

      return entries;
    } catch (error) {
      throw error;
    }
  }

  private async fetchIceCocoaExpiryCsv(): Promise<string> {
    let response: Response;

    try {
      response = await fetch(ICE_COCOA_EXPIRY_CSV_URL);
    } catch (error) {
      throw new Error(
        `Не удалось получить календарь экспираций ICE с ${new URL(ICE_COCOA_EXPIRY_CSV_URL).host}. ${this.describeError(error)}.`
      );
    }

    if (!response.ok) {
      throw new Error(
        `ICE expiry calendar request failed with status ${response.status}.`
      );
    }

    return response.text();
  }

  private parseIceCocoaExpiryCsv(csv: string): IceCocoaExpiryEntry[] {
    const rows = csv
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => this.parseCsvLine(line));

    if (rows.length <= 1) {
      throw new Error("ICE expiry calendar returned no rows.");
    }

    const header = rows[0].map((value) => value.toUpperCase());
    const contractIndex = header.indexOf("CONTRACT SYMBOL");
    const ltdIndex = header.indexOf("LTD");
    const fsdIndex = header.indexOf("FSD");

    if (contractIndex === -1 || fsdIndex === -1) {
      throw new Error("ICE expiry calendar CSV format is not recognized.");
    }

    const entries: Array<IceCocoaExpiryEntry | null> = rows
      .slice(1)
      .map((row): IceCocoaExpiryEntry | null => {
        const contractLabel = this.normalizeIceContractLabel(row[contractIndex]);
        const finalSettlementDate = this.parseUsDate(row[fsdIndex]);
        const lastTradeDate =
          ltdIndex === -1 ? undefined : this.parseUsDate(row[ltdIndex]);

        if (!contractLabel || !finalSettlementDate?.isValid) {
          return null;
        }

        const tradingViewSymbol =
          this.toIceTradingViewSymbolFromContractLabel(contractLabel);

        if (!tradingViewSymbol) {
          return null;
        }

        return {
          contractLabel,
          tradingViewSymbol,
          finalSettlementDate,
          lastTradeDate: lastTradeDate?.isValid ? lastTradeDate : undefined
        };
      });

    return entries.filter((entry): entry is IceCocoaExpiryEntry => entry !== null);
  }

  private getConfiguredIceCocoaExpiryEntries(): IceCocoaExpiryEntry[] {
    return this.config.iceCocoaExpiryFallbackEntries
      .map((entry) => {
        const finalSettlementDate = DateTime.fromISO(entry.finalSettlementDate, {
          zone: this.config.marketTimeZone
        });

        if (!finalSettlementDate.isValid) {
          return null;
        }

        return {
          contractLabel: entry.contractLabel,
          tradingViewSymbol: entry.tradingViewSymbol,
          finalSettlementDate
        } satisfies IceCocoaExpiryEntry;
      })
      .filter((entry): entry is IceCocoaExpiryEntry => entry !== null);
  }

  private resolveIceUsCocoaSymbolByConfiguredFallback(
    localExpiry: DateTime | undefined
  ): string | null {
    if (!localExpiry?.isValid) {
      return null;
    }

    const entries = this.getConfiguredIceCocoaExpiryEntries();
    const targetMillis = localExpiry.startOf("day").toMillis();
    const match = entries
      .filter((entry) => entry.finalSettlementDate.toMillis() >= targetMillis)
      .sort(
        (left, right) =>
          left.finalSettlementDate.toMillis() - right.finalSettlementDate.toMillis()
      )[0];

    return match?.tradingViewSymbol ?? null;
  }

  private parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];

      if (char === "\"") {
        const nextChar = line[index + 1];
        if (inQuotes && nextChar === "\"") {
          current += "\"";
          index += 1;
          continue;
        }

        inQuotes = !inQuotes;
        continue;
      }

      if (char === "," && !inQuotes) {
        values.push(current);
        current = "";
        continue;
      }

      current += char;
    }

    values.push(current);
    return values.map((value) => value.trim());
  }

  private normalizeIceContractLabel(value: string | undefined): string | null {
    if (!value) {
      return null;
    }

    const normalized = value
      .trim()
      .replace(/^="/, "")
      .replace(/"$/, "")
      .replace(/^=/, "")
      .replaceAll("\"", "");

    return normalized || null;
  }

  private parseUsDate(value: string | undefined): DateTime | undefined {
    if (!value) {
      return undefined;
    }

    const parsed = DateTime.fromFormat(value.trim(), "MM/dd/yyyy", {
      zone: this.config.marketTimeZone
    });

    return parsed.isValid ? parsed : undefined;
  }

  private toIceTradingViewSymbolFromContractLabel(
    contractLabel: string
  ): string | null {
    const match = contractLabel.match(/^([A-Za-z]{3})(\d{2})$/);
    if (!match) {
      return null;
    }

    const monthCodeByName: Record<string, string> = {
      MAR: "H",
      MAY: "K",
      JUL: "N",
      SEP: "U",
      DEC: "Z"
    };

    const monthCode = monthCodeByName[match[1].toUpperCase()];
    if (!monthCode) {
      return null;
    }

    const year = 2000 + Number(match[2]);
    return `ICEUS:CC${monthCode}${year}`;
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
