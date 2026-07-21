import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        bindings: {
          BETTER_AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters",
          BETTER_AUTH_URL: "https://voidmesh.test",
          R2_ACCESS_KEY_ID: "test-access-key",
          R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
          R2_BUCKET_NAME: "voidmesh-test",
          R2_SECRET_ACCESS_KEY: "test-secret-access-key",
          ROOM_SNAPSHOT_INTERVAL: "2",
          PRO_ACCOUNT_STORAGE_LIMIT_BYTES: String(10 * 1024 ** 3),
          PRO_HARD_ASSET_LIMIT_BYTES: String(2 * 1024 ** 3),
          PRO_HOSTED_WORKSPACE_LIMIT: "5",
          PRO_WORKSPACE_STORAGE_LIMIT_BYTES: String(4 * 1024 ** 3),
          STRIPE_PRO_PRICE_ID: "price_test_pro",
          STRIPE_SECRET_KEY: "sk_test_voidmesh",
          STRIPE_WEBHOOK_SECRET: "whsec_voidmesh_test",
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          TRUSTED_WEB_ORIGINS: "https://app.voidmesh.test",
          WEB_ORIGIN: "https://app.voidmesh.test",
        },
      },
      wrangler: { configPath: "./wrangler.jsonc" },
    })),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
