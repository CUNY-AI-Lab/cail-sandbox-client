const MAX_TIMEOUT_MS = 2_147_483_647;

export async function withAbortDeadline<T>(
  milliseconds: number,
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `milliseconds must be an integer between 1 and ${MAX_TIMEOUT_MS}`,
    );
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new DOMException(
        `${label} exceeded ${milliseconds}ms`,
        "TimeoutError",
      );
      controller.abort(reason);
      reject(reason);
    }, milliseconds);
  });

  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
