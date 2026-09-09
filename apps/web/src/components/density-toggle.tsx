'use client';

import { useEffect, useState } from 'react';

type Density = 'comfortable' | 'compact';

/**
 * Table density control (§20.24 "sensible table density controls"). A per-browser preference in
 * localStorage, applied as `data-density` on the document root so the CSS can tighten every table
 * and chip. Wrapped in try/catch: a blocked storage never breaks the shell.
 */
export function DensityToggle() {
  const [density, setDensity] = useState<Density>('comfortable');
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('solmate.density');
      if (stored === 'compact' || stored === 'comfortable') {
        setDensity(stored);
        document.documentElement.dataset['density'] = stored;
      }
    } catch {
      /* storage blocked: keep the default */
    }
  }, []);
  const apply = (next: Density) => {
    setDensity(next);
    document.documentElement.dataset['density'] = next;
    try {
      window.localStorage.setItem('solmate.density', next);
    } catch {
      /* ignore */
    }
  };
  return (
    <button type="button" className="btn" onClick={() => apply(density === 'compact' ? 'comfortable' : 'compact')} aria-pressed={density === 'compact'} title="Table density: comfortable or compact (stored in this browser)">
      {density === 'compact' ? 'DENSITY: COMPACT' : 'DENSITY: COMFORTABLE'}
    </button>
  );
}
