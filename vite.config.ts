import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const githubPagesBase = '/carter-account-detail-generator/';

export default defineConfig({
  plugins: [react(), {
    name: 'development-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      // Local development only: Vite's code reload socket and injected CSS.
      // Production retains connect-src 'none' and disallows inline scripts/styles.
      return html.replace("connect-src 'none'", "connect-src 'self' ws://127.0.0.1:5173")
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("style-src 'self'", "style-src 'self' 'unsafe-inline'");
    },
  }],
  base: process.env.GITHUB_ACTIONS === 'true' ? githubPagesBase : './',
  worker: { format: 'es' },
  build: { sourcemap: false },
});
