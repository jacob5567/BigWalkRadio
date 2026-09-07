import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Broadcast days are anchored to local midnight, so pin the zone for tests.
  test: { env: { TZ: 'UTC' } },
});
