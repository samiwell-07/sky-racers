import { once } from 'node:events';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** Starts the multiplayer server together with `npm run dev`, so lobbies work out of the box. */
export function multiplayerServer(): Plugin {
  let start: (() => Promise<void>) | undefined;
  let closeRelay: (() => Promise<void>) | undefined;
  return {
    name: 'sky-multiplayer-server',
    apply: 'serve',
    configureServer(server) {
      if (process.env.VITEST) return; // tests start their own server
      let starting: Promise<void> | undefined;
      // Vite constructs the replacement before closing the old server. Bind only when it starts.
      start = () => starting ??= (async () => {
        // @ts-expect-error plain JS module without type declarations
        const { startRelay, stopRelay } = await import('./server/relay.mjs');
        const host = server.config.server.host;
        const wss = startRelay({
          host: host === true ? '0.0.0.0' : host || 'localhost',
          log: (m: string) => server.config.logger.info(`[multiplayer] ${m}`),
        });
        let closing: Promise<void> | undefined;
        closeRelay = () => closing ??= stopRelay(wss);
        try {
          await once(wss, 'listening');
        } catch (cause) {
          await closeRelay();
          throw new Error('Multiplayer relay could not start. Stop the existing relay/dev server using this port, then restart npm run dev; refusing to reuse a possibly outdated server.', { cause });
        }
        wss.on('error', (error: Error) => server.config.logger.error(`[multiplayer] ${error.message}`));
      })();
    },
    async buildStart() {
      await start?.();
    },
    async closeServer() {
      await closeRelay?.();
    },
  };
}

export default defineConfig({
  plugins: [multiplayerServer()],
  server: { open: true, host: 'localhost', strictPort: true },
  // Three.js alone is ~600 kB minified.
  build: { chunkSizeWarningLimit: 1000 },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
