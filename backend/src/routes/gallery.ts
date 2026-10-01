import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, eq, ilike, ne, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { projectUpvotes, projects, users } from "../db/schema.js";
import { requireAuth, type SessionContext } from "../lib/session.js";

export const galleryRoutes = new Hono<SessionContext>();

// `q` (name search), `status` (filter), and `userId` (one user's own
// projects — powers the gallery's "view all of this person's projects"
// pfp click) are all optional — an empty gallery request still returns
// everything, same as before these existed. "rejected" is deliberately not
// a selectable status here — rejected projects never show in the gallery
// at all, regardless of filter (enforced again below, unconditionally).
const gallerySearchSchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(["draft", "submitted", "approved"]).optional(),
  userId: z.string().uuid().optional(),
});

// Public response — never email/slack_id (slackId is the one exception,
// admin-only, added conditionally below). userId IS included on purpose —
// it's how the frontend links a project's submitter avatar to "view all of
// this user's projects". repoUrl/demoUrl ARE included on purpose too — a
// deliberate product decision (this used to say "never" on those two) —
// visitors seeing a project's code/demo is the point.
galleryRoutes.get("/", zValidator("query", gallerySearchSchema), async (c) => {
  // null for a logged-out visitor — used for viewerHasUpvoted and the
  // admin-only slackId column below.
  const viewer = c.get("user");
  const { q, status, userId } = c.req.valid("query");

  // Rejected projects never show in the gallery, full stop — not behind a
  // filter toggle, not even in "view a user's own projects". Pushed
  // unconditionally, independent of whatever `status`/`userId` narrows to.
  const conditions = [ne(projects.status, "rejected")];
  if (q) conditions.push(ilike(projects.name, `%${q}%`));
  if (status) conditions.push(eq(projects.status, status));
  if (userId) conditions.push(eq(projects.userId, userId));

  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      description: projects.description,
      status: projects.status,
      photoUrl: projects.photoUrl,
      repoUrl: projects.repoUrl,
      demoUrl: projects.demoUrl,
      userId: projects.userId,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      viewCount: projects.viewCount,
      // Table-qualified as raw SQL text — this query has a JOIN so Drizzle
      // would qualify columns correctly anyway, but relying on that broke
      // silently in routes/projects.ts's JOIN-less version of this same subquery.
      upvoteCount: sql<number>`(select count(*)::int from project_upvotes where project_upvotes.project_id = projects.id)`,
      viewerHasUpvoted: viewer
        ? sql<boolean>`exists(select 1 from project_upvotes where project_upvotes.project_id = projects.id and project_upvotes.user_id = ${viewer.id})`
        : sql<boolean>`false`,
      // Admin-only — shown next to the nickname in the gallery's detailed
      // project view so admins can look someone up in Slack directly.
      ...(viewer?.isAdmin ? { slackId: users.slackId } : {}),
    })
    .from(projects)
    .innerJoin(users, eq(projects.userId, users.id))
    .where(and(...conditions))
    .orderBy(sql`case when ${projects.status} = 'approved' then 0 else 1 end`, desc(projects.createdAt));

  return c.json(rows);
});

// Not restricted to non-owners — upvoting your own project is a little
// silly but low-stakes, not worth the extra ownership-lookup complexity.
galleryRoutes.post("/:id/upvote", requireAuth, async (c) => {
  const user = c.get("user")!;
  const projectId = c.req.param("id");

  const result = await db.transaction(async (tx) => {
    const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
    if (!project) {
      return { error: "not_found" as const };
    }

    const [existing] = await tx
      .select({ id: projectUpvotes.id })
      .from(projectUpvotes)
      .where(and(eq(projectUpvotes.projectId, projectId), eq(projectUpvotes.userId, user.id)));

    if (existing) {
      await tx.delete(projectUpvotes).where(eq(projectUpvotes.id, existing.id));
    } else {
      await tx.insert(projectUpvotes).values({ projectId, userId: user.id }).onConflictDoNothing();
    }

    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(projectUpvotes)
      .where(eq(projectUpvotes.projectId, projectId));

    return { upvoted: !existing, upvoteCount: count };
  });

  if ("error" in result) {
    return c.json({ error: result.error }, 404);
  }

  return c.json(result);
});

// No requireAuth — a logged-out visitor should count too. Naive increment,
// no per-viewer dedup, on purpose (see viewCount's comment in schema.ts).
galleryRoutes.post("/:id/view", async (c) => {
  const projectId = c.req.param("id");

  const [row] = await db
    .update(projects)
    .set({ viewCount: sql`${projects.viewCount} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ viewCount: projects.viewCount });

  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }

  return c.json({ viewCount: row.viewCount });
});
