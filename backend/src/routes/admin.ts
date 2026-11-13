import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { adminActions, announcements, orders, projects, shopItems, submissionExemptions, submissions, transactions, users } from "../db/schema.js";
import { requireAuth, requireAdmin, type SessionContext } from "../lib/session.js";
import { runAirtableSync } from "../jobs/airtable-sync.js";
import { syncEligibility } from "../jobs/eligibility-sync.js";
import { runUsersSync } from "../jobs/users-sync.js";
import { isRunning, runExclusive } from "../lib/exclusive.js";
import { deleteProjectPhoto } from "../integrations/hackclub-cdn.js";
import { ANALYTICS_RANGES, buildAnalytics } from "./admin-analytics.js";
import { text } from "../lib/text.js";
import { logAdminAction } from "../lib/audit.js";
import { areSubmissionsOpen, setSubmissionsOpen } from "../lib/submissions-gate.js";

const announcementColumns = {
  id: announcements.id,
  title: announcements.title,
  body: announcements.body,
  createdAt: announcements.createdAt,
};

const announcementSchema = z.object({
  title: text(1, 200),
  body: text(1, 5000, true),
});

export const adminRoutes = new Hono<SessionContext>();

adminRoutes.use("*", requireAuth, requireAdmin);

adminRoutes.post("/announcements", bodyLimit({ maxSize: 100 * 1024 }), zValidator("json", announcementSchema), async (c) => {
  const user = c.get("user")!;
  const input = c.req.valid("json");

  const [row] = await db
    .insert(announcements)
    .values({ title: input.title, body: input.body, createdBy: user.id })
    .returning(announcementColumns);

  await logAdminAction({ actorId: user.id, action: "announcement.created", targetType: "announcement", targetId: row.id, details: row.title });
  return c.json(row, 201);
});

adminRoutes.patch("/announcements/:id", bodyLimit({ maxSize: 100 * 1024 }), zValidator("json", announcementSchema.partial()), async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const input = c.req.valid("json");

  const [row] = await db
    .update(announcements)
    .set(input)
    .where(eq(announcements.id, id))
    .returning(announcementColumns);
  if (!row) return c.json({ error: "Not found" }, 404);

  await logAdminAction({ actorId: user.id, action: "announcement.edited", targetType: "announcement", targetId: row.id, details: row.title });
  return c.json(row);
});

adminRoutes.delete("/announcements/:id", async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const deleted = await db.delete(announcements).where(eq(announcements.id, id)).returning({ id: announcements.id, title: announcements.title });
  if (deleted[0]) {
    await logAdminAction({ actorId: user.id, action: "announcement.deleted", targetType: "announcement", targetId: deleted[0].id, details: deleted[0].title });
  }
  return c.body(null, 204);
});

const idParamSchema = z.object({ id: z.string().uuid() });

// Gallery moderation. Reachable from the Gallery popup's detail view (admins
// only) — there is no separate admin page for it.
adminRoutes.patch(
  "/projects/:id/hidden",
  bodyLimit({ maxSize: 10 * 1024 }),
  zValidator("param", idParamSchema),
  zValidator("json", z.object({ hidden: z.boolean() })),
  async (c) => {
    const user = c.get("user")!;
    const { id } = c.req.valid("param");
    const { hidden } = c.req.valid("json");

    const [row] = await db
      .update(projects)
      .set({ hidden })
      .where(eq(projects.id, id))
      .returning({ id: projects.id, hidden: projects.hidden, name: projects.name });
    if (!row) return c.json({ error: "Not found" }, 404);

    await logAdminAction({
      actorId: user.id,
      action: hidden ? "project.hidden" : "project.unhidden",
      targetType: "project",
      targetId: row.id,
      details: row.name,
    });
    return c.json({ id: row.id, hidden: row.hidden });
  },
);

adminRoutes.delete("/projects/:id/photo", zValidator("param", idParamSchema), async (c) => {
  const user = c.get("user")!;
  const { id } = c.req.valid("param");

  const [existing] = await db
    .select({ photoCdnId: projects.photoCdnId, name: projects.name })
    .from(projects)
    .where(eq(projects.id, id));
  if (!existing) return c.json({ error: "Not found" }, 404);

  await db.update(projects).set({ photoUrl: null, photoCdnId: null }).where(eq(projects.id, id));
  await logAdminAction({ actorId: user.id, action: "project.photo_removed", targetType: "project", targetId: id, details: existing.name });

  // Best-effort — the photo is already gone from the app either way.
  if (existing.photoCdnId) {
    deleteProjectPhoto(existing.photoCdnId).catch((err) => {
      console.error("Failed to delete moderated photo from the CDN", err instanceof Error ? err.message : err);
    });
  }

  return c.body(null, 204);
});

// Replaces an impersonating/offensive nickname with a neutral one; the user
// can pick a new one from their profile.
adminRoutes.post("/users/:id/reset-nickname", zValidator("param", idParamSchema), async (c) => {
  const user = c.get("user")!;
  const { id } = c.req.valid("param");

  const [before] = await db.select({ nickname: users.nickname }).from(users).where(eq(users.id, id));
  const nickname = `user_${randomBytes(3).toString("hex")}`;
  const [row] = await db
    .update(users)
    .set({ nickname })
    .where(eq(users.id, id))
    .returning({ id: users.id, nickname: users.nickname });
  if (!row) return c.json({ error: "Not found" }, 404);

  await logAdminAction({
    actorId: user.id,
    action: "user.nickname_reset",
    targetType: "user",
    targetId: row.id,
    details: `${before?.nickname ?? "(none)"} -> ${row.nickname}`,
  });
  return c.json(row);
});

