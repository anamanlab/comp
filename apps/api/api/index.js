/**
 * Vercel serverless entry for the Comp API.
 *
 * `nest build` compiles `src/` to `dist/`, so this file requires the compiled
 * factory rather than the TypeScript source — the Vercel builder cannot
 * compile NestJS from source because esbuild does not support
 * `emitDecoratorMetadata`, which the DI container depends on.
 *
 * The require path below is a static literal on purpose: Vercel traces the
 * dependency graph with @vercel/nft, and a computed `require(variable)` is
 * invisible to it, so the whole compiled `dist/` tree would be missing from
 * the deployed function.
 *
 * The Express instance is what Vercel's @vercel/node runtime expects: it is a
 * plain (req, res) handler. The instance is created lazily and memoised, so
 * the Nest container (and its better-auth wiring) is built once per lambda
 * instance rather than once per request.
 */

const fs = require('fs');
const path = require('path');

function loadFactory() {
  try {
    // Static literal — traced by nft.
    return require('../dist/src/app-factory');
  } catch (error) {
    const primaryMissing =
      error &&
      error.code === 'MODULE_NOT_FOUND' &&
      String(error.message).includes("'../dist/src/app-factory'");
    // A nested MODULE_NOT_FOUND means something inside the API's dependency
    // graph is missing — surface that instead of hiding it behind a fallback.
    if (!primaryMissing) throw error;

    // Best-effort fallback for a different nest build layout. Not traced by
    // nft (computed path), so it only works if the file is already present.
    const flat = path.join(__dirname, '../dist/app-factory.js');
    if (!fs.existsSync(flat)) {
      throw new Error(
        '[comp-api] compiled app-factory not found at ' +
          path.join(__dirname, '../dist/src/app-factory.js') +
          ' or ' +
          flat,
      );
    }
    return require(flat);
  }
}

let handlerPromise = null;

async function getHandler() {
  const { createApp } = loadFactory();
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
