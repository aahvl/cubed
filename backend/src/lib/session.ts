import { randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { getCookie } from "hono/cookie";
import { db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import type { YswsStatus } from "../integrations/hackclub-auth.js";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export const SESSION_COOKIE_NAME = "cubed_session";

export function generateSessionId(): string {
  return randomBytes(32).toString("hex");
}

export async function createSession(userId: string) {
  const id = generateSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(sessions).values({ id, userId, expiresAt });

  return { id, expiresAt };
}

export async function getSessionUser(sessionId: string) {
  const rows = await db
    .select({
      expiresAt: sessions.expiresAt,
      id: users.id,
      slackId: users.slackId,
      email: users.email,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      isAdmin: users.isAdmin,
      isBanned: users.isBanned,
      hackatimeBanned: users.hackatimeBanned,
      yswsStatus: users.yswsStatus,
      molesBalance: users.molesBalance,
      onboardedAt: users.onboardedAt,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId));

  if (rows.length === 0) {
    return null;
  }

  const { expiresAt, isBanned, ...user } = rows[0];
  // Checked here (not just at login) so a ban takes effect immediately,
  // even against a session issued before the ban.
  if (expiresAt.getTime() < Date.now() || isBanned) {
    return null;
  }

  return user;
}

export async function deleteSession(sessionId: string) {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function deleteExpiredSessions() {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

export type SessionUser = {
  id: string;
  slackId: string;
  email: string;
  nickname: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  hackatimeBanned: boolean;
  yswsStatus: YswsStatus | null;
  molesBalance: number;
  onboardedAt: Date | null;
};

export type SessionContext = {
  Variables: {
    user: SessionUser | null;
  };
};

// Populates c.get("user") when a valid session cookie is present, but never
// rejects — mounted globally so rate limiting can key on the user when
// available, ahead of both public and authenticated routes.
export const attachSession = createMiddleware<SessionContext>(async (c, next) => {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  const user = sessionId ? await getSessionUser(sessionId) : null;
  c.set("user", user);
  return next();
});

export const requireAuth = createMiddleware<SessionContext>(async (c, next) => {
  if (!c.get("user")) {
    throw new HTTPException(401, { message: "Not authenticated" });
  }
  return next();
});

export const requireAdmin = createMiddleware<SessionContext>(async (c, next) => {
  const user = c.get("user");
  if (!user?.isAdmin) {
    throw new HTTPException(403, { message: "Admin only" });
  }
  return next();
});
