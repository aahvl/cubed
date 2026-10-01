import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  pgEnum,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// "approved" and "rejected" are both terminal — no "needs_changes" state.
// For something small the reviewer DMs the submitter on Slack instead and
// approves the same Airtable record once it's fixed, rather than resetting
// Airtable back to pending or piling up a new record per resubmission.
export const projectStatusEnum = pgEnum("project_status", [
  "draft",
  "submitted",
  "approved",
  "rejected",
]);

export const submissionStatusEnum = pgEnum("submission_status", [
  "pending",
  "accepted",
  "rejected",
]);

export const transactionTypeEnum = pgEnum("transaction_type", [
  "earned",
  "spent",
  "adjustment",
]);

export const heardAboutSourceEnum = pgEnum("heard_about_source", [
  "friends_family",
  "instagram_youtube",
  "hackclub_site",
  "slack",
  "email",
  "school",
  "other",
]);

// Mirrors Hack Club Auth's own `/api/external/check` result values exactly —
// see integrations/hackclub-auth.ts. Null means never checked yet (e.g. a
// user created before this column existed, ahead of the next eligibility sync).
export const yswsStatusEnum = pgEnum("ysws_status", [
  "needs_submission",
  "pending",
  "verified_eligible",
  "verified_but_over_18",
  "rejected",
  "not_found",
]);

// Hack Club Auth identity only. Never add address/phone/gov-id/birthdate/
// legal-name columns here (CLAUDE.md rule 1) — Auth's first/last name is
// legal name too, so it's never persisted, only re-collected fresh at submit time.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  slackId: text("slack_id").notNull().unique(),
  email: text("email").notNull(),
  // User-chosen, set once during onboarding — never derived from their
  // real name. Null until onboarding completes.
  nickname: text("nickname"),
  // Fetched via the Slack Web API (src/integrations/slack.ts) — Hack Club
  // Auth's own identity endpoint doesn't expose one. Refreshed every login.
  avatarUrl: text("avatar_url"),
  isAdmin: boolean("is_admin").notNull().default(false),
  // Manual Postgres flip only, no admin UI. Checked on session lookup so
  // it takes effect immediately, not just on next login.
  isBanned: boolean("is_banned").notNull().default(false),
  // Both of these come from external, unauthenticated Hack Club APIs (see
  // integrations/hackatime.ts + hackclub-auth.ts) — set at login, then kept
  // fresh by jobs/eligibility-sync.ts so an already-logged-in session
  // reflects a ban/eligibility change without waiting for the next login.
  // Checked in frontend/src/middleware.ts, not here — unlike isBanned this
  // doesn't invalidate the session, it redirects to an explanatory page.
  hackatimeBanned: boolean("hackatime_banned").notNull().default(false),
  yswsStatus: yswsStatusEnum("ysws_status"),
  molesBalance: integer("moles_balance").notNull().default(0),
  // Doubles as the "has this user completed onboarding" flag.
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
  heardAboutSource: heardAboutSourceEnum("heard_about_source"),
  heardAboutDetail: text("heard_about_detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// The session id IS the cookie value: random, unguessable, never derived from user data.
export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    repoUrl: text("repo_url"),
    demoUrl: text("demo_url"),
    // Chosen while still a draft, required before submit (same pattern as
    // repoUrl/demoUrl) — NOT collected fresh at submit time like the rest of
    // the submission's PII, on purpose: this is operational project metadata
    // (which Hackatime projects/dates justify the hours), not the
    // legal-name/address/birthdate category CLAUDE.md rule 1 forbids storing.
    // Forwarded verbatim to Airtable's "Justification - ..." fields at
    // submit time (see routes/projects.ts's handleSubmission).
    hackatimeProjectsAndDates: text("hackatime_projects_and_dates"),
    hackatimeUserId: text("hackatime_user_id"),
    // Showcase photo, unrelated to the submission screenshot (that goes to
    // Airtable, never stored here). Hosted on Hack Club's CDN; photoCdnId is
    // the CDN's own upload id, needed to later call its delete endpoint.
    photoUrl: text("photo_url"),
    photoCdnId: text("photo_cdn_id"),
    status: projectStatusEnum("status").notNull().default("draft"),
    // Undeduplicated on purpose — a motivational number for the owner, not
    // an analytics feature, so no per-viewer tracking/session dedup.
    viewCount: integer("view_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Matches the real query shape (routes/projects.ts's list + ownership
  // lookups): WHERE user_id = ? ORDER BY created_at DESC.
  (table) => [index("projects_user_created_idx").on(table.userId, table.createdAt)],
);

// No address/birthday/screenshot/hackatime/legal-name columns here — those
// fields exist only for the duration of the /submit request, never stored.
export const submissions = pgTable(
  "submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    airtableRecordId: text("airtable_record_id").notNull().unique(),
    status: submissionStatusEnum("status").notNull().default("pending"),
    approvedHours: numeric("approved_hours"),
    feedback: text("feedback"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
  },
  // Matches routes/projects.ts's GET /:id/submissions: WHERE project_id = ? ORDER BY submitted_at DESC.
  (table) => [index("submissions_project_submitted_idx").on(table.projectId, table.submittedAt)],
);

// Unique index makes upvoting idempotent and is what the toggle route
// checks to decide add vs. remove.
export const projectUpvotes = pgTable(
  "project_upvotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("project_upvotes_project_user_idx").on(table.projectId, table.userId)],
);

export const shopItems = pgTable("shop_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  airtableRecordId: text("airtable_record_id").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  imageUrl: text("image_url"),
  category: text("category"),
  priceMoles: integer("price_moles").notNull(),
  active: boolean("active").notNull().default(true),
  syncedAt: timestamp("synced_at", { withTimezone: true }),
});

// price/phone/address never live here — fulfillment PII goes straight to
// Airtable via the same pass-through pattern as submissions.
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    shopItemId: uuid("shop_item_id")
      .notNull()
      .references(() => shopItems.id),
    // Buying N of an item is one row (quantity N), not N rows — one
    // fulfillment form per purchase, not per unit.
    quantity: integer("quantity").notNull().default(1),
    pricePaid: integer("price_paid").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Matches routes/shop.ts's GET /orders + ownership lookups: WHERE user_id = ? ORDER BY created_at DESC.
  (table) => [index("orders_user_created_idx").on(table.userId, table.createdAt)],
);

// Append-only ledger — source of truth for balance. No UPDATE/DELETE from
// application code, ever.
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: transactionTypeEnum("type").notNull(),
    amount: integer("amount").notNull(),
    reason: text("reason").notNull(),
    refId: uuid("ref_id"),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Matches routes/me.ts's GET /transactions: WHERE user_id = ? ORDER BY created_at DESC.
  (table) => [index("transactions_user_created_idx").on(table.userId, table.createdAt)],
);

export const announcements = pgTable("announcements", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-item, not a single "read up until" timestamp — an earlier version
// worked that way but couldn't represent "unread this one older item".
export const announcementReads = pgTable(
  "announcement_reads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    announcementId: uuid("announcement_id")
      .notNull()
      .references(() => announcements.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("announcement_reads_announcement_user_idx").on(table.announcementId, table.userId)],
);
