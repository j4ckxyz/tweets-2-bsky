import { useSyncExternalStore } from 'react';
import { useDashboard } from '../lib/dashboard-context';

// One shared one-second clock. Only the countdown text subscribes to it, so
// the rest of the dashboard does not re-render every second.
let now = Date.now();
let timer: number | null = null;
const listeners = new Set<() => void>();

function subscribeToClock(listener: () => void) {
  if (listeners.size === 0) {
    now = Date.now();
    timer = window.setInterval(() => {
      now = Date.now();
      for (const notify of listeners) notify();
    }, 1000);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}

const ignoreClock = () => () => {};

/** Time until the next scheduled check, shown on Overview; "--" elsewhere. */
export function Countdown() {
  const { activeTab, status } = useDashboard();
  const nextCheckTime = status?.nextCheckTime;
  const ticking = activeTab === 'overview' && Boolean(nextCheckTime);
  const currentTime = useSyncExternalStore(ticking ? subscribeToClock : ignoreClock, () => now);

  if (!ticking || !nextCheckTime) {
    return '--';
  }
  const ms = nextCheckTime - currentTime;
  if (ms <= 0) {
    return 'Checking...';
  }
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}
