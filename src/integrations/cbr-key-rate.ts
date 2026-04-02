import { DateTime } from "luxon";

import type { AppConfig } from "../config";

export interface KeyRateSnapshot {
  ratePct: number;
  publishedAt: DateTime;
  sourceLabel: string;
}

export class CbrKeyRateService {
  private cachedSnapshot?: KeyRateSnapshot;
  private cachedUntilMillis?: number;

  constructor(private readonly config: AppConfig) {}

  async getCurrentKeyRate(): Promise<KeyRateSnapshot> {
    const now = DateTime.now().setZone(this.config.marketTimeZone);

    if (!this.config.cache.cbrKeyRateEnabled) {
      this.cachedSnapshot = undefined;
      this.cachedUntilMillis = undefined;
      return this.fetchCurrentKeyRate();
    }

    if (
      this.cachedSnapshot &&
      this.cachedUntilMillis !== undefined &&
      now.toMillis() <= this.cachedUntilMillis
    ) {
      return this.cachedSnapshot;
    }

    const snapshot = await this.fetchCurrentKeyRate();

    this.cachedSnapshot = snapshot;
    this.cachedUntilMillis = now.endOf("day").toMillis();

    return snapshot;
  }

  private async fetchCurrentKeyRate(): Promise<KeyRateSnapshot> {
    const response = await fetch(this.config.fairBasis.cbrKeyRateUrl);
    if (!response.ok) {
      throw new Error(
        `Не удалось получить ключевую ставку ЦБ РФ: HTTP ${response.status}.`
      );
    }

    const html = await response.text();
    const snapshot = this.parseKeyRateHtml(html);

    return snapshot;
  }

  private parseKeyRateHtml(html: string): KeyRateSnapshot {
    const normalizedText = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();

    const headerIndex = this.findTableHeaderIndex(normalizedText);
    if (headerIndex === -1) {
      throw new Error(
        "Не удалось разобрать страницу ЦБ РФ со ставкой: не найдена таблица значений."
      );
    }

    const tableText = normalizedText.slice(headerIndex);
    const match = tableText.match(
      /(\d{2}\.\d{2}\.\d{4})\s+(\d{1,2}(?:[.,]\d+)?)/u
    );

    if (!match) {
      throw new Error(
        "Не удалось разобрать страницу ЦБ РФ со ставкой: не найдены дата и значение."
      );
    }

    const publishedAt = DateTime.fromFormat(match[1], "dd.MM.yyyy", {
      zone: this.config.marketTimeZone
    }).startOf("day");
    if (!publishedAt.isValid) {
      throw new Error(
        "Не удалось разобрать дату публикации ключевой ставки ЦБ РФ."
      );
    }

    const ratePct = Number(match[2].replace(",", "."));
    if (Number.isNaN(ratePct)) {
      throw new Error("Не удалось разобрать значение ключевой ставки ЦБ РФ.");
    }

    return {
      ratePct,
      publishedAt,
      sourceLabel: "ЦБ РФ"
    };
  }

  private findTableHeaderIndex(text: string): number {
    const headers = ["Date Rate", "Дата Ставка"];

    for (const header of headers) {
      const index = text.indexOf(header);
      if (index !== -1) {
        return index + header.length;
      }
    }

    return -1;
  }
}
