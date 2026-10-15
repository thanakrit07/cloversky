/// <reference types="vitest/config" />
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Cloversky',
        short_name: 'Cloversky',
        description: 'Household finance tracker for two',
        lang: 'th',
        display: 'standalone',
        // Was 'portrait': the redesign adds a desktop layout (three regions
        // on wide screens), so the installed app should be free to rotate /
        // resize rather than lock to a phone orientation.
        start_url: '/',
        scope: '/',
        // ADR-0022 Tomato palette — matches --primary / --background in src/index.css.
        theme_color: '#d33318',
        background_color: '#ffffff',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // pdf.js is only needed on Import statement, which needs the network to
        // write anyway; keep ~430 KB out of what every device downloads at install.
        globIgnores: ['assets/pdf-*.js'],
        navigateFallback: '/index.html',
        // Supabase data goes through React Query's persisted cache, not the
        // service worker — never serve auth/API responses from Cache Storage.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\//,
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    port: 3000,
    // Fail loudly rather than silently landing on 3001: a "default" port that
    // moves when something else holds it isn't one.
    strictPort: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    // Tests never talk to Supabase, but src/lib/supabase.ts refuses to load
    // without these. Fixed fake values keep CI (which has no .env) green and
    // mean a test can never reach a real database through a local .env.
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:1',
      VITE_SUPABASE_ANON_KEY: 'test-anon-key',
    },
  },
})
