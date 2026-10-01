import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { announcements, orders, projects, shopItems, submissions, transactions, users } from "../db/schema.js";
import { requireAuth, requireAdmin, type SessionContext } from "../lib/session.js";
import { syncFromAirtable } from "../jobs/airtable-sync.js";
import { syncEligibility } from "../jobs/eligibility-sync.js";

const announcementColumns = {
  id: announcements.id,
  title: announcements.title,
  body: announcements.body,
  createdAt: announcements.createdAt,
};

const announcementSchema = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(5000),
});

export const adminRoutes = new Hono<SessionContext>();

adminRoutes.use("*", requireAuth, requireAdmin);

adminRoutes.post("/announcements", zValidator("json", announcementSchema), async (c) => {
  const user = c.get("user")!;
  const input = c.req.valid("json");

  const [row] = await db
    .insert(announcements)
    .values({ title: input.title, body: input.body, createdBy: user.id })
    .returning(announcementColumns);

  return c.json(row, 201);
});

adminRoutes.patch("/announcements/:id", zValidator("json", announcementSchema.partial()), async (c) => {
  const id = c.req.param("id");
  const input = c.req.valid("json");

  const [row] = await db
    .update(announcements)
    .set(input)
    .where(eq(announcements.id, id))
    .returning(announcementColumns);
  if (!row) return c.json({ error: "Not found" }, 404);

  return c.json(row);
});

adminRoutes.delete("/announcements/:id", async (c) => {
  const id = c.req.param("id");
  await db.delete(announcements).where(eq(announcements.id, id));
  return c.body(null, 204);
});

adminRoutes.get("/stats", async (c) => {
  const [userCount] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  const [projectCount] = await db.select({ count: sql<number>`count(*)::int` }).from(projects);
  // One query, one row per status, rather than four separate `where`
  // counts — submissions.status only ever has these three values.
  const [submissionCounts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      approved: sql<number>`count(*) filter (where ${submissions.status} = 'accepted')::int`,
      rejected: sql<number>`count(*) filter (where ${submissions.status} = 'rejected')::int`,
      pending: sql<number>`count(*) filter (where ${submissions.status} = 'pending')::int`,
    })
    .from(submissions);

  return c.json({
    totalUsers: userCount.count,
    totalProjects: projectCount.count,
    totalSubmitted: submissionCounts.total,
    totalApproved: submissionCounts.approved,
    totalRejected: submissionCounts.rejected,
    totalPending: submissionCounts.pending,
  });
});

