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
  const fairLocalPriceRubFormula = `${formatDecimal(calculation.usdRubRate)} × ${formatDecimal(calculation.fairWorldPriceUsd)} / 1000 = ${formatDecimal(calculation.fairLocalPriceRub)} ₽`;
  const lines = [
    `${formatSectionHeader("Детали расчета")}`,
    ``,
    `${formatSectionHeader("Сигнал")}`,
    `${formatDetailValue("Рекомендация", escapeHtml(signal.label))}`,
    `${formatDetailValue("Комментарий", escapeHtml(signal.reason))}`,
    ``,
    `${formatSectionHeader("Контракт")}`,
    `${formatDetailValue("Контракт", `${escapeHtml(snapshot.localCocoa.symbol)} (${escapeHtml(snapshot.localCocoa.displaySymbol)})`)}`,
    ``,
    `${formatSectionHeader("Исходные данные")}`,
    `${formatDetailValue("Локальная цена", `${formatDecimal(calculation.localPriceRub)} ₽`)}`,
    `${formatDetailValue("Зарубежное какао на закрытии", `${formatDecimal(calculation.worldCloseUsd)} $ (${formatDecimal(worldCloseRub)} ₽ без базиса)`)}`,
    `${formatDetailValue(`Курс доллара (${escapeHtml(snapshot.usdRub.symbol)})`, formatDecimal(calculation.usdRubRate))}`,
    ``,
    `${formatSectionHeader("Преобразование")}`,
    `${formatDetailValue("Локальный контракт в долларах", `${formatDecimal(calculation.localPriceUsd)} $`)}`,
    `${formatDetailValue("Формула", "локальная цена × 1000 / курс доллара")}`,
    `${formatDetailValue("Подстановка", `${formatDecimal(calculation.localPriceRub)} × 1000 / ${formatDecimal(calculation.usdRubRate)} = ${formatDecimal(calculation.localPriceUsd)} $`)}`,
    ``,
    `${formatSectionHeader("Базис")}`,
    `${formatDetailValue("Текущий базис", `${formatSignedDecimal(calculation.currentBasisUsd)} $`)}`,
    `${formatDetailValue("Формула", "локальный контракт в $ - COCOA close")}`,
    `${formatDetailValue("Подстановка", `${formatDecimal(calculation.localPriceUsd)} - ${formatDecimal(calculation.worldCloseUsd)} = ${formatSignedDecimal(calculation.currentBasisUsd)} $`)}`,
    ``,
    `${formatDetailValue("Расчетный базис", `${formatSignedDecimal(calculation.fairBasisUsd)} $`)}`,
    `${formatDetailValue("Формула", "COCOA close × ставка × дни до экспирации / база_дней")}`,
    `${formatDetailValue("Подстановка", `${formatDecimal(calculation.worldCloseUsd)} × ${formatDecimal(fairBasis.annualRatePct)}% × ${formatDecimal(fairBasis.daysToExpiry)} / ${formatDecimal(fairBasis.dayCountBasis)} = ${formatDecimal(calculation.fairBasisUsd)} $`)}`,
    `${formatDetailValue("Источник ставки", formatFairBasisExplanation(fairBasis))}`,
    `${formatDetailValue("Отклонение от текущего базиса", `${formatSignedDecimal(calculation.basisDeviationUsd)} $`)}`,
    ``,
    `${formatSectionHeader("Справедливая цена")}`,
    `${formatDetailValue("Справедливая цена в долларах", `${formatDecimal(calculation.fairWorldPriceUsd)} $`)}`,
    `${formatDetailValue("Формула", "COCOA close + расчетный базис")}`,
    `${formatDetailValue("Подстановка", `${formatDecimal(calculation.worldCloseUsd)} + ${formatDecimal(calculation.fairBasisUsd)} = ${formatDecimal(calculation.fairWorldPriceUsd)} $`)}`,
    ``,
    `${formatDetailValue("Справедливая цена в рублях", `${formatDecimal(calculation.fairLocalPriceRub)} ₽`)}`,
    `${formatDetailValue("Формула", "курс доллара × справедливая цена в $ / 1000")}`,
    `${formatDetailValue("Подстановка", fairLocalPriceRubFormula)}`,
    ``,
    `${formatSectionHeader("Источники и время")}`,
    `${formatDetailValue("Локальная цена", `${escapeHtml(snapshot.localCocoa.sourceLabel)}, ${formatDateTime(snapshot.localCocoa.observedAt)} МСК`)}`,
    `${formatDetailValue(escapeHtml(snapshot.usdRub.symbol), `${escapeHtml(snapshot.usdRub.sourceLabel)}, ${formatDateTime(snapshot.usdRub.observedAt)} МСК`)}`,
    `${formatDetailValue(escapeHtml(snapshot.worldClose.symbol), `${escapeHtml(snapshot.worldClose.sourceLabel)}, ${formatDateTime(snapshot.worldClose.observedAt)} МСК`)}`
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
    fairBasis.rateSourceLabel
  ];

  if (fairBasis.rateObservedAt) {
    parts.push(`дата ${fairBasis.rateObservedAt.toFormat("dd.MM.yyyy")}`);
  }

  return parts.join(", ");
}

function formatSectionHeader(value: string): string {
  return `<b><i>${value}</i></b>`;
}

function formatDetailValue(label: string, value: string): string {
  return `<b>${label}:</b> ${value}`;
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
