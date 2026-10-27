/**
 * Exponential backoff with jitter: 1m, 2m, 4m, 8m, 16m ... capped at 1h.
 * `attempt` is the number of attempts already made (1 after the first try).
 */
export function computeBackoffSeconds(attempt: number, random: () => number = Math.random): number {
  const base = 60;
  const cap = 60 * 60;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(random() * Math.min(30, exp * 0.2));
  return Math.min(cap, exp + jitter);
}
