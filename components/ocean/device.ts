/** Coarse device classification, evaluated once in the browser. */
export interface DeviceProfile {
  /** Phone / tablet: touch-first, weaker GPU, tighter thermal budget. */
  mobile: boolean;
  /** Device-pixel-ratio clamp handed to the canvas. */
  dpr: [number, number];
}

export function detectDevice(): DeviceProfile {
  if (typeof window === 'undefined') return { mobile: false, dpr: [1, 2] };
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const touch = navigator.maxTouchPoints > 0;
  const smallScreen = Math.min(window.screen.width, window.screen.height) < 820;
  const mobile = coarse && touch && smallScreen;
  return { mobile, dpr: mobile ? [1, 1.5] : [1, 2] };
}
