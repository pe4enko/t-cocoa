import { DateTime } from "luxon";

import type { SignalThresholds } from "../config";
import type {
  CocoaReport,
  FairBasisResult
} from "../services/cocoa-report";

const numberFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

export function formatDecimal(value: number): string {
  return numberFormatter.format(value);
}

export function formatSignedDecimal(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatDecimal(Math.abs(value))}`;
}

export function formatSignedPercent(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatDecimal(Math.abs(value))}%`;
}

export function formatDateTime(value: DateTime): string {
  return value.toFormat("dd.MM.yyyy HH:mm");
}

export function formatCocoaReport(
  report: CocoaReport,
  signalThresholds: SignalThresholds
): string {
  const { snapshot, calculation } = report;
  const signal = getTradingSignal(
    calculation.rubDeviationFromFairPrice,
    calculation.fairLocalPriceRub,
    signalThresholds
  );
  const details = buildDetailsBlock(report, signal);

  return [
    `<b>Расчет какао</b>`,
    ``,
    `<b>Справедливая цена локального контракта:</b> ${formatDecimal(calculation.fairLocalPriceRub)} ₽ (${formatDecimal(calculation.fairWorldPriceUsd)} $)`,
    `<b>Локальный контракт:</b> ${formatFairPriceDeviation(calculation.rubDeviationFromFairPrice, signal.spreadPct)}`,
    `<b>Рекомендация:</b> ${signal.label}`,
    ``,
    `<blockquote expandable>${details}</blockquote>`
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function buildDetailsBlock(report: CocoaReport, signal: TradingSignal): string {
  const { snapshot, calculation, fairBasis } = report;
  const worldCloseRub = (calculation.worldCloseUsd * calculation.usdRubRate) / 1000;
  const lines = [
    `<b>Детали расчета</b>`,
    ``,
    `<b>Сигнал</b>`,
    `${escapeHtml(signal.label)}`,
    `${escapeHtml(signal.reason)}`,
    ``,
    `<b>Контракт</b>`,
    `${escapeHtml(snapshot.localCocoa.symbol)} (${escapeHtml(snapshot.localCocoa.displaySymbol)})`,
    ``,
    `<b>Исходные данные</b>`,
    `Локальная цена: ${formatDecimal(calculation.localPriceRub)} ₽`,
    `Зарубежное какао на закрытии: ${formatDecimal(calculation.worldCloseUsd)} $ (${formatDecimal(worldCloseRub)} ₽ без базиса)`,
    `Курс доллара (${escapeHtml(snapshot.usdRub.symbol)}): ${formatDecimal(calculation.usdRubRate)}`,
    ``,
    `<b>Базис</b>`,
    `<b>Текущий базис:</b> ${formatSignedDecimal(calculation.currentBasisUsd)} $`,
    `Это фактическая разница между локальным контрактом в долларах и закрытием COCOA.`,
    `Формула: локальный контракт в $ - COCOA close`,
    `${formatDecimal(calculation.localPriceUsd)} - ${formatDecimal(calculation.worldCloseUsd)} = ${formatSignedDecimal(calculation.currentBasisUsd)} $`,
    ``,
    `<b>Расчетный базис:</b> ${formatSignedDecimal(calculation.fairBasisUsd)} $`,
    `Это модельная оценка справедливого базиса с учетом ставки и времени до экспирации.`,
    `Формула: COCOA close × ставка × дни до экспирации / база_дней`,
    `${formatDecimal(calculation.worldCloseUsd)} × ${formatDecimal(fairBasis.annualRatePct)}% × ${formatDecimal(fairBasis.daysToExpiry)} / ${formatDecimal(fairBasis.dayCountBasis)} = ${formatDecimal(calculation.fairBasisUsd)} $`,
    `${formatFairBasisExplanation(fairBasis)}`,
    `Отклонение текущего базиса от расчетного: ${formatSignedDecimal(calculation.basisDeviationUsd)} $`,
    ``,
    `<b>Справедливая цена</b>`,
    `Локальный контракт в долларах: ${formatDecimal(calculation.localPriceUsd)} $`,
    `Справедливая цена локального контракта в долларах: ${formatDecimal(calculation.fairWorldPriceUsd)} $`,
    `Локальный контракт: ${formatFairPriceDeviation(calculation.rubDeviationFromFairPrice, signal.spreadPct)}`,
    ``,
    `<b>Источники и время</b>`,
    `Локальная цена: ${escapeHtml(snapshot.localCocoa.sourceLabel)}, ${formatDateTime(snapshot.localCocoa.observedAt)} МСК`,
    `${escapeHtml(snapshot.usdRub.symbol)}: ${escapeHtml(snapshot.usdRub.sourceLabel)}, ${formatDateTime(snapshot.usdRub.observedAt)} МСК`,
    `${escapeHtml(snapshot.worldClose.symbol)}: ${escapeHtml(snapshot.worldClose.sourceLabel)}, ${formatDateTime(snapshot.worldClose.observedAt)} МСК`
  ];

  if (!hasSameMinute(snapshot.worldClose.observedAt, snapshot.foreignCloseTarget)) {
    lines.push(
      `Ожидаемое закрытие внешнего рынка: ${formatDateTime(snapshot.foreignCloseTarget)} МСК`
    );
  }

  return lines.join("\n");
}

function formatFairBasisExplanation(fairBasis: FairBasisResult): string {
  const parts = [
    `Источник ставки: ${fairBasis.rateSourceLabel}`
  ];

  if (fairBasis.rateObservedAt) {
    parts.push(`дата ставки: ${fairBasis.rateObservedAt.toFormat("dd.MM.yyyy")}`);
  }

  return parts.join(", ");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function hasSameMinute(left: DateTime, right: DateTime): boolean {
  return left.startOf("minute").toMillis() === right.startOf("minute").toMillis();
}

function formatFairPriceDeviation(spreadRub: number, spreadPct: number): string {
  const absPctText = `${formatDecimal(Math.abs(spreadPct))}%`;

  if (Math.abs(spreadRub) < 0.005) {
    return "на уровне справедливой цены";
  }

  if (spreadRub > 0) {
    return `выше справедливой цены на ${formatDecimal(spreadRub)} ₽ (${absPctText})`;
  }

  return `ниже справедливой цены на ${formatDecimal(Math.abs(spreadRub))} ₽ (${absPctText})`;
}

interface TradingSignal {
  label: string;
  reason: string;
  spreadPct: number;
}

function getTradingSignal(
  spreadRub: number,
  fairLocalPriceRub: number,
  thresholds: SignalThresholds
): TradingSignal {
  const spreadPct =
    fairLocalPriceRub === 0 ? 0 : (spreadRub / fairLocalPriceRub) * 100;
  const absRub = Math.abs(spreadRub);
  const absPct = Math.abs(spreadPct);

  if (
    absRub < thresholds.neutralSpreadRub ||
    absPct < thresholds.neutralSpreadPct
  ) {
    return {
      label: "Нейтрально",
      reason:
        "Спред находится в зоне рыночного шума. Лучше ждать более выраженного отклонения.",
      spreadPct
    };
  }

  if (
    absRub < thresholds.cautiousSpreadRub ||
    absPct < thresholds.cautiousSpreadPct
  ) {
    return spreadRub > 0
      ? {
          label: "Осторожный шорт",
          reason:
            "Локальный контракт умеренно дороже справедливой цены. Сигнал есть, но без запаса.",
          spreadPct
        }
      : {
          label: "Осторожный лонг",
          reason:
            "Локальный контракт умеренно дешевле справедливой цены. Сигнал есть, но без запаса.",
          spreadPct
        };
  }

  if (
    absRub < thresholds.strongSpreadRub ||
    absPct < thresholds.strongSpreadPct
  ) {
    return spreadRub > 0
      ? {
          label: "Шорт",
          reason:
            "Локальный контракт заметно дороже справедливой цены. Отклонение уже выглядит рабочим.",
          spreadPct
        }
      : {
          label: "Лонг",
          reason:
            "Локальный контракт заметно дешевле справедливой цены. Отклонение уже выглядит рабочим.",
          spreadPct
        };
  }

  return spreadRub > 0
    ? {
        label: "Сильный шорт",
        reason:
          "Локальный контракт сильно перегрет относительно справедливой цены. Отклонение существенное.",
        spreadPct
      }
    : {
        label: "Сильный лонг",
        reason:
          "Локальный контракт сильно недооценен относительно справедливой цены. Отклонение существенное.",
        spreadPct
      };
}
