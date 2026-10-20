import './config/load-env';
import type { INestApplication } from '@nestjs/common';
import path from 'path';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { createApp } from './app-factory';
import { shutdownTracing } from './inference-tracing';

let app: INestApplication | null = null;

async function bootstrap(): Promise<void> {
  const created = await createApp();
  app = created.app;

  const server = await app.listen(created.port);
  const address = server.address();
  const actualPort =
    typeof address === 'string' ? created.port : address?.port || created.port;
  const actualUrl = `http://localhost:${actualPort}`;

  console.log(`Application is running on: ${actualUrl}`);
  console.log(`API Documentation available at: ${actualUrl}/api/docs`);

  // Write OpenAPI documentation to packages/docs/openapi.json only in development
  if (process.env.NODE_ENV !== 'production') {
    const openapiPath = path.join(
      __dirname,
      '../../../../packages/docs/openapi.json',
    );

    const docsDir = path.dirname(openapiPath);
    if (!existsSync(docsDir)) {
      mkdirSync(docsDir, { recursive: true });
    }

    writeFileSync(openapiPath, JSON.stringify(created.document, null, 2));
    console.log('OpenAPI documentation written to packages/docs/openapi.json');
  }
}

// Graceful shutdown handler
async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down gracefully...`);
  if (app) {
    await app.close();
    console.log('Application closed');
  }
  await shutdownTracing();
  process.exit(0);
}

// Handle shutdown signals (important for hot reload)
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Handle bootstrap errors properly
void bootstrap().catch((error: unknown) => {
  console.error('Error starting application:', error);
  process.exit(1);
});
