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

let handlerPromise = null;

async function getHandler() {
  // `nest build` emits to dist/src/ because trigger.config.ts at the app root
  // widens the TypeScript rootDir. Fall back to dist/ in case that changes.
  let factory;
  try {
    factory = require('../dist/src/app-factory');
  } catch (error) {
    if (error && error.code !== 'MODULE_NOT_FOUND') throw error;
    factory = require('../dist/app-factory');
  }
  const { app } = await factory.createApp();
  return app.getHttpAdapter().getInstance();
}

module.exports = async function handler(req, res) {
  if (!handlerPromise) {
    handlerPromise = getHandler().catch((error) => {
      // Reset so a transient failure does not poison the instance forever.
      handlerPromise = null;
      throw error;
    });
  }
  const fn = await handlerPromise;
  return fn(req, res);
};
