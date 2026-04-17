import { X509Certificate } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isAbsolute, resolve } from "node:path";
import { DateTime } from "luxon";

import type { AppConfig } from "../config";
import type { QuoteSnapshot } from "../domain/market";

interface TBankQuotation {
  units?: string | number;
  nano?: string | number;
}

interface TBankOrder {
  price?: TBankQuotation | null;
}

interface TBankOrderBookResponse {
  bids?: TBankOrder[];
  asks?: TBankOrder[];
  time?: string;
}

interface TBankLastPriceItem {
  price?: TBankQuotation | null;
  time?: string;
}

interface TBankLastPricesResponse {
  lastPrices?: TBankLastPriceItem[];
}

interface TBankFutureResponse {
  instrument?: {
    ticker?: string;
    classCode?: string;
    uid?: string;
    minPriceIncrement?: TBankQuotation | null;
    basicAssetSize?: TBankQuotation | null;
  };
}

interface TBankFuturesMarginResponse {
  minPriceIncrementAmount?: TBankQuotation | null;
}

interface TBankFutureMetadata {
  ticker: string;
  classCode: string;
  uid: string;
  minPriceIncrement: number;
  basicAssetSize: number;
}

interface PriceSelection {
  pointsPrice: number;
  observedAt: DateTime;
  sourceLabel: string;
}

interface CustomCaDetails {
  pem: string;
  configuredPath: string;
  resolvedPath: string;
  sizeBytes: number;
  certificateCount: number;
  firstCertificateSubject: string | null;
  firstCertificateIssuer: string | null;
  firstCertificateValidFrom: string | null;
  firstCertificateValidTo: string | null;
  firstCertificateFingerprint256: string | null;
}

export class TBankInvestService {
  private readonly metadataCache = new Map<string, TBankFutureMetadata>();
  private customCaPromise?: Promise<CustomCaDetails | undefined>;
  private insecureTlsWarningShown = false;
  private tlsConfigurationLogged = false;

  constructor(private readonly config: AppConfig) {}

  clearCache(): void {
    this.metadataCache.clear();
    this.customCaPromise = undefined;
    this.insecureTlsWarningShown = false;
    this.tlsConfigurationLogged = false;
  }

  isEnabled(): boolean {
    return this.config.liveQuotes.enabled && Boolean(this.config.liveQuotes.tbankApiToken);
  }

  async getLocalCocoaSnapshot(
    contract: QuoteSnapshot
  ): Promise<QuoteSnapshot> {
    return this.getFutureSnapshot({
      symbol: contract.symbol,
      displaySymbol: contract.displaySymbol,
      expiresAt: contract.expiresAt
    }, "orderbook");
  }

  async getUsdRubSnapshot(): Promise<QuoteSnapshot> {
    return this.getFutureSnapshot({
      symbol: this.config.liveQuotes.tbankUsdRubSymbol
    }, "last-price-only");
  }

  private async getFutureSnapshot(
    params: {
      symbol: string;
      displaySymbol?: string;
      expiresAt?: DateTime;
    },
    mode: "orderbook" | "last-price-only"
  ): Promise<QuoteSnapshot> {
    const symbol = params.symbol.trim().toUpperCase();
    const metadata = await this.getFutureMetadata(symbol);
    const priceSelection =
      mode === "orderbook"
        ? await this.getOrderBookPriceSelection(metadata)
        : await this.getLastPriceSelection(metadata, "T-Bank (last price)");
    const minPriceIncrementAmount = await this.getMinPriceIncrementAmount(metadata.uid);
    const price = this.convertPointsToMoney(
      priceSelection.pointsPrice,
      metadata.minPriceIncrement,
      minPriceIncrementAmount,
      metadata.basicAssetSize
    );

    return {
      symbol,
      displaySymbol: params.displaySymbol ?? symbol,
      price,
      observedAt: priceSelection.observedAt,
      sourceLabel: priceSelection.sourceLabel,
      expiresAt: params.expiresAt
    };
  }

