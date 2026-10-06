import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { createManualChunks } from './src/manual-chunks'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Registration is done from the app so it can be skipped in the
      // Capacitor build, where a precaching worker only risks serving assets
      // from an older APK.
      injectRegister: null,
      includeAssets: ['icon.svg', 'default_album_art.png'],
      manifest: false, // Use the existing site.webmanifest
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        // The song cache (public/song-cache-sw.js).
        importScripts: ['song-cache-sw.js'],
        runtimeCaching: [
          {
            // Cover art ids embed a hash of the artwork, so a given URL always
            // returns the same image and the server marks it immutable. Serve
            // it straight from cache instead of revalidating, which otherwise
            // sends every thumbnail back to the music server on each visit.
            urlPattern: /\/rest\/getCoverArt/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'cover-art',
              expiration: {
                maxEntries: 3000,
                maxAgeSeconds: 60 * 60 * 24 * 90,
                purgeOnQuotaError: true,
              },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Not songs (stream, download): they're whole files, kept by
            // the song cache instead.
            urlPattern: /\/rest\/(?!stream|download)/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              expiration: { maxEntries: 100, maxAgeSeconds: 300 },
            },
          },
        ],
      },
    }),
  ],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      cy: path.resolve(__dirname, './cypress'),
    },
  },
  build: {
    minify: 'terser',
    rollupOptions: {
      external: ['bufferutil', 'utf-8-validate'],
      output: {
        manualChunks: createManualChunks,
      },
    },
  },
})
