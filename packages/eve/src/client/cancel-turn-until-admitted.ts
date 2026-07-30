import type { CancelSessionResult } from "#client/types.js";

const cancelAttempts = 8;
const cancelRetryDelayMs = 250;

/**
 * Retries cooperative turn cancellation until the server admits it, the turn
 * stops being active, or the bounded attempt budget is exhausted.
 *
 * A transient `no_active_turn` or transport failure is retried without
 * changing the observed turn's error state. Resolves `true` only when the
 * server admitted cancellation.
 */
export async function cancelTurnUntilAdmitted(input: {
  readonly cancel: () => Promise<CancelSessionResult>;
  readonly isActive: () => boolean;
}): Promise<boolean> {
  for (let attempt = 0; attempt < cancelAttempts; attempt += 1) {
    if (attempt > 0) {
      await delay(cancelRetryDelayMs);
    }
    if (!input.isActive()) {
      return false;
    }

    try {
      const result = await input.cancel();
      if (result.status === "accepted") {
        return true;
      }
    } catch {
      // The turn stream stays authoritative; a failed admission is not a turn
      // failure.
    }
  }

  return false;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
