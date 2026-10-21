'use client';

import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { OceanState } from './ocean/state';

// WebGL only exists in the browser: never render the scene on the server.
const Scene = dynamic(() => import('./ocean/Scene'), { ssr: false });

export default function OceanExperience() {
  const [ocean] = useState(() => new OceanState());

  useEffect(() => {
    // Handy for poking at the scene from the dev-tools console.
    if (process.env.NODE_ENV !== 'production') (window as unknown as { __ocean: OceanState }).__ocean = ocean;
  }, [ocean]);
  return (
    <main className="ocean-root">
      <Scene ocean={ocean} />
    </main>
  );
}
