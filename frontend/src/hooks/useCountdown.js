/**
 * A countdown in whole seconds, e.g. "you can ask for another email in 0:45". `start(seconds)`
 * (re)starts it; `secondsLeft` reaches 0 and stays there. The number of seconds always comes from
 * the server (resendAfterSeconds, or retryAfterSeconds on a 429).
 */

import { useCallback, useEffect, useState } from 'react';

const TICK_MS = 1000;

export function useCountdown(initialSeconds = 0) {
  const [endsAtMs, setEndsAtMs] = useState(() => Date.now() + Math.max(0, initialSeconds) * TICK_MS);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const secondsLeft = Math.max(0, Math.ceil((endsAtMs - nowMs) / TICK_MS));

  useEffect(() => {
    if (secondsLeft === 0) return undefined;
    const timer = setInterval(() => setNowMs(Date.now()), TICK_MS / 4);
    return () => clearInterval(timer);
  }, [secondsLeft]);

  const start = useCallback((seconds) => {
    const now = Date.now();
    setNowMs(now);
    setEndsAtMs(now + Math.max(0, seconds) * TICK_MS);
  }, []);

  return { secondsLeft, start };
}

/** 45 -> "00:45", 125 -> "02:05" (as in the sign-in designs). */
export function formatCountdown(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
