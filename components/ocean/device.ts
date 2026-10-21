import type { QualityTier } from './state';

/** Coarse device classification, evaluated once in the browser. */
export interface DeviceProfile {
  /** Phone-class device: weaker GPU, tighter thermal budget (drives DPR / tiers). */
  mobile: boolean;
  /** Primary input is a finger (phones *and* touch tablets): drives the hint text. */
  touchFirst: boolean;
  /** Device-pixel-ratio clamp handed to the canvas. */
  dpr: [number, number];
  /** Highest quality tier this class of device is allowed to climb to. */
  maxTier: QualityTier;
  /** Tier to start at before the performance monitor has measured anything. */
  startTier: QualityTier;
  /** Frame-rate cap. Rendering faster than this only produces heat. */
  maxFps: number;
}

export function detectDevice(): DeviceProfile {
  if (typeof window === 'undefined')
    return { mobile: false, touchFirst: false, dpr: [1, 2], maxTier: 2, startTier: 2, maxFps: 60 };
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const noHover = window.matchMedia?.('(hover: none)').matches ?? false;
  const touch = navigator.maxTouchPoints > 0;
  const touchFirst = touch && (coarse || noHover);
  const smallScreen = Math.min(window.screen.width, window.screen.height) < 820;
  const mobile = coarse && touch && smallScreen;
  return mobile
    ? { mobile, touchFirst, dpr: [1, 1.5], maxTier: 1, startTier: 1, maxFps: 60 }
    : { mobile, touchFirst, dpr: [1, 2], maxTier: 2, startTier: 2, maxFps: 60 };
}

export interface UrlOptions {
  /** `?debug` shows the leva panel in production builds too. */
  debug: boolean;
  /** `?quality=low|medium|high` pins the tier and disables adaptive quality. */
  quality: QualityTier | null;
}

export function readUrlOptions(): UrlOptions {
  if (typeof window === 'undefined') return { debug: false, quality: null };
  const q = new URLSearchParams(window.location.search);
  const quality = q.get('quality');
  const tiers: Record<string, QualityTier> = { low: 0, medium: 1, high: 2 };
  return {
    debug: q.has('debug'),
    quality: quality && quality in tiers ? tiers[quality] : null,
  };
}
