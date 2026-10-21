'use client';

import { useEffect, useState } from 'react';
import type { OceanAudio } from './ocean/OceanAudio';
import type { OceanState } from './ocean/state';

export interface OverlayProps {
  ocean: OceanState;
  audio: OceanAudio;
  /** null until the device has been detected on the client. */
  mobile: boolean | null;
}

/** Minimal UI over the scene: a hint that fades once the water is touched, and a sound toggle. */
export default function Overlay({ ocean, audio, mobile }: OverlayProps) {
  const [touched, setTouched] = useState(false);
  const [sound, setSound] = useState(false);

  useEffect(() => ocean.onFirstInteraction(() => window.setTimeout(() => setTouched(true), 1800)), [ocean]);

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    void audio.setEnabled(next);
  };

  return (
    <div className="overlay">
      {mobile !== null && (
        <p className={`hint${touched ? ' hint--hidden' : ''}`} aria-live="polite">
          <span className="hint__main">{mobile ? 'drag a finger across the water' : 'move across the water to touch it'}</span>
          <span className="hint__sub">
            {mobile ? 'tap to splash · two fingers to look around' : 'click to splash · drag to look around'}
          </span>
        </p>
      )}
      <button
        type="button"
        className="sound-toggle"
        onClick={toggleSound}
        aria-pressed={sound}
        aria-label={sound ? 'Mute ocean sound' : 'Play ocean sound'}
        title={sound ? 'Mute' : 'Sound'}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />
          {sound ? (
            <path
              d="M15.5 8.5c1 1 1.5 2.2 1.5 3.5s-.5 2.5-1.5 3.5M18 6c1.7 1.6 2.5 3.6 2.5 6s-.8 4.4-2.5 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          ) : (
            <path d="M16 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          )}
        </svg>
      </button>
    </div>
  );
}
