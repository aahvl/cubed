// Reads Airtable (writes live in routes/projects.ts and routes/shop.ts) —
// polls on a timer, or on demand via POST /api/internal/sync/airtable.
// syncSubmissions() is the only place moles get credited; syncShopItems()
// mirrors the shop catalog into Postgres.

import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { projects, shopItems, submissions, transactions, users } from "../db/schema.js";
import { getRecord, listRecords } from "../integrations/airtable.js";
import { config } from "../config.js";

// Exact strings from the real Airtable "Status" single-select (case/spacing
// matters — a typo here means the sync job silently treats it as pending
// forever):
//   "pending review"              → not decided yet.
//   "approved (no fraud review)"  → treated as not-decided — a fast-track
//                                    status the reviewer later flips to
//                                    plain "Approved" to actually credit moles.
//   "Approved"                    → the only status that credits moles.
//   "need changes"                → still selectable in Airtable, but a
//                                    no-op here — reviewers DM small fixes
//                                    on Slack instead.
//   "rejected"                    → final, no resubmission.
// Unset/blank comes through as `undefined`, treated the same as "pending review".
type ReviewStatus =
  | "pending review"
  | "approved (no fraud review)"
  | "Approved"
  | "need changes"
  | "rejected";

type SubmissionFields = {
  Status?: ReviewStatus;
  // Reviewer-only — never written by our own submission form. Moles are
  // normally calculated from this.
  "Optional - Override Hours Spent"?: number;
  // Escape hatch — when set, overrides the hours×5 calculation entirely.
  "Optional - Override Approved Moles"?: number;
  // User-facing feedback — distinct from Airtable's own reviewer-only
  // "Internal Review Notes" (never read here).
  "review_reason(userfacing)"?: string;
};

const APPROVED_STATUSES: ReviewStatus[] = ["Approved"];

// "need changes" is included since it's no longer a real decision path (see above).
const NOT_YET_DECIDED_STATUSES: ReviewStatus[] = [
  "pending review",
  "approved (no fraud review)",
  "need changes",
];

async function syncSubmissions() {
  // Only re-checks "pending" submissions — once decided, never re-checked.
  const pending = await db.select().from(submissions).where(eq(submissions.status, "pending"));
  const tableId = config.airtable.submissionsTableId;

  for (const submission of pending) {
    const record = await getRecord(tableId, submission.airtableRecordId);
    const fields = record.fields as SubmissionFields;

    if (!fields.Status || NOT_YET_DECIDED_STATUSES.includes(fields.Status)) {
      continue;
    }

    if (APPROVED_STATUSES.includes(fields.Status)) {
      // The ONE place moles get credited — must stay atomic (ledger +
      // balance together) and idempotent (a repeated sync must not double-credit).
      const approvedHours = fields["Optional - Override Hours Spent"] ?? 0;
      const molesOverride = fields["Optional - Override Approved Moles"];
      // floor(hours×5), unless molesOverride is set — then that wins outright.
      const moles = molesOverride != null ? Math.floor(molesOverride) : Math.floor(approvedHours * 5);
      // Stable per-project receipt string — this is what makes crediting idempotent below.
      const reason = `project:${submission.projectId} approved`;

      await db.transaction(async (tx) => {
        await tx
          .update(submissions)
          .set({
            status: "accepted",
            approvedHours: String(approvedHours),
            feedback: fields["review_reason(userfacing)"] ?? null,
            syncedAt: new Date(),
          })
          .where(eq(submissions.id, submission.id));

        // Mirrored onto projects.status so the dashboard doesn't need to join submissions.
        await tx
          .update(projects)
          .set({ status: "approved", updatedAt: new Date() })
          .where(eq(projects.id, submission.projectId));

        // Guards against a repeated/overlapping sync run crediting the same approval twice.
        const [alreadyCredited] = await tx
          .select({ id: transactions.id })
          .from(transactions)
          .where(eq(transactions.reason, reason));

        if (alreadyCredited) {
          // Status updates above still commit; only the crediting is skipped.
          return;
        }

        const [project] = await tx
          .select({ userId: projects.userId })
          .from(projects)
          .where(eq(projects.id, submission.projectId));

        // Ledger insert + balance bump in the same transaction —
        // transactions is append-only and must always explain a balance change.
        await tx.insert(transactions).values({
          userId: project.userId,
          type: "earned",
          amount: moles,
          reason,
          refId: submission.projectId,
        });

        await tx
          .update(users)
          .set({ molesBalance: sql`${users.molesBalance} + ${moles}` })
          .where(eq(users.id, project.userId));
      });
    } else {
      // Only "rejected" reaches here now — terminal, no moles.
      await db.transaction(async (tx) => {
        await tx
          .update(submissions)
          .set({
            status: "rejected",
            feedback: fields["review_reason(userfacing)"] ?? null,
            syncedAt: new Date(),
          })
          .where(eq(submissions.id, submission.id));

        await tx
          .update(projects)
          .set({ status: "rejected", updatedAt: new Date() })
          .where(eq(projects.id, submission.projectId));
      });
    }
  }
}

// Field names match the real "shop_items" table:
//  - image_url is a plain URL, not an Airtable attachment — items are
//    expected to be hosted elsewhere (e.g. a CDN).
//  - "catagory" (sic) is the real field's actual spelling.
//  - cost_moles is treated as the true price (maps to price_moles); the
//    table also has an unused cost_hours — unconfirmed which is meant to
//    be canonical.
type ShopItemFields = {
  item_name?: string;
  description?: string;
  image_url?: string;
  catagory?: string;
  cost_moles?: number;
  active?: boolean;
};

async function syncShopItems() {
  const tableId = config.airtable.shopItemsTableId;
  // Full read every run — no "pending" concept for shop items, just upsert everything.
  const records = await listRecords(tableId);

  for (const record of records) {
    const fields = record.fields as ShopItemFields;

    // airtable_record_id ties a Postgres row to its Airtable row permanently.
    await db
      .insert(shopItems)
      .values({
        airtableRecordId: record.id,
        name: fields.item_name ?? "",
        description: fields.description ?? null,
        imageUrl: fields.image_url ?? null,
        category: fields.catagory ?? null,
        priceMoles: fields.cost_moles ?? 0,
        active: fields.active ?? true,
        syncedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: shopItems.airtableRecordId,
        set: {
          name: fields.item_name ?? "",
          description: fields.description ?? null,
          imageUrl: fields.image_url ?? null,
          category: fields.catagory ?? null,
          priceMoles: fields.cost_moles ?? 0,
          active: fields.active ?? true,
          syncedAt: new Date(),
        },
      });
  }
}

// Exported so admin.ts's manual sync button can call it too.
export async function syncFromAirtable() {
  await syncSubmissions();
  await syncShopItems();
}

// Interval is configurable via AIRTABLE_SYNC_INTERVAL_MINUTES (default 15, see config.ts).
export function scheduleAirtableSync() {
  const minutes = config.airtable.syncIntervalMinutes;

  setInterval(() => {
    // Swallowed so a transient Airtable outage doesn't crash the process.
    syncFromAirtable().catch((err) => {
      console.error("Airtable sync failed", err instanceof Error ? err.message : err);
    });
  }, minutes * 60 * 1000);
}
