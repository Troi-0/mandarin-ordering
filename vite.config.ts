import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? '/mandarin-ordering/' : '/',
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // The scheduler is a separate package with its own workerd test pool.
    exclude: [...configDefaults.exclude, 'workers/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.{ts,tsx}', 'scripts/lib/**/*.ts'],
      exclude: [
        'src/main.tsx',
        'src/vite-env.d.ts',
        'src/test/**',
        '**/*.test.{ts,tsx}',
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 78,
        statements: 85,
      },
    },
  },
})
