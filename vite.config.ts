import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

/** Starts the multiplayer server together with `npm run dev`, so lobbies work out of the box. */
function multiplayerServer(): Plugin {
  return {
    name: 'sky-multiplayer-server',
    apply: 'serve',
    async configureServer() {
      if (process.env.VITEST) return; // tests start their own server
      // @ts-expect-error plain JS module without type declarations
      const { startRelay } = await import('./server/relay.mjs');
      const wss = startRelay({ log: (m: string) => console.log(`[multiplayer] ${m}`) });
      wss.on('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE') console.log('[multiplayer] port 8787 already in use (server already running elsewhere).');
        else console.error('[multiplayer]', e);
      });
    },
  };
}

export default defineConfig({
  plugins: [multiplayerServer()],
  server: { open: true },
  // Three.js alone is ~600 kB minified.
  build: { chunkSizeWarningLimit: 1000 },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