  private async getOrderBookPriceSelection(
    metadata: TBankFutureMetadata
  ): Promise<PriceSelection> {
    const orderBook = await this.request<TBankOrderBookResponse>(
      "/tinkoff.public.invest.api.contract.v1.MarketDataService/GetOrderBook",
      {
        instrumentId: metadata.uid,
        depth: Math.max(1, Math.trunc(this.config.liveQuotes.tbankOrderbookDepth))
      }
    );

    const orderBookTime = this.parseObservedAt(orderBook.time);
    const bestBid = this.getQuotationNumber(orderBook.bids?.[0]?.price);
    const bestAsk = this.getQuotationNumber(orderBook.asks?.[0]?.price);

    if (bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk > 0) {
      return {
        pointsPrice: (bestBid + bestAsk) / 2,
        observedAt: orderBookTime,
        sourceLabel: "T-Bank (mid bid/ask)"
      };
    }

    if (bestBid !== null && bestBid > 0) {
      return {
        pointsPrice: bestBid,
        observedAt: orderBookTime,
        sourceLabel: "T-Bank (best bid)"
      };
    }

    if (bestAsk !== null && bestAsk > 0) {
      return {
        pointsPrice: bestAsk,
        observedAt: orderBookTime,
        sourceLabel: "T-Bank (best ask)"
      };
    }

    const lastPriceSelection = await this.getLastPriceSelection(
      metadata,
      "T-Bank (last price fallback)"
    );

    console.warn(
      `[T-Bank live quotes] ${metadata.ticker}: bid/ask unavailable, fallback to last price.`,
      {
        bestBid,
        bestAsk,
        orderBookTime: orderBook.time ?? null,
        lastPrice: lastPriceSelection.pointsPrice,
        lastPriceTime: lastPriceSelection.observedAt.toISO()
      }
    );

    return lastPriceSelection;
  }

  private async getLastPriceSelection(
    metadata: TBankFutureMetadata,
    sourceLabel: string
  ): Promise<PriceSelection> {
    const lastPrices = await this.request<TBankLastPricesResponse>(
      "/tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices",
      {
        instrumentId: [metadata.uid]
      }
    );
    const lastPriceItem = lastPrices.lastPrices?.[0];
    const lastPrice = this.getQuotationNumber(lastPriceItem?.price);

    if (lastPrice === null) {
      throw new Error(`T-Bank did not return a usable price for ${metadata.ticker}.`);
    }

    return {
      pointsPrice: lastPrice,
      observedAt: this.parseObservedAt(lastPriceItem?.time),
      sourceLabel
    };
  }

  private async getFutureMetadata(symbol: string): Promise<TBankFutureMetadata> {
    const cached = this.metadataCache.get(symbol);
    if (cached) {
      return cached;
    }

    const response = await this.request<TBankFutureResponse>(
      "/tinkoff.public.invest.api.contract.v1.InstrumentsService/FutureBy",
      {
        idType: "INSTRUMENT_ID_TYPE_TICKER",
        id: symbol,
        classCode: this.config.liveQuotes.tbankFuturesClassCode
      }
    );

    const instrument = response.instrument;
    const uid = instrument?.uid?.trim();
    const ticker = instrument?.ticker?.trim().toUpperCase();
    const classCode = instrument?.classCode?.trim().toUpperCase();
    const minPriceIncrement = this.getQuotationNumber(instrument?.minPriceIncrement);
    const basicAssetSize = this.getQuotationNumber(instrument?.basicAssetSize);

    if (
      !uid ||
      !ticker ||
      !classCode ||
      minPriceIncrement === null ||
      minPriceIncrement <= 0 ||
      basicAssetSize === null ||
      basicAssetSize <= 0
    ) {
      throw new Error(`T-Bank did not return complete metadata for ${symbol}.`);
    }

    const metadata: TBankFutureMetadata = {
      ticker,
      classCode,
      uid,
      minPriceIncrement,
      basicAssetSize
    };

    this.metadataCache.set(symbol, metadata);
    return metadata;
  }

