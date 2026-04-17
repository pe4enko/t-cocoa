import { DateTime } from "luxon";
import dotenv from "dotenv";

import {
  isLegacyGenericCocoaSymbol,
  normalizeTradingViewCocoaSymbol
} from "./domain/ice-cocoa-symbol";

dotenv.config();

const MOSCOW_TIME_ZONE = "Europe/Moscow";
const DEFAULT_TBANK_CA_CERT_PATH = "certs/TINKOFFBANK-ROOTCA.pem";

export interface SignalThresholds {
  neutralSpreadRub: number;
  neutralSpreadPct: number;
  cautiousSpreadRub: number;
  cautiousSpreadPct: number;
  strongSpreadRub: number;
  strongSpreadPct: number;
}

export interface FairBasisConfig {
  annualRatePctOverride: number | null;
  dayCountBasis: number;
  cbrKeyRateUrl: string;
}

export interface CacheConfig {
  cbrKeyRateEnabled: boolean;
  worldCloseEnabled: boolean;
  iceCocoaExpiryEnabled: boolean;
}

export interface IceCocoaExpiryFallbackEntryConfig {
  contractLabel: string;
  finalSettlementDate: string;
  tradingViewSymbol: string;
}

export interface LiveQuoteConfig {
  enabled: boolean;
  tbankApiToken?: string;
  tbankApiBaseUrl: string;
  tbankCaCertPath?: string;
  tbankTlsVerifyEnabled: boolean;
  tbankFuturesClassCode: string;
  tbankUsdRubSymbol: string;
  tbankOrderbookDepth: number;
}

export interface ClockTime {
  hour: number;
  minute: number;
  raw: string;
}

export interface AppConfig {
  botToken: string;
  ruCocoaAssetCode: string;
  usdRubSymbol: string;
  worldCocoaSymbolOverride?: string;
  worldCocoaContinuousSymbol: string;
  iceCocoaExpiryFallbackEntries: IceCocoaExpiryFallbackEntryConfig[];
  foreignMarketSessionCheckEnabled: boolean;
  foreignOpenTimeMsk: ClockTime;
  foreignCloseTimeMsk: ClockTime;
  foreignMarketHolidaysMsk: Set<string>;
  timeframeMinutes: number;
  lookbackBars: number;
  tradingViewSessionId?: string;
  moexIssBaseUrl: string;
  allowedChatIds: Set<number> | null;
  marketTimeZone: string;
  signalThresholds: SignalThresholds;
  fairBasis: FairBasisConfig;
  cache: CacheConfig;
  liveQuotes: LiveQuoteConfig;
}

function getRequiredString(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Environment variable ${name} is required.`);
  }

  return value;
}

function getOptionalString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function getNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }

  const value = Number(raw.replace(",", "."));
  if (Number.isNaN(value)) {
    throw new Error(`Environment variable ${name} must be a number.`);
  }

  return value;
}

function getBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  throw new Error(`Environment variable ${name} must be a boolean.`);
}

function getOptionalNumber(name: string): number | null {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return null;
  }

  const value = Number(raw.replace(",", "."));
  if (Number.isNaN(value)) {
    throw new Error(`Environment variable ${name} must be a number.`);
  }

  return value;
}

function parseTimeString(raw: string, variableName: string): ClockTime {
  const match = raw.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    throw new Error(
      `Environment variable ${variableName} must be in HH:mm format.`
    );
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error(
      `Environment variable ${variableName} must contain a valid time in HH:mm format.`
    );
  }

  return {
    hour,
    minute,
    raw: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`
  };
}

function getTime(variableName: string, fallback: string): ClockTime {
  const directValue = getOptionalString(variableName);
  if (directValue) {
    return parseTimeString(directValue, variableName);
  }

  return parseTimeString(fallback, variableName);
}

function getAllowedChatIds(): Set<number> | null {
  const raw = process.env.BOT_ALLOWED_CHAT_IDS?.trim();
  if (!raw) {
    return null;
  }

  const ids = raw
    .split(",")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => Number(chunk));

  if (ids.some((id) => Number.isNaN(id))) {
    throw new Error("BOT_ALLOWED_CHAT_IDS must contain only numeric chat ids.");
  }

  return new Set(ids);
}

function getOptionalIsoDateSet(name: string): Set<string> {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return new Set();
  }

  const values = raw
    .split(",")
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  const normalizedValues = values.map((value) => {
    const parsed = DateTime.fromISO(value, { zone: MOSCOW_TIME_ZONE });
    if (!parsed.isValid || parsed.toISODate() !== value) {
      throw new Error(
        `Environment variable ${name} must contain dates in YYYY-MM-DD format.`
      );
    }

    return value;
  });

  return new Set(normalizedValues);
}

