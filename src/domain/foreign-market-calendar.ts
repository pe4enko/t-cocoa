import { DateTime } from "luxon";

import type { ClockTime } from "../config";

export function isForeignMarketTradingDay(
  value: DateTime,
  holidays: ReadonlySet<string> = new Set()
): boolean {
  return value.weekday <= 5 && !holidays.has(value.toISODate() ?? "");
}

export function resolveForeignMarketCloseTarget(
  now: DateTime,
  closeTime: ClockTime,
  holidays: ReadonlySet<string> = new Set()
): DateTime {
  let candidate = now.set({
    hour: closeTime.hour,
    minute: closeTime.minute,
    second: 0,
    millisecond: 0
  });

  if (now < candidate) {
    candidate = candidate.minus({ days: 1 });
  }

  while (!isForeignMarketTradingDay(candidate, holidays)) {
    candidate = candidate.minus({ days: 1 });
  }

  return candidate;
}

export function buildForeignMarketSession(
  now: DateTime,
  openTime: ClockTime,
  closeTime: ClockTime
): { marketOpenTime: DateTime; marketCloseTime: DateTime } {
  return {
    marketOpenTime: now.set({
      hour: openTime.hour,
      minute: openTime.minute,
      second: 0,
      millisecond: 0
    }),
    marketCloseTime: now.set({
      hour: closeTime.hour,
      minute: closeTime.minute,
      second: 0,
      millisecond: 0
    })
  };
}

export function resolveNextForeignMarketOpen(
  now: DateTime,
  openTime: ClockTime,
  holidays: ReadonlySet<string> = new Set()
): DateTime {
  let candidate = now.set({
    hour: openTime.hour,
    minute: openTime.minute,
    second: 0,
    millisecond: 0
  });

  if (isForeignMarketTradingDay(candidate, holidays) && now < candidate) {
    return candidate;
  }

  candidate = candidate.plus({ days: 1 });

  while (!isForeignMarketTradingDay(candidate, holidays)) {
    candidate = candidate.plus({ days: 1 });
  }

  return candidate.set({
    hour: openTime.hour,
    minute: openTime.minute,
    second: 0,
    millisecond: 0
  });
}