  private async getMinPriceIncrementAmount(instrumentId: string): Promise<number> {
    const response = await this.request<TBankFuturesMarginResponse>(
      "/tinkoff.public.invest.api.contract.v1.InstrumentsService/GetFuturesMargin",
      {
        instrumentId
      }
    );

    const value = this.getQuotationNumber(response.minPriceIncrementAmount);
    if (value === null || value <= 0) {
      throw new Error(
        `T-Bank did not return minPriceIncrementAmount for ${instrumentId}.`
      );
    }

    return value;
  }

  private convertPointsToMoney(
    priceInPoints: number,
    minPriceIncrement: number,
    minPriceIncrementAmount: number,
    basicAssetSize: number
  ): number {
    const contractValue =
      (priceInPoints / minPriceIncrement) * minPriceIncrementAmount;

    return contractValue / basicAssetSize;
  }

  private async request<TResponse>(
    path: string,
    body: Record<string, unknown>
  ): Promise<TResponse> {
    const token = this.config.liveQuotes.tbankApiToken;
    if (!token) {
      throw new Error("TBANK_API_TOKEN is not configured.");
    }

    const baseUrl = this.config.liveQuotes.tbankApiBaseUrl.endsWith("/")
      ? this.config.liveQuotes.tbankApiBaseUrl
      : `${this.config.liveQuotes.tbankApiBaseUrl}/`;
    const normalizedPath = path.startsWith("/") ? path.slice(1) : path;
    const url = new URL(normalizedPath, baseUrl);

    try {
      return await this.performJsonRequest<TResponse>(url, token, body);
    } catch (error) {
      throw new Error(
        `Не удалось получить данные T-Bank Invest API с ${url.host}. ${this.describeFetchError(error)}. Если на сервере используется нестандартный корневой сертификат, укажите TBANK_CA_CERT_PATH. Для временного обхода можно установить TBANK_TLS_VERIFY_ENABLED=false.`
      );
    }
  }

  private getQuotationNumber(value?: TBankQuotation | null): number | null {
    if (!value) {
      return null;
    }

    const units = Number(value.units ?? 0);
    const nano = Number(value.nano ?? 0);

    if (Number.isNaN(units) || Number.isNaN(nano)) {
      return null;
    }

    return units + nano / 1_000_000_000;
  }

