import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { bedrockDevApi } from './src/server/dev-plugin'

export default defineConfig({
  // bedrockDevApi serves /api/* from an in-memory node:sqlite database using
  // the same handler and the same SQL the Worker runs against D1.
  plugins: [react(), bedrockDevApi()],
  server: {
    // Honour an assigned PORT so the dev server can coexist with others.
    port: Number(process.env.PORT) || 5173,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // node:sqlite is still flagged experimental in Node 24 and warns loudly.
    silent: false,
  },
})
