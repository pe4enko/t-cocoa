import { DateTime } from "luxon";

import type { AppConfig } from "../config";
import {
  calculateCocoaSpread,
  type CocoaCalculationResult
} from "../domain/cocoa-calculator";
import {
  buildForeignMarketSession,
  isForeignMarketTradingDay
} from "../domain/foreign-market-calendar";
import type { CocoaMarketSnapshot } from "../domain/market";
import type { CbrKeyRateService } from "../integrations/cbr-key-rate";
import type { MoexIssService } from "../integrations/moex-iss";
import type { TradingViewService } from "../integrations/tradingview";

export interface CocoaReportRequest {
  localSymbolOverride?: string;
}

export interface CocoaReport {
  snapshot: CocoaMarketSnapshot;
  calculation: CocoaCalculationResult;
  fairBasis: FairBasisResult;
}

export interface FairBasisResult {
  value: number;
  annualRatePct: number;
  dayCountBasis: number;
  daysToExpiry: number;
  rateSourceLabel: string;
  rateObservedAt?: DateTime;
}

export class ForeignMarketOpenError extends Error {
  constructor(
    message: string,
    readonly currentTime: DateTime,
    readonly marketOpenTime: DateTime,
    readonly marketCloseTime: DateTime
  ) {
    super(message);
    this.name = "ForeignMarketOpenError";
  }
}

export class CocoaReportService {
  constructor(
    private readonly tradingViewService: TradingViewService,
    private readonly moexIssService: MoexIssService,
    private readonly cbrKeyRateService: CbrKeyRateService,
    private readonly config: AppConfig
  ) {}

  async buildReport(request: CocoaReportRequest = {}): Promise<CocoaReport> {
    this.assertForeignMarketClosed();
    const [localCocoa, externalSnapshot] = await Promise.all([
      this.moexIssService.getLocalCocoaSnapshot(request.localSymbolOverride),
      this.tradingViewService.getExternalSnapshot()
    ]);

    const snapshot: CocoaMarketSnapshot = {
      localCocoa,
      usdRub: externalSnapshot.usdRub,
      worldClose: externalSnapshot.worldClose,
      foreignCloseTarget: externalSnapshot.foreignCloseTarget
    };
    const fairBasis = await this.calculateFairBasis(
      snapshot.worldClose.price,
      snapshot.foreignCloseTarget,
      snapshot.localCocoa.expiresAt
    );

    const calculation = calculateCocoaSpread({
      usdRubRate: snapshot.usdRub.price,
      fairBasisUsd: fairBasis.value,
      worldCloseUsd: snapshot.worldClose.price,
      localPriceRub: snapshot.localCocoa.price
    });

    return {
      snapshot,
      calculation,
      fairBasis
    };
  }

  private async calculateFairBasis(
    worldCloseUsd: number,
    foreignCloseTarget: DateTime,
    expiresAt?: DateTime
  ): Promise<FairBasisResult> {
    if (!expiresAt) {
      throw new Error(
        "Невозможно рассчитать базис: у локального контракта нет даты экспирации."
      );
    }

    const rateSnapshot = await this.resolveAnnualRate();

    const expiryMoment = expiresAt.endOf("day");
    const daysToExpiry = Math.max(
      0,
      expiryMoment.diff(foreignCloseTarget, "days").days
    );
    const value =
      (worldCloseUsd *
        (rateSnapshot.ratePct / 100) *
        daysToExpiry) /
      this.config.fairBasis.dayCountBasis;

    return {
      value,
      annualRatePct: rateSnapshot.ratePct,
      dayCountBasis: this.config.fairBasis.dayCountBasis,
      daysToExpiry,
      rateSourceLabel: rateSnapshot.sourceLabel,
      rateObservedAt: rateSnapshot.publishedAt
    };
  }

  private async resolveAnnualRate(): Promise<{
    ratePct: number;
    sourceLabel: string;
    publishedAt?: DateTime;
  }> {
    if (this.config.fairBasis.annualRatePctOverride !== null) {
      return {
        ratePct: this.config.fairBasis.annualRatePctOverride,
        sourceLabel: "ручной override (.env)"
      };
    }

    return this.cbrKeyRateService.getCurrentKeyRate();
  }

  private assertForeignMarketClosed(now = DateTime.now().setZone(this.config.marketTimeZone)): void {
    if (!isForeignMarketTradingDay(now, this.config.foreignMarketHolidaysMsk)) {
      return;
    }

    const { marketOpenTime, marketCloseTime } = buildForeignMarketSession(
      now,
      this.config.foreignOpenTimeMsk,
      this.config.foreignCloseTimeMsk
    );

    if (now >= marketOpenTime && now < marketCloseTime) {
      throw new ForeignMarketOpenError(
        "Сейчас идут торги на зарубежном рынке.",
        now,
        marketOpenTime,
        marketCloseTime
      );
    }
  }
}
