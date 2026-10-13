import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

// Nitro's `standard` preset builds the server as one request handler, with the
// static assets inlined, and `heimdall-dashboard serve` serves it under Bun, so
// its server functions can use Bun's built-in `SQL`, as the Hub does. Inlined,
// the assets compile into the binary with the rest of the app.
export default defineConfig({
  // `bun` is a runtime module that only server code imports. Excluding it keeps
  // the browser build's dependency scan from failing to resolve it.
  optimizeDeps: { exclude: ['bun'] },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    nitro({ preset: 'standard', serveStatic: 'inline' }),
    // React's plugin must come after Start's.
    viteReact(),
  ],
  resolve: { tsconfigPaths: true },
  server: { port: 3000 },
});
