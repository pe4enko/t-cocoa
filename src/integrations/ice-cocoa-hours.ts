import { DateTime } from "luxon";

import type { AppConfig } from "../config";

interface IceCocoaHoursCacheEntry {
  openHour: number;
  openMinute: number;
  closeHour: number;
  closeMinute: number;
  validUntil: DateTime;
  sourceLabel: string;
}

export interface IceCocoaSession {
  marketOpenTime: DateTime;
  marketCloseTime: DateTime;
  sourceLabel: string;
}

const ICE_COCOA_HOURS_URL = "https://www.ice.com/products/7/Cocoa-Futures";
const ICE_COCOA_NEW_YORK_TIME_ZONE = "America/New_York";

export class IceCocoaHoursService {
  private cachedHours?: IceCocoaHoursCacheEntry;

  constructor(private readonly config: AppConfig) {}

  clearCache(): void {
    this.cachedHours = undefined;
  }

  async buildSession(nowMsk: DateTime): Promise<IceCocoaSession> {
    let hours: IceCocoaHoursCacheEntry;

    try {
      hours = await this.getHoursSnapshot(nowMsk);
    } catch (error) {
      console.warn(
        "[ICE cocoa hours] Falling back to manual Moscow trading hours from .env.",
        error
      );

      return {
        marketOpenTime: nowMsk.set({
          hour: this.config.foreignOpenTimeMsk.hour,
          minute: this.config.foreignOpenTimeMsk.minute,
          second: 0,
          millisecond: 0
        }),
        marketCloseTime: nowMsk.set({
          hour: this.config.foreignCloseTimeMsk.hour,
          minute: this.config.foreignCloseTimeMsk.minute,
          second: 0,
          millisecond: 0
        }),
        sourceLabel: "ручной fallback из .env"
      };
    }

    const nowNy = nowMsk.setZone(ICE_COCOA_NEW_YORK_TIME_ZONE);

    const marketOpenTime = nowNy
      .set({
        hour: hours.openHour,
        minute: hours.openMinute,
        second: 0,
        millisecond: 0
      })
      .setZone(this.config.marketTimeZone);

    const marketCloseTime = nowNy
      .set({
        hour: hours.closeHour,
        minute: hours.closeMinute,
        second: 0,
        millisecond: 0
      })
      .setZone(this.config.marketTimeZone);

    return {
      marketOpenTime,
      marketCloseTime,
      sourceLabel: hours.sourceLabel
    };
  }

  private async getHoursSnapshot(nowMsk: DateTime): Promise<IceCocoaHoursCacheEntry> {
    if (
      this.cachedHours &&
      nowMsk.toMillis() < this.cachedHours.validUntil.toMillis()
    ) {
      return this.cachedHours;
    }

    const html = await this.fetchHoursPage();
    const parsed = this.parseNewYorkTradingHours(html, nowMsk);
    this.cachedHours = parsed;
    return parsed;
  }

  private async fetchHoursPage(): Promise<string> {
    let response: Response;

    try {
      response = await fetch(ICE_COCOA_HOURS_URL);
    } catch (error) {
      throw new Error(
        `Не удалось получить страницу торговых часов ICE с ${new URL(ICE_COCOA_HOURS_URL).host}. ${this.describeError(error)}.`
      );
    }

    if (!response.ok) {
      throw new Error(
        `ICE trading hours request failed with status ${response.status}.`
      );
    }

    return response.text();
  }

  private parseNewYorkTradingHours(
    html: string,
    nowMsk: DateTime
  ): IceCocoaHoursCacheEntry {
    const match = html.match(
      /<tr[^>]*data-city="NEW YORK"[\s\S]*?<div>(\d{1,2}:\d{2})\s*AM\s*-\s*(\d{1,2}:\d{2})\s*PM<\/div>[\s\S]*?<div>(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})<\/div>/i
    );

    if (!match) {
      throw new Error("Не удалось распарсить trading hours для NEW YORK на странице ICE.");
    }

    const [openHour, openMinute] = match[3].split(":").map((value) => Number(value));
    const [closeHour, closeMinute] = match[4].split(":").map((value) => Number(value));

    if (
      [openHour, openMinute, closeHour, closeMinute].some((value) =>
        Number.isNaN(value)
      )
    ) {
      throw new Error("ICE trading hours contain invalid numeric values.");
    }

    return {
      openHour,
      openMinute,
      closeHour,
      closeMinute,
      validUntil: nowMsk.plus({ days: 1 }),
      sourceLabel: "официальная страница ICE trading hours"
    };
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
