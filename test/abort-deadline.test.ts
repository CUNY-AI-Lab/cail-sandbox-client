import { expect, test } from "bun:test";
import { withAbortDeadline } from "../scripts/abort-deadline.js";

test("deadline aborts the underlying operation before rejecting", async () => {
  let observedAbort = false;
  const error = await withAbortDeadline(5, "failure injection", async (signal) => {
    return await new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => {
          observedAbort = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }).catch((caught) => caught);

  expect(observedAbort).toBeTrue();
  expect(error).toMatchObject({
    name: "TimeoutError",
    message: "failure injection exceeded 5ms",
  });
});

test("deadline returns a completed operation without a late abort", async () => {
  let signal!: AbortSignal;
  const result = await withAbortDeadline(50, "quick operation", async (active) => {
    signal = active;
    return "done";
  });
  expect(result).toBe("done");
  await Bun.sleep(60);
  expect(signal.aborted).toBeFalse();
});
