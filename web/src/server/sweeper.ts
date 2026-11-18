import "server-only";
import { config } from "./config";
import { db } from "./db";
import { limiter } from "./rate-limit";
import { sweep } from "./store";

const globalForSweeper = globalThis as unknown as { kaizenSweeper?: NodeJS.Timeout };

export function sweepOnce(now = Date.now()): number {
  const removed = sweep(db(), now);
  limiter().prune(now);
  return removed;
}

export function startSweeper() {
  if (globalForSweeper.kaizenSweeper) return;
  const tick = () => {
    try {
      const removed = sweepOnce();
      if (removed > 0) console.log(`[kaizen] sweep removed ${removed} expired session(s)`);
    } catch (error) {
      console.error("[kaizen] sweep failed:", error instanceof Error ? error.message : "unknown");
    }
  };
  tick(); // clear anything that expired while the server was down
  globalForSweeper.kaizenSweeper = setInterval(tick, config().sweepIntervalSeconds * 1000);
  globalForSweeper.kaizenSweeper.unref();
}
