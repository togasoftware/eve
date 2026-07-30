import { afterEach, describe, expect, it, vi } from "vitest";

import { cancelTurnUntilAdmitted } from "#client/cancel-turn-until-admitted.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("cancelTurnUntilAdmitted", () => {
  it("returns immediately when cancellation is admitted", async () => {
    const cancel = vi.fn().mockResolvedValue({
      sessionId: "session_1",
      status: "accepted",
    });

    await expect(
      cancelTurnUntilAdmitted({
        cancel,
        isActive: () => true,
      }),
    ).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retries transient outcomes until cancellation is admitted", async () => {
    vi.useFakeTimers();
    const cancel = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "session_1",
        status: "no_active_turn",
      })
      .mockRejectedValueOnce(new Error("Transport failed"))
      .mockResolvedValueOnce({
        sessionId: "session_1",
        status: "accepted",
      });

    const result = cancelTurnUntilAdmitted({
      cancel,
      isActive: () => true,
    });
    await vi.advanceTimersByTimeAsync(500);

    await expect(result).resolves.toBe(true);
    expect(cancel).toHaveBeenCalledTimes(3);
  });

  it("stops retrying when the observed turn is no longer active", async () => {
    vi.useFakeTimers();
    let active = true;
    const cancel = vi.fn(async () => {
      active = false;
      return {
        sessionId: "session_1",
        status: "no_active_turn" as const,
      };
    });

    const result = cancelTurnUntilAdmitted({
      cancel,
      isActive: () => active,
    });
    await vi.advanceTimersByTimeAsync(250);

    await expect(result).resolves.toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