function getIceCocoaExpiryFallbackEntries(
  name: string
): IceCocoaExpiryFallbackEntryConfig[] {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(";")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [contractLabelRaw, finalSettlementDateRaw, tradingViewSymbolRaw] = chunk
        .split("|")
        .map((part) => part.trim());

      if (!contractLabelRaw || !finalSettlementDateRaw || !tradingViewSymbolRaw) {
        throw new Error(
          `Environment variable ${name} must contain entries in CONTRACT|YYYY-MM-DD|SYMBOL format separated by semicolons.`
        );
      }

      const parsedDate = DateTime.fromISO(finalSettlementDateRaw, {
        zone: MOSCOW_TIME_ZONE
      });

      if (!parsedDate.isValid || parsedDate.toISODate() !== finalSettlementDateRaw) {
        throw new Error(
          `Environment variable ${name} must contain valid ISO dates in YYYY-MM-DD format.`
        );
      }

      return {
        contractLabel: contractLabelRaw,
        finalSettlementDate: finalSettlementDateRaw,
        tradingViewSymbol: normalizeTradingViewCocoaSymbol(tradingViewSymbolRaw)
      };
    });
}

export const config: AppConfig = {
  botToken: getRequiredString("BOT_TOKEN"),
  ruCocoaAssetCode: getOptionalString("RU_COCOA_ASSET_CODE") ?? "COCOA",
  usdRubSymbol: getOptionalString("TV_USDRUBF_SYMBOL") ?? "USDRUBF",
  worldCocoaSymbolOverride: (() => {
    const value = getOptionalString("TV_WORLD_COCOA_SYMBOL");
    if (!value || isLegacyGenericCocoaSymbol(value)) {
      return undefined;
    }

    return value;
  })(),
  worldCocoaContinuousSymbol:
    getOptionalString("TV_WORLD_COCOA_CONTINUOUS_SYMBOL") ?? "ICEUS:CC1!",
  iceCocoaExpiryFallbackEntries: getIceCocoaExpiryFallbackEntries(
    "ICE_COCOA_EXPIRY_FALLBACK_ENTRIES"
  ),
  foreignMarketSessionCheckEnabled: getBoolean(
    "FOREIGN_MARKET_SESSION_CHECK_ENABLED",
    true
  ),
  foreignOpenTimeMsk: getTime("FOREIGN_OPEN_TIME_MSK", "11:45"),
  foreignCloseTimeMsk: getTime("FOREIGN_CLOSE_TIME_MSK", "20:30"),
  foreignMarketHolidaysMsk: getOptionalIsoDateSet("FOREIGN_MARKET_HOLIDAYS_MSK"),
  timeframeMinutes: getNumber("TV_TIMEFRAME_MINUTES", 1),
  lookbackBars: getNumber("TV_LOOKBACK_BARS", 3000),
  tradingViewSessionId: getOptionalString("TV_SESSION_ID"),
  moexIssBaseUrl: getOptionalString("MOEX_ISS_BASE_URL") ?? "https://iss.moex.com",
  allowedChatIds: getAllowedChatIds(),
  marketTimeZone: MOSCOW_TIME_ZONE,
  signalThresholds: {
    neutralSpreadRub: getNumber("SIGNAL_NEUTRAL_SPREAD_RUB", 0.25),
    neutralSpreadPct: getNumber("SIGNAL_NEUTRAL_SPREAD_PCT", 0.1),
    cautiousSpreadRub: getNumber("SIGNAL_CAUTIOUS_SPREAD_RUB", 0.75),
    cautiousSpreadPct: getNumber("SIGNAL_CAUTIOUS_SPREAD_PCT", 0.25),
    strongSpreadRub: getNumber("SIGNAL_STRONG_SPREAD_RUB", 1.75),
    strongSpreadPct: getNumber("SIGNAL_STRONG_SPREAD_PCT", 0.6)
  },
  fairBasis: {
    annualRatePctOverride: getOptionalNumber("FAIR_BASIS_RATE_PCT"),
    dayCountBasis: getNumber("FAIR_BASIS_DAY_COUNT", 360),
    cbrKeyRateUrl:
      getOptionalString("CBR_KEY_RATE_URL") ??
      "https://www.cbr.ru/eng/hd_base/KeyRate/?UniDbQuery.Posted=True"
  },
  cache: {
    cbrKeyRateEnabled: getBoolean("CBR_KEY_RATE_CACHE_ENABLED", true),
    worldCloseEnabled: getBoolean("TV_WORLD_CLOSE_CACHE_ENABLED", true),
    iceCocoaExpiryEnabled: getBoolean("ICE_COCOA_EXPIRY_CACHE_ENABLED", true)
  },
  liveQuotes: {
    enabled: getBoolean("LIVE_QUOTES_ENABLED", true),
    tbankApiToken: getOptionalString("TBANK_API_TOKEN"),
    tbankApiBaseUrl:
      getOptionalString("TBANK_API_BASE_URL") ??
      "https://invest-public-api.tbank.ru/rest",
    tbankCaCertPath:
      getOptionalString("TBANK_CA_CERT_PATH") ?? DEFAULT_TBANK_CA_CERT_PATH,
    tbankTlsVerifyEnabled: getBoolean("TBANK_TLS_VERIFY_ENABLED", true),
    tbankFuturesClassCode:
      getOptionalString("TBANK_FUTURES_CLASS_CODE") ?? "SPBFUT",
    tbankUsdRubSymbol:
      getOptionalString("TBANK_USDRUB_SYMBOL") ??
      getOptionalString("TV_USDRUBF_SYMBOL") ??
      "USDRUBF",
    tbankOrderbookDepth: getNumber("TBANK_ORDERBOOK_DEPTH", 1)
  }
};