// The audit trail: newest first, 50 per page. Admins only (the whole router is).
// Stop/resume all new submissions, and the people who may still submit while stopped.
adminRoutes.get("/submissions", async (c) => {
  const exemptions = await db
    .select({ userId: users.id, nickname: users.nickname, slackId: users.slackId, addedAt: submissionExemptions.createdAt })
    .from(submissionExemptions)
    .innerJoin(users, eq(users.id, submissionExemptions.userId))
    .orderBy(desc(submissionExemptions.createdAt));
  return c.json({ open: await areSubmissionsOpen(), exemptions });
});

adminRoutes.post("/submissions/open", bodyLimit({ maxSize: 10 * 1024 }), zValidator("json", z.object({ open: z.boolean() })), async (c) => {
  const { open } = c.req.valid("json");
  await setSubmissionsOpen(open);
  await logAdminAction({
    actorId: c.get("user")!.id,
    action: open ? "submissions.opened" : "submissions.stopped",
    details: open ? "new submissions allowed again" : "new submissions stopped for everyone except exempted people",
  });
  return c.json({ open });
});

adminRoutes.post(
  "/submissions/exemptions",
  bodyLimit({ maxSize: 10 * 1024 }),
  zValidator("json", z.object({ identifier: z.string().trim().min(1).max(100) })),
  async (c) => {
    const actor = c.get("user")!;
    const { identifier } = c.req.valid("json");
    // A Slack ID (exact) or a nickname (case-insensitive). A nickname can look like someone
    // else's Slack ID, so a real Slack ID match always wins over a nickname match.
    const [target] = await db
      .select({ id: users.id, nickname: users.nickname, slackId: users.slackId })
      .from(users)
      .where(sql`${users.slackId} = ${identifier.toUpperCase()} or lower(${users.nickname}) = ${identifier.toLowerCase()}`)
      .orderBy(sql`(${users.slackId} = ${identifier.toUpperCase()}) desc`)
      .limit(1);
    if (!target) return c.json({ error: "user_not_found" }, 404);

    await db.insert(submissionExemptions).values({ userId: target.id, addedBy: actor.id }).onConflictDoNothing();
    await logAdminAction({
      actorId: actor.id,
      action: "submissions.exemption_added",
      targetType: "user",
      targetId: target.id,
      details: `${target.nickname ?? target.slackId} may submit while submissions are stopped`,
    });
    return c.json({ userId: target.id, nickname: target.nickname, slackId: target.slackId }, 201);
  },
);

adminRoutes.delete("/submissions/exemptions/:id", zValidator("param", idParamSchema), async (c) => {
  const { id } = c.req.valid("param");
  const removed = await db.delete(submissionExemptions).where(eq(submissionExemptions.userId, id)).returning({ userId: submissionExemptions.userId });
  if (removed.length === 0) return c.json({ error: "Not found" }, 404);
  await logAdminAction({ actorId: c.get("user")!.id, action: "submissions.exemption_removed", targetType: "user", targetId: id });
  return c.body(null, 204);
});

adminRoutes.get("/audit", zValidator("query", z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1) })), async (c) => {
  const { page } = c.req.valid("query");
  const pageSize = 50;

  const rows = await db
    .select({
      id: adminActions.id,
      action: adminActions.action,
      targetType: adminActions.targetType,
      targetId: adminActions.targetId,
      details: adminActions.details,
      createdAt: adminActions.createdAt,
      actorNickname: users.nickname,
      actorId: adminActions.actorId,
    })
    .from(adminActions)
    .leftJoin(users, eq(adminActions.actorId, users.id))
    .orderBy(desc(adminActions.createdAt))
    .limit(pageSize + 1)
    .offset((page - 1) * pageSize);

  return c.json({ items: rows.slice(0, pageSize), hasMore: rows.length > pageSize, page });
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

const analyticsQuerySchema = z.object({
  days: z.coerce
    .number()
    .refine((n) => (ANALYTICS_RANGES as readonly number[]).includes(n), "Unsupported range")
    .default(30),
});

adminRoutes.get("/analytics", zValidator("query", analyticsQuerySchema), async (c) => {
  const { days } = c.req.valid("query");
  return c.json(await buildAnalytics(days));
});

export const internalRoutes = new Hono<SessionContext>();

// Manual triggers share a guard with the timers: if a run is already going, answer 409
// instead of starting a second, overlapping one.
internalRoutes.post("/sync/airtable", requireAuth, requireAdmin, async (c) => {
  const result = await runAirtableSync();
  if (!result.ran) return c.json({ error: "already_running" }, 409);
  await logAdminAction({ actorId: c.get("user")!.id, action: "sync.airtable_triggered" });
  return c.body(null, 204);
});

internalRoutes.post("/sync/users", requireAuth, requireAdmin, async (c) => {
  const result = await runUsersSync();
  if (!result.ran) return c.json({ error: "already_running" }, 409);
  await logAdminAction({ actorId: c.get("user")!.id, action: "sync.users_triggered" });
  return c.body(null, 204);
});

// A full pass makes two external calls per person (minutes at 1000 users), far longer than one
// HTTP request should stay open, so it runs in the background: 202 now, progress in the log.
internalRoutes.post("/sync/eligibility", requireAuth, requireAdmin, async (c) => {
  if (isRunning("eligibility-sync")) return c.json({ error: "already_running" }, 409);
  await logAdminAction({ actorId: c.get("user")!.id, action: "sync.eligibility_triggered" });
  console.log("Eligibility sync started");
  runExclusive("eligibility-sync", syncEligibility)
    .then(() => console.log("Eligibility sync finished"))
    .catch((err) => console.error("Eligibility sync failed", err instanceof Error ? err.message : err));
  return c.body(null, 202);
});