// One combined payload rather than five separate endpoints — the page
// needs all of it up front, and this is low-traffic/admin-only.
adminRoutes.get("/analytics", async (c) => {
  const days = Math.min(90, Math.max(1, Number(c.req.query("days") ?? "30")));
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));

  // GROUP BY skips zero-signup days — gaps filled in afterward in JS
  // rather than a generate_series query.
  const signupRows = await db
    .select({
      date: sql<string>`to_char(date_trunc('day', ${users.createdAt}), 'YYYY-MM-DD')`,
      count: sql<number>`count(*)::int`,
    })
    .from(users)
    .where(gte(users.createdAt, since))
    .groupBy(sql`date_trunc('day', ${users.createdAt})`)
    .orderBy(sql`date_trunc('day', ${users.createdAt})`);
  const signupMap = new Map(signupRows.map((r) => [r.date, r.count]));
  const signupsPerDay = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    signupsPerDay.push({ date: key, count: signupMap.get(key) ?? 0 });
  }

  // Free-text responses capped at 50 most recent to keep the payload bounded.
  const heardAboutRows = await db
    .select({ source: users.heardAboutSource, count: sql<number>`count(*)::int` })
    .from(users)
    .where(isNotNull(users.heardAboutSource))
    .groupBy(users.heardAboutSource);

  const heardAboutResponses = await db
    .select({
      nickname: users.nickname,
      source: users.heardAboutSource,
      detail: users.heardAboutDetail,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(isNotNull(users.heardAboutDetail))
    .orderBy(desc(users.createdAt))
    .limit(50);

  const projectsByStatus = await db
    .select({ status: projects.status, count: sql<number>`count(*)::int` })
    .from(projects)
    .groupBy(projects.status);

  // Rate is only meaningful over *decided* submissions — pending ones
  // haven't gone either way yet, so they're excluded from the denominator.
  const [reviewRow] = await db
    .select({
      approved: sql<number>`count(*) filter (where ${submissions.status} = 'accepted')::int`,
      rejected: sql<number>`count(*) filter (where ${submissions.status} = 'rejected')::int`,
      pending: sql<number>`count(*) filter (where ${submissions.status} = 'pending')::int`,
      totalHoursFunded: sql<number>`coalesce(sum(${submissions.approvedHours}) filter (where ${submissions.status} = 'accepted'), 0)::float`,
      avgApprovedHours: sql<number>`coalesce(avg(${submissions.approvedHours}) filter (where ${submissions.status} = 'accepted'), 0)::float`,
    })
    .from(submissions);
  const decided = reviewRow.approved + reviewRow.rejected;
  const approvalRate = decided > 0 ? Math.round((reviewRow.approved / decided) * 100) : null;

  const [economyRow] = await db
    .select({
      totalEarned: sql<number>`coalesce(sum(case when ${transactions.type} = 'earned' then ${transactions.amount} else 0 end), 0)::int`,
      totalSpent: sql<number>`coalesce(sum(case when ${transactions.type} = 'spent' then ${transactions.amount} else 0 end), 0)::int`,
    })
    .from(transactions);

  const [balanceRow] = await db
    .select({ totalOutstanding: sql<number>`coalesce(sum(${users.molesBalance}), 0)::int` })
    .from(users);

  const [orderRow] = await db
    .select({
      totalOrders: sql<number>`count(*)::int`,
      totalUnits: sql<number>`coalesce(sum(${orders.quantity}), 0)::int`,
    })
    .from(orders);

  const [onboardingRow] = await db
    .select({
      totalUsers: sql<number>`count(*)::int`,
      onboardedCount: sql<number>`count(*) filter (where ${users.onboardedAt} is not null)::int`,
    })
    .from(users);

  // Top 5 by units sold — tells an admin what to restock/feature, which
  // nothing else on this page currently surfaces at the item level.
  const topShopItems = await db
    .select({
      name: shopItems.name,
      unitsSold: sql<number>`coalesce(sum(${orders.quantity}), 0)::int`,
      molesSpent: sql<number>`coalesce(sum(${orders.pricePaid}), 0)::int`,
    })
    .from(orders)
    .innerJoin(shopItems, eq(orders.shopItemId, shopItems.id))
    .groupBy(shopItems.id, shopItems.name)
    .orderBy(desc(sql`sum(${orders.quantity})`))
    .limit(5);

  return c.json({
    signupsPerDay,
    heardAbout: heardAboutRows,
    heardAboutResponses,
    projectsByStatus,
    review: {
      approved: reviewRow.approved,
      rejected: reviewRow.rejected,
      pending: reviewRow.pending,
      approvalRate,
      totalHoursFunded: reviewRow.totalHoursFunded,
      avgApprovedHours: reviewRow.avgApprovedHours,
    },
    economy: {
      totalEarned: economyRow.totalEarned,
      totalSpent: economyRow.totalSpent,
      totalOutstanding: balanceRow.totalOutstanding,
      totalOrders: orderRow.totalOrders,
      totalUnitsOrdered: orderRow.totalUnits,
    },
    topShopItems,
    onboarding: onboardingRow,
  });
});

export const internalRoutes = new Hono<SessionContext>();

internalRoutes.post("/sync/airtable", requireAuth, requireAdmin, async (c) => {
  await syncFromAirtable();
  return c.body(null, 204);
});

internalRoutes.post("/sync/eligibility", requireAuth, requireAdmin, async (c) => {
  await syncEligibility();
  return c.body(null, 204);
});
