import { defineMiddleware } from "astro:middleware";
import { getSessionUser, type Me } from "./lib/api";
import { eligibilityBlockReason } from "./lib/eligibility-copy";

// Checked once a session resolves to a real user, ahead of onboarding/admin
// gating — a hackatime ban or lost YSWS eligibility blocks participation
// outright, regardless of onboarding progress. hackatimeBanned/yswsStatus
// are set at login and kept fresh by the backend's eligibility-sync job
// (not live-checked per-request), so this is a plain field read, not a
// network call. /blocked itself reads these same fields to pick its copy.
// This only ever applies to an EXISTING account that later fails the
// check — a brand-new Slack identity that fails it never gets an account
// (or a session) at all; see backend/src/routes/auth.ts + /login-blocked.

declare global {
  namespace App {
    interface Locals {
      user: Me | null;
    }
  }
}

// Truly skipped, no backend call at all — Astro's own internal asset
// requests, which never need to know who's logged in.
const SKIP_ENTIRELY_PREFIXES = ["/_"];

// Session resolved but never required for these. "/" and "/login" are
// exact matches; "/docs" is a prefix. Gallery is deliberately NOT here —
// it's only reachable through the dashboard's GalleryPopup now, not browsable logged-out.
const CHECK_BUT_DONT_REQUIRE_EXACT = ["/", "/login"];
const CHECK_BUT_DONT_REQUIRE_PREFIXES = ["/docs"];

// Only these specifically bounce an anonymous visitor to /login — a
// genuinely unknown path falls through to Astro's own 404 instead, so
// 404.astro's per-section theming still works for logged-out visitors.
const PROTECTED_PREFIXES = ["/dashboard", "/onboarding", "/admin"];

function matchesPrefix(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// frame-ancestors 'none' (+ the older X-Frame-Options equivalent for
// browsers that don't read CSP) blocks this app from ever being embedded in
// someone else's iframe — the standard clickjacking defense. Applied to
// every response, including redirects, so there's one place this can't be
// accidentally skipped by a new route.
function withFrameProtection(response: Response) {
  response.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  response.headers.set("X-Frame-Options", "DENY");
  return response;
}

// Resolves the session once per request so every authenticated page/layout
// reads Astro.locals.user instead of each calling the backend separately.
export const onRequest = defineMiddleware(async (context, next) => {
  const pathname = context.url.pathname;

  if (SKIP_ENTIRELY_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    context.locals.user = null;
    return withFrameProtection(await next());
  }

  const user = await getSessionUser(context.request);
  context.locals.user = user;

  const isCheckButDontRequire =
    CHECK_BUT_DONT_REQUIRE_EXACT.includes(pathname) ||
    CHECK_BUT_DONT_REQUIRE_PREFIXES.some((prefix) => pathname.startsWith(prefix));

  if (isCheckButDontRequire) {
    return withFrameProtection(await next());
  }

  if (!user) {
    if (matchesPrefix(pathname, PROTECTED_PREFIXES)) {
      return withFrameProtection(context.redirect("/login"));
    }
    return withFrameProtection(await next());
  }

  // A blocked user only ever sees /blocked — onboarding/admin gating below
  // is skipped entirely while blocked, so there's no path back into the
  // rest of the app (and no redirect loop between /blocked and /onboarding).
  if (eligibilityBlockReason(user.hackatimeBanned, user.yswsStatus)) {
    if (pathname !== "/blocked") {
      return withFrameProtection(context.redirect("/blocked"));
    }
    return withFrameProtection(await next());
  }

  // Every other authenticated route bounces to /onboarding until it's done.
  if (!user.onboardedAt && pathname !== "/onboarding") {
    return withFrameProtection(context.redirect("/onboarding"));
  }

  if (pathname.startsWith("/admin") && !user.isAdmin) {
    return withFrameProtection(context.redirect("/dashboard"));
  }

  return withFrameProtection(await next());
});
