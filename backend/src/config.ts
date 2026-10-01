import "dotenv/config";

// Validated once at import time — fails loud at boot instead of a cryptic
// downstream error. Everything else reads `config.x`, not `process.env.x`.
const required = [
  "DATABASE_URL",
  "FRONTEND_ORIGINS",
  "FRONTEND_URL",
  "HACKCLUB_AUTH_CLIENT_ID",
  "HACKCLUB_AUTH_CLIENT_SECRET",
  "HACKCLUB_AUTH_REDIRECT_URI",
  "AIRTABLE_PAT",
  "AIRTABLE_BASE_ID",
  "AIRTABLE_SUBMISSIONS_TABLE_ID",
  "AIRTABLE_SCREENSHOT_FIELD_ID",
  "AIRTABLE_SHOP_ITEMS_TABLE_ID",
  "AIRTABLE_FULFILLMENT_TABLE_ID",
] as const;

// SLACK_BOT_TOKEN and HACKCLUB_CDN_API_KEY are deliberately not required —
// both are nice-to-haves layered on a working app (avatars, showcase
// photos), not reasons to refuse to boot. Unset just means a graceful
// fallback downstream (initial-letter avatar; a 503 from the photo routes).

const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
  throw new Error(`Missing required env vars: ${missing.join(", ")}`);
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  isProd: process.env.NODE_ENV === "production",
  databaseUrl: process.env.DATABASE_URL!,
  frontendOrigins: process.env
    .FRONTEND_ORIGINS!.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  frontendUrl: process.env.FRONTEND_URL!,
  hackclubAuth: {
    clientId: process.env.HACKCLUB_AUTH_CLIENT_ID!,
    clientSecret: process.env.HACKCLUB_AUTH_CLIENT_SECRET!,
    redirectUri: process.env.HACKCLUB_AUTH_REDIRECT_URI!,
  },
  airtable: {
    pat: process.env.AIRTABLE_PAT!,
    baseId: process.env.AIRTABLE_BASE_ID!,
    submissionsTableId: process.env.AIRTABLE_SUBMISSIONS_TABLE_ID!,
    screenshotFieldId: process.env.AIRTABLE_SCREENSHOT_FIELD_ID!,
    shopItemsTableId: process.env.AIRTABLE_SHOP_ITEMS_TABLE_ID!,
    fulfillmentTableId: process.env.AIRTABLE_FULFILLMENT_TABLE_ID!,
    syncIntervalMinutes: Number(process.env.AIRTABLE_SYNC_INTERVAL_MINUTES ?? 15),
  },
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN ?? "",
  },
  hackclubCdn: {
    apiKey: process.env.HACKCLUB_CDN_API_KEY ?? "",
  },
};
