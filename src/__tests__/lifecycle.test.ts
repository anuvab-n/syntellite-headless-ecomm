import { afterEach, describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../../tests/helpers/postgres.ts';
import { manageLifecycle } from '../lifecycle.js';

/**
 * Signal coordination.
 *
 * `process.emit('SIGTERM')` invokes the registered handler exactly as the OS would, without
 * needing a real signal — which matters because Windows has no POSIX signals and a
 * child-process test would silently exercise a hard kill instead of a graceful one.
 *
 * Every test disposes its handlers. Leaving an `uncaughtException` listener installed would
 * change the behaviour of every later test in the run.
 */
describe('manageLifecycle', () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    disposers.splice(0).forEach((dispose) => {
      dispose();
    });
    // The failure paths deliberately set a non-zero exit code; left set, it would fail the
    // whole vitest run at the end for no reason.
    process.exitCode = 0;
  });

  function install(shutdown: () => Promise<void>, forceExitAfterMs?: number): void {
    const dispose = manageLifecycle({
      processName: 'test',
      logger: silentLogger,
      shutdown,
      ...(forceExitAfterMs !== undefined ? { forceExitAfterMs } : {}),
    });
    disposers.push(dispose);
  }

  /** Signal handlers are sync; give the async shutdown a turn to run. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

  it('runs shutdown on SIGTERM', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    install(shutdown);

    process.emit('SIGTERM');
    await settle();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('runs shutdown on SIGINT', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    install(shutdown);

    process.emit('SIGINT');
    await settle();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('is idempotent across repeated signals', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    install(shutdown);

    process.emit('SIGTERM');
    process.emit('SIGTERM');
    process.emit('SIGTERM');
    await settle();

    // Running teardown twice would double-close the pool and throw during shutdown.
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('runs shutdown once when SIGTERM and SIGINT arrive together', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    install(shutdown);

    // `docker stop` sends SIGTERM; an impatient operator adds Ctrl-C. Both, same tick.
    process.emit('SIGTERM');
    process.emit('SIGINT');
    await settle();

    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('does not start a second shutdown while the first is still running', async () => {
    let resolveShutdown: (() => void) | undefined;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        }),
    );
    install(shutdown);

    process.emit('SIGTERM');
    await settle();
    expect(shutdown).toHaveBeenCalledTimes(1);

    // A second signal arriving mid-teardown must join the first, not restart it — a
    // restarted teardown closes resources the first pass is still using.
    process.emit('SIGINT');
    await settle();
    expect(shutdown).toHaveBeenCalledTimes(1);

    resolveShutdown?.();
    await settle();
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it('survives a shutdown that throws, and marks the exit code', async () => {
    const shutdown = vi.fn().mockRejectedValue(new Error('redis refused to close'));
    install(shutdown);

    process.emit('SIGTERM');
    await settle();

    // Must not rethrow: an unhandled rejection here would kill the process before the
    // remaining resources were released.
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('does not call process.exit on a successful shutdown', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const shutdown = vi.fn().mockResolvedValue(undefined);
    install(shutdown);

    process.emit('SIGTERM');
    await settle();

    /**
     * The happy path must let the event loop drain naturally. An explicit exit would
     * truncate in-flight writes AND mask a leaked handle — the leak then surfaces as data
     * loss during a real deploy instead of as a hanging process in development.
     */
    expect(exit).not.toHaveBeenCalled();
    exit.mockRestore();
  });

  it('forces exit when shutdown exceeds its deadline', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    // A teardown that never resolves — a socket that will not close.
    install(() => new Promise<void>(() => undefined), 50);

    process.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Without the watchdog the orchestrator waits out its grace period and then SIGKILLs
    // mid-transaction. Exiting non-zero ourselves is the lesser evil and is diagnosable.
    expect(exit).toHaveBeenCalledWith(1);
    exit.mockRestore();
  });

  it('triggers shutdown on an unhandled rejection', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    install(shutdown);

    // Node's default for this is to kill the process with no teardown at all.
    process.emit('unhandledRejection', new Error('boom'), Promise.resolve());
    await settle();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  });

  it('removes every handler it installed when disposed', () => {
    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
      rejection: process.listenerCount('unhandledRejection'),
      exception: process.listenerCount('uncaughtException'),
    };

    const dispose = manageLifecycle({
      processName: 'test',
      logger: silentLogger,
      shutdown: () => Promise.resolve(),
    });

    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
    dispose();

    // Exactly the handlers it added, and no others — `removeAllListeners` would strip
    // vitest's own.
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('unhandledRejection')).toBe(before.rejection);
    expect(process.listenerCount('uncaughtException')).toBe(before.exception);
  });
});
