import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { projects, transactions, users } from "../db/schema.js";
import { requireAuth, type SessionContext } from "../lib/session.js";
import { fetchHackatimeProjects } from "../integrations/hackatime.js";

// Letters/numbers/underscores only — safe to show unescaped anywhere
// (gallery cards, HUD, admin) without lookalike-character or whitespace tricks.
const NICKNAME_REGEX = /^[A-Za-z0-9_]+$/;
const nicknameField = z
  .string()
  .trim()
  .min(3)
  .max(20)
  .regex(NICKNAME_REGEX, "Nicknames can only contain letters, numbers, and underscores");

const nicknameSchema = z.object({
  nickname: nicknameField,
});

const DATE_FIELD = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");
const hackatimeProjectsQuerySchema = z.object({
  start: DATE_FIELD,
  end: DATE_FIELD,
});

const onboardingSchema = z.object({
  nickname: nicknameField,
  heardAboutSource: z.enum([
    "friends_family",
    "instagram_youtube",
    "hackclub_site",
    "slack",
    "email",
    "school",
    "other",
  ]),
  heardAboutDetail: z.string().trim().max(1000).optional(),
});

export const meRoutes = new Hono<SessionContext>();

meRoutes.get("/", requireAuth, (c) => {
  return c.json(c.get("user"));
});

meRoutes.patch("/", requireAuth, zValidator("json", nicknameSchema), async (c) => {
  const user = c.get("user")!;
  const input = c.req.valid("json");

  const [row] = await db
    .update(users)
    .set({ nickname: input.nickname })
    .where(eq(users.id, user.id))
    .returning({ id: users.id, nickname: users.nickname });

  return c.json(row);
});

// Replayable — ProfilePopup.svelte links back to /onboarding to revisit
// it. onboardedAt is only ever set once; a replay doesn't bump it.
meRoutes.post("/onboarding", requireAuth, zValidator("json", onboardingSchema), async (c) => {
  const user = c.get("user")!;
  const input = c.req.valid("json");

  const [row] = await db
    .update(users)
    .set({
      nickname: input.nickname,
      heardAboutSource: input.heardAboutSource,
      heardAboutDetail: input.heardAboutDetail,
      onboardedAt: user.onboardedAt ?? new Date(),
    })
    .where(eq(users.id, user.id))
    .returning({ id: users.id, nickname: users.nickname, onboardedAt: users.onboardedAt });

  return c.json(row);
});

// Backs HackatimeProjectPicker.svelte, used when submitting a project — the
// call to Hackatime happens server-side (keyed by the session's own
// slackId, never a client-supplied id) so a submitter can only ever see
// their own Hackatime data through this route.
meRoutes.get("/hackatime-projects", requireAuth, zValidator("query", hackatimeProjectsQuerySchema), async (c) => {
  const user = c.get("user")!;
  const { start, end } = c.req.valid("query");

  const result = await fetchHackatimeProjects(user.slackId, start, end);
  if (!result) {
    return c.json({ error: "hackatime_unavailable" }, 502);
  }

  return c.json(result);
});

meRoutes.get("/transactions", requireAuth, async (c) => {
  const user = c.get("user")!;
  const page = Math.max(1, Number(c.req.query("page") ?? "1"));
  const pageSize = 20;

  // The stored `reason` (`project:<uuid> approved`) must stay exactly that
  // shape — airtable-sync.ts does an exact-match idempotency check on it.
  // This join only builds a nicer DISPLAY string; the raw column is untouched.
  const rows = await db
    .select({
      id: transactions.id,
      type: transactions.type,
      amount: transactions.amount,
      reason: transactions.reason,
      approvedProjectName: projects.name,
      createdAt: transactions.createdAt,
    })
    .from(transactions)
    .leftJoin(projects, and(eq(transactions.type, "earned"), eq(transactions.refId, projects.id)))
    .where(eq(transactions.userId, user.id))
    .orderBy(desc(transactions.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return c.json(
    rows.map(({ approvedProjectName, ...row }) => ({
      ...row,
      reason: approvedProjectName ? `Approved: ${approvedProjectName}` : row.reason,
    })),
  );
});
