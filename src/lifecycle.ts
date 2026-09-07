import type { Logger } from './shared/logger.js';

/**
 * Process lifecycle: signals, shutdown ordering, and the traps around them.
 *
 * One module rather than three copies, because every one of the behaviours below is a bug
 * somebody has shipped, and three near-identical implementations would drift:
 *
 *  - A second SIGTERM restarting shutdown while the first is mid-flight.
 *  - A shutdown that hangs forever because one socket never closed, so the orchestrator
 *    SIGKILLs the process mid-transaction.
 *  - `process.exit()` on the happy path, which truncates in-flight writes.
 *  - An `unhandledRejection` left to Node's default, which in recent versions kills the
 *    process instantly with no teardown at all.
 *
 * This is NOT a process abstraction — the entry points still build their own container and
 * decide their own shutdown order. It only owns the signal plumbing.
 */

export type LifecycleOptions = {
  /** Appears in every lifecycle log line: `api`, `worker`, `scheduler`. */
  processName: string;
  logger: Logger;
  /**
   * Ordered teardown. Called at most once, however many signals arrive.
   *
   * The entry point decides the order — for the API that means draining HTTP before
   * closing the container, which is a decision only the entry point can make.
   */
  shutdown: () => Promise<void>;
  /**
   * Hard deadline. If teardown has not finished by then, the process exits non-zero.
   *
   * Must be LOWER than the orchestrator's termination grace period, or the orchestrator
   * SIGKILLs first and this never runs. Kubernetes defaults to 30s, so 25s leaves room.
   */
  forceExitAfterMs?: number;
};

const DEFAULT_FORCE_EXIT_MS = 25_000;

/**
 * Registers the handlers and returns a disposer that removes exactly the ones it added.
 *
 * A real entry point never calls the disposer — the process is ending anyway. It exists
 * because installing a global `uncaughtException` listener and leaving it there changes the
 * behaviour of everything else in the same process, which makes this function untestable
 * without it. A side effect that cannot be undone is a side effect that cannot be tested.
 */
export function manageLifecycle(opts: LifecycleOptions): () => void {
  const { processName, logger, shutdown } = opts;
  const forceExitAfterMs = opts.forceExitAfterMs ?? DEFAULT_FORCE_EXIT_MS;

  let shuttingDown: Promise<void> | undefined;

  async function run(reason: string): Promise<void> {
    if (shuttingDown) {
      // Not an error: a `docker stop` sends SIGTERM and an impatient operator adds Ctrl-C.
      logger.info({ processName, reason }, 'shutdown_already_in_progress');
      return shuttingDown;
    }

    logger.info({ processName, reason }, 'shutdown_started');

    /**
     * The watchdog. `unref()` is essential: a referenced timer would itself keep the event
     * loop alive for the full 25 seconds, so a process that shut down cleanly in 50ms
     * would still sit there — the timer preventing the exit it exists to guarantee.
     */
    const watchdog = setTimeout(() => {
      logger.fatal({ processName, forceExitAfterMs }, 'shutdown_timed_out_forcing_exit');
      process.exit(1);
    }, forceExitAfterMs);
    watchdog.unref();

    shuttingDown = (async () => {
      try {
        await shutdown();
        logger.info({ processName }, 'shutdown_complete');
      } catch (err) {
        // Report it, but do not rethrow: a failure to close one resource must not prevent
        // the process from exiting, or the orchestrator waits out the grace period.
        logger.error({ err, processName }, 'shutdown_failed');
        process.exitCode = 1;
      } finally {
        clearTimeout(watchdog);
      }
    })();

    return shuttingDown;
  }

  /**
   * SIGTERM is what an orchestrator sends; SIGINT is Ctrl-C.
   *
   * Note what is deliberately absent: `process.exit()` on success. Letting the event loop
   * drain naturally is the only way to know teardown was genuinely complete — an explicit
   * exit would mask a leaked handle, and the leak would then show up as data loss under a
   * real deploy rather than as a hanging process in development.
   */
  const signalHandlers = (['SIGTERM', 'SIGINT'] as const).map((signal) => {
    const handler = (): void => {
      void run(signal);
    };
    process.on(signal, handler);
    return { signal, handler } as const;
  });

  /**
   * A rejected promise nobody handled means the process is in an unknown state. Attempt an
   * orderly teardown, then exit non-zero — continuing would mean serving traffic while
   * some invariant we do not know about is broken.
   */
  const onUnhandledRejection = (reason: unknown): void => {
    logger.fatal({ processName, reason }, 'unhandled_rejection');
    process.exitCode = 1;
    void run('unhandledRejection');
  };

  const onUncaughtException = (err: Error): void => {
    logger.fatal({ err, processName }, 'uncaught_exception');
    process.exitCode = 1;
    void run('uncaughtException');
  };

  process.on('unhandledRejection', onUnhandledRejection);
  process.on('uncaughtException', onUncaughtException);

  return () => {
    for (const { signal, handler } of signalHandlers) {
      process.off(signal, handler);
    }
    process.off('unhandledRejection', onUnhandledRejection);
    process.off('uncaughtException', onUncaughtException);
  };
}

/**
 * Run a startup sequence, closing anything already created if a later step fails.
 *
 * The failure this prevents: `buildContainer()` succeeds, opening a database pool and a
 * Redis connection, and then `server.listen()` fails because the port is taken. Without
 * cleanup the process exits with those handles still open — which in practice means it does
 * NOT exit, it hangs, and an orchestrator reports a start-up timeout instead of "port in
 * use". The real error never reaches anyone.
 */
export async function startOrCleanUp<T>(args: {
  logger: Logger;
  processName: string;
  start: () => Promise<T>;
  cleanUp: () => Promise<void>;
}): Promise<T> {
  try {
    return await args.start();
  } catch (err) {
    args.logger.fatal({ err, processName: args.processName }, 'startup_failed');
    try {
      await args.cleanUp();
    } catch (cleanupErr) {
      // Logged separately so the ORIGINAL failure stays the headline. A cleanup error
      // reported on its own has sent people looking in entirely the wrong place.
      args.logger.error(
        { err: cleanupErr, processName: args.processName },
        'startup_cleanup_failed',
      );
    }
    // Explicit exit is correct here, unlike on the success path: the process never reached
    // a working state, and there is nothing to drain.
    process.exit(1);
  }
}
