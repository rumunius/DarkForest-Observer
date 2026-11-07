import {defineConfig} from 'vitest/config';
import {cloudflareTest} from '@cloudflare/vitest-plugin';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {configPath: './apps/match-worker/wrangler.jsonc'},
      miniflare: {
        bindings: {
          MATCH_ID: 'integration',
          APP_ENV: 'local',
          CODE_HMAC_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          CODE_ENCRYPTION_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=',
          BOOTSTRAP_SECRET: 'integration-only-bootstrap-secret',
          PLATFORM_BOOTSTRAP_SECRET: 'integration-platform-maintenance-secret',
        },
      },
    }),
  ],
  test: {
    include: ['tests/workers/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
