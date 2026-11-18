/**
 * Runs once when the server starts. It starts the expiry sweep: every few minutes, expired
 * sessions and all their ciphertext are deleted (not just flagged).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startSweeper } = await import("./server/sweeper");
  startSweeper();
}
