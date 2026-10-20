/**
 * Vercel serverless entry for the Comp API.
 *
 * `nest build` compiles `src/` to `dist/`, so this file requires the compiled
 * factory rather than the TypeScript source — the Vercel builder cannot
 * compile NestJS from source because esbuild does not support
 * `emitDecoratorMetadata`, which the DI container depends on.
 *
 * The Express instance is what Vercel's @vercel/node runtime expects: it is a
 * plain (req, res) handler. The instance is created lazily and memoised, so
 * the Nest container (and its better-auth wiring) is built once per lambda
 * instance rather than once per request.
 */

const fs = require('fs');
const path = require('path');

// `nest build` emits to dist/src/ because trigger.config.ts at the app root
// widens the TypeScript rootDir. dist/ is the fallback in case that changes.
const FACTORY_CANDIDATES = ['../dist/src/app-factory.js', '../dist/app-factory.js'];

function loadFactory() {
  for (const relative of FACTORY_CANDIDATES) {
    const absolute = path.join(__dirname, relative);
    if (fs.existsSync(absolute)) {
      console.log('[comp-api] loading compiled factory:', absolute);
      return require(absolute);
    }
  }
  throw new Error(
    '[comp-api] compiled app-factory not found. Looked in: ' +
      FACTORY_CANDIDATES.map((c) => path.join(__dirname, c)).join(', '),
  );
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
