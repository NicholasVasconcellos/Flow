import React from 'react';

// Compact relative time: "now", "5s", "12m", "3h", "2d". No "ago" suffix.
export function fmtRelative(input, now = Date.now()) {
  if (!input) return '';
  const then = typeof input === 'number' ? input : new Date(input).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Math.max(0, now - then);
  const s = Math.round(diff / 1000);
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  return `${d}d`;
}

// Verbose variant retained for log column, which historically uses " ago".
export function fmtRelativeAgo(input, now = Date.now()) {
  if (!input) return '';
  const then = typeof input === 'number' ? input : new Date(input).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Math.max(0, now - then);
  const s = Math.round(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// "MM/DD HH:MM" (local). Empty string for invalid.
export function fmtAbsolute(input) {
  if (!input) return '';
  const d = typeof input === 'number' ? new Date(input) : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Re-render hook so relative timestamps refresh without remounting consumers.
export function useNowTick(intervalMs = 30_000) {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick(t => (t + 1) % 1_000_000), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
