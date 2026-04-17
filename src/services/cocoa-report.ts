import { DateTime } from "luxon";

import type { AppConfig } from "../config";
import {
  calculateCocoaSpread,
  type CocoaCalculationResult
} from "../domain/cocoa-calculator";
import {
  isForeignMarketTradingDay
} from "../domain/foreign-market-calendar";
import type { CocoaMarketSnapshot } from "../domain/market";
import type { CbrKeyRateService } from "../integrations/cbr-key-rate";
import type { IceCocoaHoursService } from "../integrations/ice-cocoa-hours";
import type { MoexIssService } from "../integrations/moex-iss";
import type { TBankInvestService } from "../integrations/tbank-invest";
import type { TradingViewService } from "../integrations/tradingview";

export interface CocoaReportRequest {
  localSymbolOverride?: string;
  worldSymbolOverride?: string;
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
    private readonly tbankInvestService: TBankInvestService,
    private readonly cbrKeyRateService: CbrKeyRateService,
    private readonly iceCocoaHoursService: IceCocoaHoursService,
    private readonly config: AppConfig
  ) {}

  clearCaches(): void {
    this.tradingViewService.clearCache();
    this.cbrKeyRateService.clearCache();
    this.iceCocoaHoursService.clearCache();
    this.tbankInvestService.clearCache();
  }

  async buildReport(request: CocoaReportRequest = {}): Promise<CocoaReport> {
    await this.assertForeignMarketClosed();
    const localContract = await this.moexIssService.resolveLocalCocoaContract(
      request.localSymbolOverride
    );

    const [localCocoa, usdRub, worldCloseSnapshot] = await Promise.all([
      this.resolveLocalCocoaSnapshot(localContract),
      this.resolveUsdRubSnapshot(),
      this.tradingViewService.getWorldCloseSnapshot({
        localContract,
        worldSymbolOverride: request.worldSymbolOverride
      })
    ]);

    const snapshot: CocoaMarketSnapshot = {
      localCocoa,
      usdRub,
      worldClose: worldCloseSnapshot.worldClose,
      foreignCloseTarget: worldCloseSnapshot.foreignCloseTarget
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

  private async resolveUsdRubSnapshot() {
    if (this.tbankInvestService.isEnabled()) {
      try {
        return await this.tbankInvestService.getUsdRubSnapshot();
      } catch (error) {
        console.warn(
          "[live quotes] Falling back to TradingView for USDRUBF.",
          error
        );
      }
    }

    return this.tradingViewService.getUsdRubSnapshot();
  }

  private async resolveLocalCocoaSnapshot(localContract: CocoaMarketSnapshot["localCocoa"]) {
    if (this.tbankInvestService.isEnabled()) {
      try {
        return await this.tbankInvestService.getLocalCocoaSnapshot(localContract);
      } catch (error) {
        console.warn(
          "[live quotes] Falling back to MOEX ISS for local cocoa contract.",
          error
        );
      }
    }

    return this.moexIssService.getLocalCocoaSnapshot(localContract.symbol);
  }

  private async assertForeignMarketClosed(
    now = DateTime.now().setZone(this.config.marketTimeZone)
  ): Promise<void> {
    if (!this.config.foreignMarketSessionCheckEnabled) {
      return;
    }

    if (!isForeignMarketTradingDay(now, this.config.foreignMarketHolidaysMsk)) {
      return;
    }

    const { marketOpenTime, marketCloseTime } =
      await this.iceCocoaHoursService.buildSession(now);

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
