// Shared wrapper for callable functions.
//
// Lives in its own module so the tests can import it. A test file at the repo
// root cannot resolve the bare specifier "firebase-functions" — that package
// is installed under functions/node_modules — but a module in this directory
// resolves it normally, and the test imports this file rather than the package.

import { HttpsError } from 'firebase-functions/v2/https';
import * as logger from 'firebase-functions/logger';

export { HttpsError };

/**
 * Wrap a callable so an unexpected throw cannot reach the browser as the bare
 * code "internal".
 *
 * The client SDK reports "internal" for two very different situations: the
 * function crashed, or the request never arrived (wrong region, CORS, no
 * deploy). Those need opposite fixes, and telling them apart cost several
 * rounds of debugging. With this in place a bare "internal" in the UI can only
 * mean the second — the request never reached the function.
 *
 * Deliberate HttpsErrors pass through untouched: they already carry a message
 * written for the person reading it.
 */
export function explained(handler) {
  return async (req) => {
    try {
      return await handler(req);
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      logger.error('Unhandled error in callable', e);
      throw new HttpsError('unknown',
        `Server error: ${String(e?.message || e).slice(0, 300)}`);
    }
  };
}
