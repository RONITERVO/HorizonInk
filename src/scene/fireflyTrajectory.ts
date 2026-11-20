import type { FireflyCandidate } from "../types";

export const FIREFLY_CAMERA_Z = 0.38;
export const FIREFLY_FAR_DIST = 34.0;
// 1.88m in front of camera puts z = -1.50, clearly behind the A4 paper (-0.70) and cliff edge (-1.33)
export const FIREFLY_CATCH_DIST = 1.88;
export const FIREFLY_BASE_BADGE_HEIGHT = 0.162;
export const FIREFLY_ORIGIN_Z = FIREFLY_CAMERA_Z - FIREFLY_FAR_DIST;
export const FIREFLY_CATCH_Z = FIREFLY_CAMERA_Z - FIREFLY_CATCH_DIST;

export interface FireflyDepthSample {
  progress: number;
  clampedApproach: number;
  dist: number;
  z: number;
  badgeWorldHeight: number;
  apparentScale: number;
  renderOrder: number;
}

/**
 * Computes safe horizontal half-width in meters at the canonical behind-paper plane
 * for the active camera FOV (56 deg) so badges spread gracefully across any screen width.
 */
export function computeSafeHalfSpreadX(aspect: number): number {
  const safeAspect = Math.max(0.55, Math.min(2.6, Number.isFinite(aspect) ? aspect : 16 / 9));
  const halfH = FIREFLY_CATCH_DIST * Math.tan((56 * Math.PI) / 360);
  const halfW = halfH * safeAspect;
  return Math.max(0.28, halfW * 0.68 - 0.12);
}

/**
 * Evaluates a firefly's depth solely from (idealTime - songTime) / flightSeconds.
 * At idealTime (progress = 1), the firefly sits cleanly behind the A4 paper & cliff desk at z = -1.50;
 * afterwards (progress > 1) it keeps gliding smoothly past the paper and past the camera.
 */
export function evaluateFireflyDepth(
  songTime: number,
  idealTime: number,
  flightSeconds: number,
): FireflyDepthSample {
  const safeFlight = Math.max(0.5, flightSeconds);
  const progress = 1 - (idealTime - songTime) / safeFlight;
  const clampedApproach = Math.max(0, Math.min(1, progress));

  let dist: number;
  if (progress <= 1) {
    const rawDist = FIREFLY_FAR_DIST * Math.pow(FIREFLY_CATCH_DIST / FIREFLY_FAR_DIST, progress);
    dist = Math.min(FIREFLY_FAR_DIST * 1.4, rawDist);
  } else {
    // Match exact arrival velocity at progress = 1 so fireflies glide past the camera smoothly
    const passSlope = FIREFLY_CATCH_DIST * Math.log(FIREFLY_FAR_DIST / FIREFLY_CATCH_DIST);
    dist = FIREFLY_CATCH_DIST - (progress - 1) * passSlope;
  }

  const z = FIREFLY_CAMERA_Z - dist;
  const scaleDist = Math.max(0.55, dist);
  const badgeWorldHeight = FIREFLY_BASE_BADGE_HEIGHT * Math.pow(scaleDist / FIREFLY_CATCH_DIST, 0.52);
  const apparentScale = badgeWorldHeight / scaleDist;
  const renderOrder = Math.round(1000 + (FIREFLY_FAR_DIST - dist) * 40);
  return {
    progress,
    clampedApproach,
    dist,
    z,
    badgeWorldHeight,
    apparentScale,
    renderOrder,
  };
}

/**
 * Computes 3D world position for a flying firefly. Z is driven strictly by
 * evaluateFireflyDepth() while X/Y converge gracefully behind the A4 paper.
 */
export function computeFireflyPosition(
  cand: Pick<
    FireflyCandidate,
    | "idealTime"
    | "flightSeconds"
    | "originX"
    | "originY"
    | "catchX"
    | "catchY"
    | "swayFreq"
    | "swayPhase"
    | "swayAmpX"
    | "swayAmpY"
  >,
  songTime: number,
  elapsed: number,
): { x: number; y: number; z: number; depth: FireflyDepthSample } {
  const depth = evaluateFireflyDepth(songTime, cand.idealTime, cand.flightSeconds);
  const ease = 1 - Math.pow(1 - depth.clampedApproach, 1.65);
  const passFlare = Math.max(0, depth.progress - 1);
  const swayScale = 1 - Math.min(0.75, ease * 0.6);

  const x =
    cand.originX +
    (cand.catchX - cand.originX) * ease +
    cand.catchX * passFlare * 0.14 +
    Math.sin(elapsed * cand.swayFreq + cand.swayPhase) * cand.swayAmpX * swayScale;
  const y =
    cand.originY +
    (cand.catchY - cand.originY) * ease +
    Math.sin(depth.clampedApproach * Math.PI) * 0.18 +
    Math.cos(elapsed * cand.swayFreq * 1.3 + cand.swayPhase) * cand.swayAmpY * swayScale;

  return { x, y, z: depth.z, depth };
}
