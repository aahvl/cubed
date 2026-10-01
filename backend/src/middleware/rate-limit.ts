// globalRateLimit: blanket per-IP ceiling, abuse-cost protection only —
// nothing correctness-dependent relies on it. authRateLimit: tighter, on
// /auth/login and /auth/callback only.
//
// No per-action limits on submit/buy on purpose: double-submission is
// blocked by the project status check (routes/projects.ts), double-spending
// by the row lock in the buy transaction (routes/shop.ts) — both hold with
// or without a rate limiter on top.

import { rateLimiter } from "hono-rate-limiter";
import type { Context } from "hono";

// In-memory — correct for one instance only. Multiple instances behind a
// load balancer would each enforce the limit independently, so the real
// combined ceiling would quietly multiply.
//
// X-Real-IP, not X-Forwarded-For: Orchard's ingress sets X-Real-IP to the
// actual socket peer and overwrites anything the client sent, so it can't
// be spoofed. X-Forwarded-For is an append-only list the client's own
// first entry can prepend to — keying on it directly (as this used to)
// lets an attacker put a different value on every request and rate-limit
// themselves right out of the limiter. Falls back to XFF's first hop only
// for a local/non-Orchard proxy that doesn't set X-Real-IP; that fallback
// is best-effort, not spoof-proof.
function keyForPublicRoute(c: Context) {
  const realIp = c.req.header("x-real-ip");
  const forwardedFor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${realIp ?? forwardedFor ?? "unknown"}`;
}

export const globalRateLimit = rateLimiter({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: "draft-6",
  keyGenerator: keyForPublicRoute,
});

// Tighter than the global limit — these are the routes worth brute-forcing
// (OAuth state guessing, callback replay).
export const authRateLimit = rateLimiter({
  windowMs: 60_000,
  limit: 8,
  standardHeaders: "draft-6",
  keyGenerator: keyForPublicRoute,
});
