import { useSyncExternalStore } from 'react';

/**
 * Console mode: live, or a historical replay.
 *
 * Kept outside React so the shell (Zone 1) and the replay workspace (Zone 4) read one answer. The
 * shell turns it into `data-mode="replay"` on its root, which is what repaints the top bar violet and
 * raises the `HISTORICAL REPLAY` badge (design system §7): the cue lives in a token override, not in
 * conditional classes a new page could forget.
 */
export interface ConsoleMode {
  mode: 'live' | 'replay';
  /** Replay transport state; meaningless in live mode. */
  paused: boolean;
  speed: number;
  /** Replay cursor (simulator ms), shown in Zone 1 in place of the live clock. */
  cursor: number | null;
}

const LIVE: ConsoleMode = { mode: 'live', paused: false, speed: 1, cursor: null };

let current: ConsoleMode = LIVE;
let exitHandler: (() => void) | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): ConsoleMode {
  return current;
}

export function setConsoleMode(next: ConsoleMode | null): void {
  const value = next ?? LIVE;
  if (
    value.mode === current.mode &&
    value.paused === current.paused &&
    value.speed === current.speed &&
    value.cursor === current.cursor
  ) {
    return;
  }
  current = value;
  for (const listener of [...listeners]) listener();
}

/** The replay workspace registers how to leave history; Zone 1's `LIVE` button calls it. */
export function setLiveExit(handler: (() => void) | null): void {
  exitHandler = handler;
}

export function returnToLive(): void {
  if (exitHandler) exitHandler();
  else setConsoleMode(null);
}

export function useConsoleMode(): ConsoleMode {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** `HISTORICAL REPLAY — PAUSED` / `— 2x`, exactly as the guide spells it. */
export function replayBadgeText(mode: Pick<ConsoleMode, 'paused' | 'speed'>): string {
  return `HISTORICAL REPLAY \u2014 ${mode.paused ? 'PAUSED' : `${mode.speed}x`}`;
}