  private parseObservedAt(value?: string): DateTime {
    if (value) {
      const parsed = DateTime.fromISO(value, { zone: "utc" }).setZone(
        this.config.marketTimeZone
      );
      if (parsed.isValid) {
        return parsed;
      }
    }

    return DateTime.now().setZone(this.config.marketTimeZone);
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

  private async performJsonRequest<TResponse>(
    url: URL,
    token: string,
    body: Record<string, unknown>
  ): Promise<TResponse> {
    const customCa = await this.getCustomCa();
    const tlsVerifyEnabled = this.config.liveQuotes.tbankTlsVerifyEnabled;
    const transport =
      !customCa && tlsVerifyEnabled
        ? "fetch/system-trust-store"
        : "https-request/custom-tls-options";

    this.logTlsConfiguration(url, transport, customCa);

    if (!customCa && tlsVerifyEnabled) {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify(body)
        });

        if (!response.ok) {
          const details = await response.text();
          throw new Error(
            `T-Bank Invest API request failed with status ${response.status}: ${details.slice(0, 200)}`
          );
        }

        return (await response.json()) as TResponse;
      } catch (error) {
        this.logRequestFailure(url, transport, customCa, error);
        throw error;
      }
    }

    const rawBody = JSON.stringify(body);

    if (!tlsVerifyEnabled && !this.insecureTlsWarningShown) {
      this.insecureTlsWarningShown = true;
      console.warn(
        "[T-Bank live quotes] TLS certificate verification is disabled via TBANK_TLS_VERIFY_ENABLED=false. Use only as a temporary workaround."
      );
    }

    return await new Promise<TResponse>((resolvePromise, rejectPromise) => {
      const req = httpsRequest(
        url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "Content-Length": Buffer.byteLength(rawBody)
          },
          ca: customCa?.pem,
          rejectUnauthorized: tlsVerifyEnabled
        },
        (res) => {
          let responseBody = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            responseBody += chunk;
          });
          res.on("end", () => {
            const statusCode = res.statusCode ?? 0;

            if (statusCode < 200 || statusCode >= 300) {
              const error = new Error(
                `T-Bank Invest API request failed with status ${statusCode}: ${responseBody.slice(0, 200)}`
              );
              this.logRequestFailure(url, transport, customCa, error);
              rejectPromise(error);
              return;
            }

            try {
              resolvePromise(JSON.parse(responseBody) as TResponse);
            } catch (error) {
              const parseError =
                error instanceof Error
                  ? error
                  : new Error("Failed to parse T-Bank Invest API response.");
              this.logRequestFailure(url, transport, customCa, parseError);
              rejectPromise(parseError);
            }
          });
        }
      );

      req.on("error", (error) => {
        this.logRequestFailure(url, transport, customCa, error);
        rejectPromise(error);
      });
      req.write(rawBody);
      req.end();
    });
  }

  private async getCustomCa(): Promise<CustomCaDetails | undefined> {
    if (!this.config.liveQuotes.tbankCaCertPath) {
      return undefined;
    }

    if (!this.customCaPromise) {
      this.customCaPromise = this.loadCustomCa(
        this.config.liveQuotes.tbankCaCertPath
      );
    }

    return this.customCaPromise;
  }

  private async loadCustomCa(configuredPath: string): Promise<CustomCaDetails> {
    const attemptedPaths = this.getCustomCaCandidatePaths(configuredPath);
    const loadErrors: Array<Record<string, unknown>> = [];

    for (const candidatePath of attemptedPaths) {
      try {
        const [pem, stats] = await Promise.all([
          readFile(candidatePath, "utf8"),
          stat(candidatePath)
        ]);
        const certificateCount =
          pem.match(/-----BEGIN CERTIFICATE-----/g)?.length ?? 0;

        return {
          pem,
          configuredPath,
          resolvedPath: candidatePath,
          sizeBytes: stats.size,
          certificateCount,
          ...this.getFirstCertificateMetadata(pem)
        };
      } catch (error) {
        loadErrors.push({
          path: candidatePath,
          error: this.getErrorDiagnostics(error)
        });
      }
    }

    console.error("[T-Bank live quotes] Failed to load custom CA certificate.", {
      configuredPath,
      attemptedPaths,
      cwd: process.cwd(),
      appRoot: this.getAppRoot(),
      errorCount: loadErrors.length,
      errors: loadErrors
    });

    throw new Error(
      `Failed to load custom CA certificate from ${configuredPath}.`
    );
  }

  private getCustomCaCandidatePaths(configuredPath: string): string[] {
    if (isAbsolute(configuredPath)) {
      return [configuredPath];
    }

    return [...new Set([
      resolve(process.cwd(), configuredPath),
      resolve(this.getAppRoot(), configuredPath)
    ])];
  }

  private getAppRoot(): string {
    return resolve(__dirname, "..", "..");
  }

  private getFirstCertificateMetadata(
    pem: string
  ): Omit<CustomCaDetails, "pem" | "configuredPath" | "resolvedPath" | "sizeBytes" | "certificateCount"> {
    const firstCertificateMatch = pem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/
    );

    if (!firstCertificateMatch) {
      return {
        firstCertificateSubject: null,
        firstCertificateIssuer: null,
        firstCertificateValidFrom: null,
        firstCertificateValidTo: null,
        firstCertificateFingerprint256: null
      };
    }

    try {
      const certificate = new X509Certificate(firstCertificateMatch[0]);

      return {
        firstCertificateSubject: certificate.subject,
        firstCertificateIssuer: certificate.issuer,
        firstCertificateValidFrom: certificate.validFrom,
        firstCertificateValidTo: certificate.validTo,
        firstCertificateFingerprint256: certificate.fingerprint256
      };
    } catch (error) {
      console.warn(
        "[T-Bank live quotes] Failed to parse custom CA certificate metadata.",
        {
          error: this.getErrorDiagnostics(error)
        }
      );

      return {
        firstCertificateSubject: null,
        firstCertificateIssuer: null,
        firstCertificateValidFrom: null,
        firstCertificateValidTo: null,
        firstCertificateFingerprint256: null
      };
    }
  }

  private logTlsConfiguration(
    url: URL,
    transport: string,
    customCa: CustomCaDetails | undefined
  ): void {
    if (this.tlsConfigurationLogged) {
      return;
    }

    this.tlsConfigurationLogged = true;

    console.info("[T-Bank live quotes] TLS configuration.", {
      baseUrl: url.origin,
      host: url.host,
      transport,
      tlsVerifyEnabled: this.config.liveQuotes.tbankTlsVerifyEnabled,
      configuredCaPath: this.config.liveQuotes.tbankCaCertPath ?? null,
      loadedCaPath: customCa?.resolvedPath ?? null,
      customCaLoaded: Boolean(customCa),
      customCaSizeBytes: customCa?.sizeBytes ?? null,
      customCaCertificateCount: customCa?.certificateCount ?? null,
      customCaSubject: customCa?.firstCertificateSubject ?? null,
      customCaIssuer: customCa?.firstCertificateIssuer ?? null,
      customCaValidFrom: customCa?.firstCertificateValidFrom ?? null,
      customCaValidTo: customCa?.firstCertificateValidTo ?? null,
      customCaFingerprint256: customCa?.firstCertificateFingerprint256 ?? null,
      cwd: process.cwd(),
      appRoot: this.getAppRoot(),
      nodeVersion: process.version,
      nodeEnv: process.env.NODE_ENV ?? null,
      nodeExtraCaCerts: process.env.NODE_EXTRA_CA_CERTS ?? null
    });
  }

  private logRequestFailure(
    url: URL,
    transport: string,
    customCa: CustomCaDetails | undefined,
    error: unknown
  ): void {
    console.error("[T-Bank live quotes] Request failed.", {
      url: url.toString(),
      host: url.host,
      path: url.pathname,
      transport,
      tlsVerifyEnabled: this.config.liveQuotes.tbankTlsVerifyEnabled,
      configuredCaPath: this.config.liveQuotes.tbankCaCertPath ?? null,
      loadedCaPath: customCa?.resolvedPath ?? null,
      customCaLoaded: Boolean(customCa),
      error: this.getErrorDiagnostics(error)
    });
  }

  private getErrorDiagnostics(error: unknown): Record<string, unknown> {
    if (!(error instanceof Error)) {
      return {
        type: typeof error,
        value: String(error)
      };
    }

    const systemError = error as Error & {
      code?: unknown;
      errno?: unknown;
      syscall?: unknown;
      path?: unknown;
      cause?: unknown;
    };
    const diagnostics: Record<string, unknown> = {
      name: systemError.name,
      message: systemError.message
    };

    if (systemError.code !== undefined) {
      diagnostics.code = systemError.code;
    }

    if (systemError.errno !== undefined) {
      diagnostics.errno = systemError.errno;
    }

    if (systemError.syscall !== undefined) {
      diagnostics.syscall = systemError.syscall;
    }

    if (systemError.path !== undefined) {
      diagnostics.path = systemError.path;
    }

    if (systemError.stack) {
      diagnostics.stack = systemError.stack.split("\n").slice(0, 6).join("\n");
    }

    if (systemError.cause instanceof Error) {
      diagnostics.cause = this.getErrorDiagnostics(systemError.cause);
    } else if (typeof systemError.cause === "string") {
      diagnostics.cause = systemError.cause;
    }

    return diagnostics;
  }
}
