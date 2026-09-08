'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Global pause control (§20.2, §20.21): one click requests PAUSE_NEW_ENTRIES with no confirmation
 * (accidental activation is low-risk; exits and protection are never paused). On desktop the same
 * request fires when Shift+P is held for one second from any route; the hold is drawn on this
 * control so the operator sees it filling and can release to cancel. The request itself is the
 * server action passed in: the browser never executes a control, it inserts a request row.
 */
export const PAUSE_HOLD_MS = 1000;

export function PauseControl({ action, disabled }: { action: () => Promise<void>; disabled: boolean }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [progress, setProgress] = useState(0);
  const holdStart = useRef<number | null>(null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (disabled) return;
    const tick = () => {
      if (holdStart.current === null) return;
      const p = Math.min(1, (performance.now() - holdStart.current) / PAUSE_HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        holdStart.current = null;
        setProgress(0);
        formRef.current?.requestSubmit();
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    const isTypingTarget = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const down = (e: KeyboardEvent) => {
      if (!(e.shiftKey && (e.key === 'P' || e.key === 'p'))) return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      if (holdStart.current !== null) return; // key repeat while holding
      holdStart.current = performance.now();
      raf.current = requestAnimationFrame(tick);
    };
    const cancel = (e?: KeyboardEvent) => {
      if (e && !(e.key === 'P' || e.key === 'p' || e.key === 'Shift')) return;
      holdStart.current = null;
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
      setProgress(0);
    };
    const blur = () => cancel();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', cancel);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', cancel);
      window.removeEventListener('blur', blur);
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [disabled]);

  const holding = progress > 0;
  return (
    <form ref={formRef} action={action} style={{ display: 'inline' }}>
      <button
        className="btn danger pause-hold"
        type="submit"
        disabled={disabled}
        title="Requests PAUSE_NEW_ENTRIES; exits and protection are never paused. Desktop: hold Shift+P for one second."
        aria-label={holding ? `Hold to pause: ${Math.round(progress * 100)}%` : 'Pause new entries (Shift+P held one second)'}
        style={{ backgroundImage: holding ? `linear-gradient(90deg, var(--failed) ${progress * 100}%, transparent ${progress * 100}%)` : undefined, color: holding && progress > 0.5 ? 'var(--surface)' : undefined }}
      >
        {holding ? 'HOLD…' : 'PAUSE'}
      </button>
    </form>
  );
}
