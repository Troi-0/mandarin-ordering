import { generateKeyPairSync } from 'node:crypto'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// A throwaway key generated per run: no real or test key material is committed.
const testKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
})

// Wrangler validates secrets.required from process.env before Miniflare starts.
process.env.GITHUB_APP_PRIVATE_KEY_PKCS8 = testKey.privateKey

export default defineConfig({
  test: {
    // Workers' Vitest pool cannot collect V8 coverage, so only the Node unit
    // project is measured; the workerd project proves the real runtime path.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['worker.ts'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 78,
        statements: 85,
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['worker.test.ts'],
        },
      },
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.json' },
            miniflare: {
              bindings: {
                GITHUB_APP_CLIENT_ID: 'Iv23liTestClient01',
                GITHUB_APP_INSTALLATION_ID: '4242',
                TEST_GITHUB_APP_PUBLIC_KEY_SPKI: testKey.publicKey,
              },
            },
          }),
        ],
        test: {
          name: 'workerd',
          include: ['test/**/*.test.ts'],
        },
      },
    ],
  },
})
