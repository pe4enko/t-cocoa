import { DateTime } from "luxon";

import type { AppConfig } from "../config";
import type { QuoteSnapshot } from "../domain/market";

interface MoexBlock {
  columns?: string[];
  data?: unknown[][];
}

interface MoexFuturesResponse {
  securities?: MoexBlock;
  marketdata?: MoexBlock;
}

interface MoexContractDescriptor {
  symbol: string;
  displaySymbol: string;
  assetCode: string;
  expiresAt: DateTime;
}

export class MoexIssService {
  constructor(private readonly config: AppConfig) {}

  async getLocalCocoaSnapshot(symbolOverride?: string): Promise<QuoteSnapshot> {
    const contract = symbolOverride?.trim()
      ? await this.getContractBySymbol(symbolOverride)
      : await this.getActiveContractByAssetCode(this.config.ruCocoaAssetCode);

    const symbol = contract.symbol;
    const url = new URL(
      `/iss/engines/futures/markets/forts/securities/${encodeURIComponent(symbol)}.json`,
      this.config.moexIssBaseUrl
    );

    url.searchParams.set("iss.meta", "off");
    url.searchParams.set("iss.only", "securities,marketdata");
    url.searchParams.set("securities.columns", "SECID,SHORTNAME");
    url.searchParams.set(
      "marketdata.columns",
      "SECID,LAST,MARKETPRICE,SETTLEPRICE,UPDATETIME,SYSTIME,TRADEDATE,TRADE_SESSION_DATE"
    );

    const response = await this.fetchMoex(url);
    if (!response.ok) {
      throw new Error(`MOEX ISS request failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as MoexFuturesResponse;
    const marketRow = this.getFirstRow(payload.marketdata, symbol);

    const price = this.pickFirstNumber(marketRow, [
      "LAST",
      "MARKETPRICE",
      "SETTLEPRICE"
    ]);

    if (price === null) {
      throw new Error(`MOEX ISS did not return a price for ${symbol}.`);
    }

    return {
      symbol,
      displaySymbol: contract.displaySymbol,
      price,
      observedAt: this.resolveObservedAt(marketRow),
      sourceLabel: "MOEX ISS",
      expiresAt: contract.expiresAt
    };
  }

  private async getActiveContractByAssetCode(
    assetCode: string
  ): Promise<MoexContractDescriptor> {
    const url = new URL(
      "/iss/engines/futures/markets/forts/securities.json",
      this.config.moexIssBaseUrl
    );

    url.searchParams.set("iss.meta", "off");
    url.searchParams.set("iss.only", "securities");
    url.searchParams.set(
      "securities.columns",
      "SECID,SHORTNAME,ASSETCODE,LASTTRADEDATE,LASTDELDATE"
    );
    url.searchParams.set("limit", "1000");

    const response = await this.fetchMoex(url);
    if (!response.ok) {
      throw new Error(`MOEX ISS request failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as MoexFuturesResponse;
    const rows = this.getRows(payload.securities);
    const now = DateTime.now().setZone(this.config.marketTimeZone);

    const candidates = rows
      .map((row) => this.toContractDescriptor(row))
      .filter(
        (contract): contract is MoexContractDescriptor =>
          contract !== null &&
          contract.assetCode === assetCode.toUpperCase() &&
          contract.expiresAt.endOf("day") >= now
      )
      .sort((left, right) => left.expiresAt.toMillis() - right.expiresAt.toMillis());

    const contract = candidates[0];
    if (!contract) {
      throw new Error(
        `MOEX ISS did not return an active futures contract for asset code ${assetCode}.`
      );
    }

    return contract;
  }

  private async getContractBySymbol(symbol: string): Promise<MoexContractDescriptor> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const url = new URL(
      `/iss/engines/futures/markets/forts/securities/${encodeURIComponent(normalizedSymbol)}.json`,
      this.config.moexIssBaseUrl
    );

    url.searchParams.set("iss.meta", "off");
    url.searchParams.set("iss.only", "securities");
    url.searchParams.set(
      "securities.columns",
      "SECID,SHORTNAME,ASSETCODE,LASTTRADEDATE,LASTDELDATE"
    );

    const response = await this.fetchMoex(url);
    if (!response.ok) {
      throw new Error(`MOEX ISS request failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as MoexFuturesResponse;
    const row = this.getFirstRow(payload.securities, normalizedSymbol);
    const contract = this.toContractDescriptor(row);

    if (!contract) {
      throw new Error(`MOEX ISS did not return contract metadata for ${normalizedSymbol}.`);
    }

    return contract;
  }

  private resolveObservedAt(row: Record<string, unknown>): DateTime {
    const tradeDate =
      this.getString(row, "TRADEDATE") ?? this.getString(row, "TRADE_SESSION_DATE");
    const updateTime = this.getString(row, "UPDATETIME");

    if (tradeDate && updateTime) {
      const observedAt = DateTime.fromFormat(
        `${tradeDate} ${updateTime}`,
        "yyyy-MM-dd HH:mm:ss",
        {
          zone: this.config.marketTimeZone
        }
      );

      if (observedAt.isValid) {
        return observedAt;
      }
    }

    const systemTime = this.getString(row, "SYSTIME");
    if (systemTime) {
      const observedAt = DateTime.fromFormat(systemTime, "yyyy-MM-dd HH:mm:ss", {
        zone: this.config.marketTimeZone
      });

      if (observedAt.isValid) {
        return observedAt;
      }
    }

    return DateTime.now().setZone(this.config.marketTimeZone);
  }

  private getFirstRow(block: MoexBlock | undefined, symbol: string): Record<string, unknown> {
    const row = this.getRows(block)[0];

    if (!row) {
      throw new Error(`MOEX ISS returned no data for ${symbol}.`);
    }

    return row;
  }

  private getRows(block: MoexBlock | undefined): Record<string, unknown>[] {
    const columns = block?.columns;
    const data = block?.data;

    if (!columns || !data) {
      return [];
    }

    return data.map((row) =>
      Object.fromEntries(columns.map((column, index) => [column, row[index]]))
    );
  }

  private toContractDescriptor(
    row: Record<string, unknown>
  ): MoexContractDescriptor | null {
    const symbol = this.getString(row, "SECID");
    const displaySymbol = this.getString(row, "SHORTNAME");
    const assetCode = this.getString(row, "ASSETCODE");
    const expiryRaw =
      this.getString(row, "LASTTRADEDATE") ?? this.getString(row, "LASTDELDATE");

    if (!symbol || !displaySymbol || !assetCode || !expiryRaw) {
      return null;
    }

    const expiresAt = DateTime.fromFormat(expiryRaw, "yyyy-MM-dd", {
      zone: this.config.marketTimeZone
    });

    if (!expiresAt.isValid) {
      return null;
    }

    return {
      symbol,
      displaySymbol,
      assetCode,
      expiresAt
    };
  }

  private getString(row: Record<string, unknown>, field: string): string | null {
    const value = row[field];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private pickFirstNumber(
    row: Record<string, unknown>,
    fields: string[]
  ): number | null {
    for (const field of fields) {
      const value = row[field];
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }

    return null;
  }

  private async fetchMoex(url: URL): Promise<Response> {
    try {
      return await fetch(url);
    } catch (error) {
      throw new Error(
        `Не удалось получить данные MOEX ISS с ${url.host}. ${this.describeFetchError(error)}.`
      );
    }
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
