import type { DateTime } from "luxon";

const ICE_COCOA_REGULAR_MONTHS = [
  { month: 3, code: "H" },
  { month: 5, code: "K" },
  { month: 7, code: "N" },
  { month: 9, code: "U" },
  { month: 12, code: "Z" }
] as const;

export function resolveIceUsCocoaSymbolForExpiry(
  expiresAt: DateTime | undefined,
  continuousSymbol: string
): string {
  if (!expiresAt?.isValid) {
    return normalizeTradingViewCocoaSymbol(continuousSymbol);
  }

  const matchingMonth = ICE_COCOA_REGULAR_MONTHS.find(
    (item) => item.month >= expiresAt.month
  );

  if (matchingMonth) {
    return `ICEUS:CC${matchingMonth.code}${expiresAt.year}`;
  }

  return `ICEUS:CCH${expiresAt.year + 1}`;
}

export function normalizeTradingViewCocoaSymbol(value: string): string {
  const normalized = value.trim().toUpperCase();

  if (!normalized) {
    return normalized;
  }

  if (normalized === "CC1!") {
    return "ICEUS:CC1!";
  }

  if (/^CC[HKNUZ]\d{4}$/.test(normalized)) {
    return `ICEUS:${normalized}`;
  }

  return normalized;
}

export function isLegacyGenericCocoaSymbol(value: string | undefined): boolean {
  return value?.trim().toUpperCase() === "COCOA";
}
