import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * Wraps an async route handler so a rejected promise reaches the terminal error
 * middleware instead of vanishing.
 *
 * Express 5 forwards rejections from async handlers natively, unlike Express 4. This
 * wrapper is kept anyway, for three reasons:
 *
 *  1. It is explicit at the call site. A reader sees that error routing is handled,
 *     rather than having to know which major version of Express is in play.
 *  2. It survives a downgrade or a change of router. Relying on framework behaviour that
 *     silently differs between versions is how "why is this request hanging" happens.
 *  3. A Step 8 lint rule bans bare `async` route handlers, and this is the sanctioned
 *     escape. One obvious wrapper beats a `try/catch` in every controller — and a
 *     forgotten `try/catch` leaves the client waiting until the socket times out.
 *
 * Note the deliberate absence of a `catch` that logs: swallowing here would mean two
 * places decide error policy. The terminal middleware is the only one that does.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    // `void` on the promise is intentional: the rejection path is `next(err)`, and
    // returning the promise to Express would have it awaited twice in some versions.
    void handler(req, res, next).catch(next);
  };
}
