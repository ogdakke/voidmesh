declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL: string;
    R2_ACCESS_KEY_ID: string;
    R2_ACCOUNT_ID: string;
    PRO_ACCOUNT_STORAGE_LIMIT_BYTES: string;
    PRO_HARD_ASSET_LIMIT_BYTES: string;
    PRO_HOSTED_WORKSPACE_LIMIT: string;
    PRO_WORKSPACE_STORAGE_LIMIT_BYTES: string;
    STRIPE_PRO_PRICE_ID: string;
    STRIPE_SECRET_KEY: string;
    STRIPE_WEBHOOK_SECRET: string;
    R2_BUCKET_NAME: string;
    R2_SECRET_ACCESS_KEY: string;
    ROOM_SNAPSHOT_INTERVAL: string;
    TEST_MIGRATIONS: D1Migration[];
    WEB_ORIGIN: string;
    TRUSTED_WEB_ORIGINS: string;
  }
}
