export interface CocoaCalculationInput {
  usdRubRate: number;
  fairBasisUsd: number;
  worldCloseUsd: number;
  localPriceRub: number;
}

export interface CocoaCalculationResult {
  usdRubRate: number;
  fairBasisUsd: number;
  worldCloseUsd: number;
  fairWorldPriceUsd: number;
  fairLocalPriceRub: number;
  localPriceRub: number;
  localPriceUsd: number;
  currentBasisUsd: number;
  basisDeviationUsd: number;
  rubDeviationFromFairPrice: number;
}

export function calculateCocoaSpread(
  input: CocoaCalculationInput
): CocoaCalculationResult {
  const fairWorldPriceUsd = input.worldCloseUsd + input.fairBasisUsd;
  const fairLocalPriceRub = (input.usdRubRate * fairWorldPriceUsd) / 1000;
  const localPriceUsd = (input.localPriceRub * 1000) / input.usdRubRate;
  const currentBasisUsd = localPriceUsd - input.worldCloseUsd;
  const basisDeviationUsd = currentBasisUsd - input.fairBasisUsd;
  const rubDeviationFromFairPrice = input.localPriceRub - fairLocalPriceRub;

  return {
    usdRubRate: input.usdRubRate,
    fairBasisUsd: input.fairBasisUsd,
    worldCloseUsd: input.worldCloseUsd,
    fairWorldPriceUsd,
    fairLocalPriceRub,
    localPriceRub: input.localPriceRub,
    localPriceUsd,
    currentBasisUsd,
    basisDeviationUsd,
    rubDeviationFromFairPrice
  };
}
