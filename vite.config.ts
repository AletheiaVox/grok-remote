import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface PackageJson { version?: string }

const pkg = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'package.json'),
  'utf8',
)) as PackageJson;

// React is mounted only inside the Live agent flow page (src/views/system/flow.jsx).
// The rest of the dashboard stays vanilla; the plugin just enables JSX/TSX transform
// and pulls in the react-refresh runtime in dev.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react({
      include: /\.(jsx|tsx)$/,
    }),
  ],
  server: {
    port: 7911,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:7910',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
