// LEGACY prototype config — not part of the deployed stack. See LEGACY.md.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Mobile crew PWA — runs on 5174, proxies API to the OMS backend on 4000.
export default defineConfig({
  define: {
    __DEV__: false,
    'process.env.NODE_ENV': JSON.stringify('development'),
  },
  resolve: {
    alias: {
      'react-native': 'react-native-web',
    },
    // Like Metro on web: lib/session.web.js wins over lib/session.js.
    extensions: ['.web.js', '.web.jsx', '.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'OMS Crew',
        short_name: 'OMS Crew',
        description: 'Offline-capable field operations workspace for OMS crews.',
        theme_color: '#0f1b2d',
        background_color: '#0b1626',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
    }),
  ],
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:4000' },
  },
});
