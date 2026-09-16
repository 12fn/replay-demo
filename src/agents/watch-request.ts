/** Classifies free-watch requests consistently; the server validates the actual objective. */
export function isWatchRequest(message: string): boolean {
  return /\b(?:watch|monitor|alert|notify|constantly)\b|\bkeep\b.*\b(?:track|eye)\b/i.test(message);
}
