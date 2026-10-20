/**
 * Vercel serverless entry for the Comp API.
 *
 * `dist/function.cjs` is produced by `scripts/build-function.js`, which bundles
 * the compiled API (and the @trycompai/* workspace packages) into a single
 * CommonJS file. Two reasons:
 *
 *  - `@trycompai/utils` is a source-only workspace package whose `exports`
 *    point at `.ts` files, so the plain compiled output emits a require() that
 *    Node cannot satisfy at runtime.
 *  - The require path below is a static literal on purpose: Vercel traces the
 *    dependency graph with @vercel/nft, and a computed `require(variable)` is
 *    invisible to it, so the bundle would not be included in the deployment.
 *
 * The Express instance is what Vercel's @vercel/node runtime expects: it is a
 * plain (req, res) handler. The instance is created lazily and memoised, so
 * the Nest container (and its better-auth wiring) is built once per lambda
 * instance rather than once per request.
 */

const fs = require('fs');
const path = require('path');


function loadBundle() {
  if (!fs.existsSync(path.join(__dirname, '../dist/function.cjs'))) {
    throw new Error(
      '[comp-api] bundle not found at ' +
        path.join(__dirname, '../dist/function.cjs') +
        ' — did "node scripts/build-function.js" run?',
    );
  }
  // Static literal — @vercel/nft must be able to see this require.
  return require('../dist/function.cjs');
}

let handlerPromise = null;

async function getHandler() {
  const { createApp } = loadBundle();
  const { app } = await createApp();
  return app.getHttpAdapter().getInstance();
}

module.exports = async function handler(req, res) {
  if (!handlerPromise) {
    handlerPromise = getHandler().catch((error) => {
      // Reset so a transient failure does not poison the instance forever.
      handlerPromise = null;
      console.error(
        '[comp-api] bootstrap failed:',
        error && error.stack ? error.stack : error,
      );
      throw error;
    });
  }

  try {
    const fn = await handlerPromise;
    return fn(req, res);
  } catch (error) {
    console.error(
      '[comp-api] request failed:',
      error && error.stack ? error.stack : error,
    );
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'bootstrap failed',
          message: String((error && error.message) || error),
        }),
      );
    }
  }
};
