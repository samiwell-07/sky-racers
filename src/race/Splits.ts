import type { GhostData } from './Ghost';

/** What the split display shows (one comparison, kept until the next gate). */
export type SplitState =
  /** No compatible reference ghost for this race. */
  | { kind: 'no-reference'; reason: string }
  /** A reference exists but no gate has been reached yet. */
  | { kind: 'pending' }
  | { kind: 'delta'; ms: number; lap: number; gate: number; missed: boolean }
  /** The reference cannot be compared at this gate (e.g. a legacy ghost without penalty history). */
  | { kind: 'unavailable'; lap: number; gate: number; reason: string };

/**
 * Signed difference of cumulative scoring times at the same gate, in whole milliseconds
 * (negative = player ahead). Rounded half away from zero so equal gaps look the same either way.
 */
export function splitDeltaMs(playerElapsed: number, playerPenalties: number, ghostElapsed: number, ghostPenalties: number): number {
  const d = (playerElapsed + playerPenalties - ghostElapsed - ghostPenalties) * 1000;
  const ms = Math.sign(d) * Math.round(Math.abs(d));
  return ms === 0 ? 0 : ms;
}

/** Compares the player's gate `index` (flat across laps) with the reference ghost's same gate. */
export function compareWithGhost(
  ghost: GhostData,
  index: number,
  playerElapsed: number,
  playerPenalties: number,
): { kind: 'delta'; ms: number } | { kind: 'unavailable'; reason: string } {
  if (!ghost.penalties) return { kind: 'unavailable', reason: 'reference has no penalty history' };
  const ge = ghost.splits[index];
  const gp = ghost.penalties[index];
  if (ge === undefined || gp === undefined) return { kind: 'unavailable', reason: 'reference has no time for this gate' };
  return { kind: 'delta', ms: splitDeltaMs(playerElapsed, playerPenalties, ge, gp) };
}

/** "-125 ms | AHEAD", "+340 ms | BEHIND", "0 ms | EVEN". */
export function formatSplitMs(ms: number): string {
  if (ms < 0) return `-${-ms} ms | AHEAD`;
  if (ms > 0) return `+${ms} ms | BEHIND`;
  return '0 ms | EVEN';
}

/** Text + tone for the split display. */
export function describeSplit(s: SplitState): { text: string; label: string; tone: 'ahead' | 'behind' | 'even' | 'none' } {
  switch (s.kind) {
    case 'no-reference':
      return { text: 'No reference', label: s.reason, tone: 'none' };
    case 'pending':
      return { text: 'No split yet', label: 'vs best ghost', tone: 'none' };
    case 'unavailable':
      return { text: 'Split unavailable', label: `Lap ${s.lap} · Gate ${s.gate} – ${s.reason}`, tone: 'none' };
    case 'delta':
      return {
        text: formatSplitMs(s.ms),
        label: `Lap ${s.lap} · Gate ${s.gate}${s.missed ? ' (missed)' : ''}`,
        tone: s.ms < 0 ? 'ahead' : s.ms > 0 ? 'behind' : 'even',
      };
  }
}

/** Race clock M:SS.mmm (e.g. 1:24.583). */
export function formatRaceClock(seconds: number): string {
  const total = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const ms = total % 1000;
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
