import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { createSession, deleteSession, SESSION_COOKIE_NAME, attachSession, type SessionContext } from "../lib/session.js";
import { authRateLimit } from "../middleware/rate-limit.js";
import { fetchSlackAvatarUrl } from "../integrations/slack.js";
import { fetchHackatimeTrustLevel } from "../integrations/hackatime.js";
import { checkYswsEligibility } from "../integrations/hackclub-auth.js";
import { eligibilityBlockReason } from "../lib/eligibility.js";

const AUTH_BASE_URL = "https://auth.hackclub.com";
const STATE_COOKIE_NAME = "cubed_oauth_state";

// Minimal scope set — Cubed is eligible for broader scopes (legal_name,
// address, phone) but deliberately doesn't request them; the submission/
// fulfillment modals collect that data fresh, in-app, every time instead.
// No `verification_status` scope — eligibility is checked via the public
// `/api/external/check` endpoint below instead (keyed by slack_id, needs no
// scope/consent at all, and distinguishes rejected/over-18/pending, which
// that scope's plain `ysws_eligible` boolean couldn't).
const SCOPES = "openid profile email name slack_id";

export const authRoutes = new Hono<SessionContext>();

authRoutes.get("/login", authRateLimit, (c) => {
  const state = randomBytes(16).toString("hex");

  setCookie(c, STATE_COOKIE_NAME, state, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "Lax",
    maxAge: 60 * 10,
    path: "/",
  });

  const url = new URL("/oauth/authorize", AUTH_BASE_URL);
  url.searchParams.set("client_id", config.hackclubAuth.clientId);
  url.searchParams.set("redirect_uri", config.hackclubAuth.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES);
  url.searchParams.set("state", state);

  // Standard OAuth2 param name; unconfirmed whether Hack Club Auth honors
  // it, but harmless if ignored.
  const email = c.req.query("email");
  if (email) {
    url.searchParams.set("login_hint", email);
  }

  return c.redirect(url.toString());
});

authRoutes.get("/callback", authRateLimit, async (c) => {
  // Distinct from the state mismatch check below, which is the CSRF-relevant case.
  const oauthError = c.req.query("error");
  if (oauthError) {
    const description = c.req.query("error_description") ?? oauthError;
    return c.redirect(
      `${config.frontendUrl}/login?error=${encodeURIComponent(description)}`,
    );
  }

  const code = c.req.query("code");
  const state = c.req.query("state");
  const expectedState = getCookie(c, STATE_COOKIE_NAME);

  deleteCookie(c, STATE_COOKIE_NAME, { path: "/" });

  if (!code || !state || !expectedState || state !== expectedState) {
    return c.text("Invalid OAuth state", 400);
  }

  const tokenResponse = await fetch(`${AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: config.hackclubAuth.clientId,
      client_secret: config.hackclubAuth.clientSecret,
      redirect_uri: config.hackclubAuth.redirectUri,
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) {
    return c.text("Hack Club Auth token exchange failed", 502);
  }
  // The response also includes a refresh_token — deliberately never read or
  // stored. Nothing in this app ever needs to mint a new Hack Club access
  // token without the user going through /login again, and a long-lived
  // credential like that sitting in Postgres would be a real liability if
  // the database were ever breached, for zero actual benefit.
  const token = (await tokenResponse.json()) as {
    access_token: string;
  };

  const meResponse = await fetch(`${AUTH_BASE_URL}/api/v1/me`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!meResponse.ok) {
    return c.text("Hack Club Auth identity fetch failed", 502);
  }
  const me = (await meResponse.json()) as {
    identity: {
      primary_email: string;
      slack_id: string;
    };
  };

  // Checked before writing anything — a brand-new Slack identity that
  // fails eligibility must leave zero trace in Postgres (not even a row to
  // later flip a flag on). An *existing* account that later fails this same
  // check is handled completely differently: it keeps its row (still
  // updated below) and gets gated by the frontend's /blocked page instead.
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.slackId, me.identity.slack_id));

  // Both swallow their own errors and return null on a hiccup — an
  // unreachable Hackatime/Auth should never block a login outright. A null
  // result just leaves that field at whatever it already was (or the
  // column default, for a brand-new user); jobs/eligibility-sync.ts will
  // fill in the real value on its next run either way.
  const [avatarUrl, trustLevel, yswsStatus] = await Promise.all([
    fetchSlackAvatarUrl(me.identity.slack_id),
    fetchHackatimeTrustLevel(me.identity.slack_id),
    checkYswsEligibility(me.identity.slack_id),
  ]);

  const hackatimeBanned = trustLevel === "red";
  const blockReason = eligibilityBlockReason(hackatimeBanned, yswsStatus);

  if (!existing && blockReason) {
    return c.redirect(`${config.frontendUrl}/login-blocked?reason=${blockReason}`);
  }

  // Never touches first/last name (legal name, never persisted) or
  // nickname (user-chosen at onboarding). Each field is only added to the
  // update when its fetch succeeded, so a transient failure never wipes an
  // existing value with a null.
  const updateSet: {
    email: string;
    avatarUrl?: string;
    hackatimeBanned?: boolean;
    yswsStatus?: NonNullable<typeof yswsStatus>;
  } = {
    email: me.identity.primary_email,
  };
  if (avatarUrl) updateSet.avatarUrl = avatarUrl;
  if (trustLevel) updateSet.hackatimeBanned = hackatimeBanned;
  if (yswsStatus) updateSet.yswsStatus = yswsStatus;

  const [user] = await db
    .insert(users)
    .values({
      slackId: me.identity.slack_id,
      email: me.identity.primary_email,
      avatarUrl,
      hackatimeBanned,
      yswsStatus,
    })
    .onConflictDoUpdate({
      target: users.slackId,
      set: updateSet,
    })
    .returning({ id: users.id, isBanned: users.isBanned });

  if (user.isBanned) {
    return c.redirect(`${config.frontendUrl}/login?error=${encodeURIComponent("This account has been suspended.")}`);
  }

  const session = await createSession(user.id);

  setCookie(c, SESSION_COOKIE_NAME, session.id, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: "Lax",
    expires: session.expiresAt,
    path: "/",
  });

  return c.redirect(`${config.frontendUrl}/dashboard`);
});

authRoutes.post("/logout", attachSession, async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (sessionId) {
    await deleteSession(sessionId);
  }
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  return c.body(null, 204);
});
