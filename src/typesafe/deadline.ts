export class RequestCancelledError extends Error {
  constructor(readonly kind: "timeout" | "aborted") {
    super(kind);
    this.name = "RequestCancelledError";
  }
}

export async function withinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { deadlineMs: number; signal?: AbortSignal | undefined },
): Promise<T> {
  const controller = new AbortController();
  const cancelled = Promise.withResolvers<never>();
  const abort = () => {
    controller.abort(new RequestCancelledError("aborted"));
  };
  const reject = () => {
    cancelled.reject(controller.signal.reason);
  };
  controller.signal.addEventListener("abort", reject, { once: true });
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new RequestCancelledError("timeout")),
    options.deadlineMs,
  );
  if (options.signal?.aborted) abort();
  try {
    const request = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    });
    return await Promise.race([request, cancelled.promise]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", reject);
  }
}
