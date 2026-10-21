'use client';

import dynamic from 'next/dynamic';
import { Component, useEffect, useReducer, useState, type ReactNode } from 'react';
import Overlay from './Overlay';
import { detectDevice, readUrlOptions, type DeviceProfile, type UrlOptions } from './ocean/device';
import { OceanAudio } from './ocean/OceanAudio';
import { OceanState } from './ocean/state';

// WebGL only exists in the browser: never render the scene on the server.
const Scene = dynamic(() => import('./ocean/Scene'), { ssr: false });
// The leva panel is a separate chunk that is only fetched when it is shown.
const DebugControls = dynamic(() => import('./ocean/DebugControls'), { ssr: false });

function hasWebGL2(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <Unsupported /> : this.props.children;
  }
}

function Unsupported() {
  return (
    <div className="unsupported">
      <p>The glowing sea needs WebGL 2.</p>
      <p className="unsupported__sub">Try a recent version of Chrome, Firefox, Safari or Edge.</p>
    </div>
  );
}

interface ClientEnv {
  device: DeviceProfile;
  url: UrlOptions;
  webgl: boolean;
}

export default function OceanExperience() {
  const [ocean] = useState(() => new OceanState());
  // The AudioContext itself is only created when the user turns sound on.
  const [audio] = useState(() => new OceanAudio());
  const [env, setEnv] = useState<ClientEnv | null>(null);
  const [ready, setReady] = useState(false);
  const [revision, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    setEnv({ device: detectDevice(), url: readUrlOptions(), webgl: hasWebGL2() });
  }, []);

  useEffect(() => {
    ocean.audio = audio;
    return () => {
      ocean.audio = null;
      audio.dispose();
    };
  }, [ocean, audio]);

  useEffect(() => {
    // Handy for poking at the scene from the dev-tools console.
    if (process.env.NODE_ENV !== 'production') (window as unknown as { __ocean: OceanState }).__ocean = ocean;
  }, [ocean]);

  const showDebug = env !== null && (process.env.NODE_ENV !== 'production' || env.url.debug);

  return (
    <main className={`ocean-root${ready ? ' ocean-root--ready' : ''}`}>
      {env && !env.webgl && <Unsupported />}
      {env?.webgl && (
        <SceneBoundary>
          <Scene
            ocean={ocean}
            device={env.device}
            pinnedTier={env.url.quality}
            revision={revision}
            onReady={() => setReady(true)}
          />
        </SceneBoundary>
      )}
      <Overlay ocean={ocean} audio={audio} mobile={env ? env.device.mobile : null} />
      {showDebug && <DebugControls ocean={ocean} onRerender={rerender} />}
    </main>
  );
}
