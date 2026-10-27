export function nowIso(): string {
  return new Date().toISOString();
}

export function isoAfterSeconds(seconds: number, from: Date = new Date()): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}
