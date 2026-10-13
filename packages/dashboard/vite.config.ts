import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

// The app builds for Bun (Nitro's `bun` preset) and runs under it, so its
// server functions can use Bun's built-in `SQL`, as the Hub does.
export default defineConfig({
  // `bun` is a runtime module that only server code imports. Excluding it keeps
  // the browser build's dependency scan from failing to resolve it.
  optimizeDeps: { exclude: ['bun'] },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    nitro({ preset: 'bun' }),
    // React's plugin must come after Start's.
    viteReact(),
  ],
  resolve: { tsconfigPaths: true },
  server: { port: 3000 },
});
