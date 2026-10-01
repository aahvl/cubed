import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sql } from "drizzle-orm";
import { config } from "./config.js";
import { db, closeDb } from "./db/client.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { corsMiddleware } from "./middleware/cors.js";
import { requireCsrfHeader } from "./middleware/csrf.js";
import { globalRateLimit } from "./middleware/rate-limit.js";
import { attachSession, deleteExpiredSessions, type SessionContext } from "./lib/session.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { projectRoutes } from "./routes/projects.js";
import { galleryRoutes } from "./routes/gallery.js";
import { shopRoutes } from "./routes/shop.js";
import { adminRoutes, internalRoutes } from "./routes/admin.js";
import { announcementReadRoutes } from "./routes/announcements.js";
import { scheduleAirtableSync } from "./jobs/airtable-sync.js";

// Mounted under /api so a reverse proxy can share one domain with the Astro
// frontend without colliding with a frontend page of the same name.
const api = new Hono<SessionContext>();

api.use(securityHeaders);
api.use(corsMiddleware);
api.use(globalRateLimit);
api.use(requireCsrfHeader);
api.use(attachSession);

api.onError((err, c) => {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});

// Actually checks Postgres, not just "the process is up" — a plain
// {ok: true} would let an orchestrator's health check pass while the
// database is unreachable, which is the failure mode that actually matters.
api.get("/health", async (c) => {
  try {
    await db.execute(sql`select 1`);
    return c.json({ ok: true });
  } catch (err) {
    console.error("Health check: database unreachable", err instanceof Error ? err.message : err);
    return c.json({ ok: false, error: "database unreachable" }, 503);
  }
});

api.route("/auth", authRoutes);
api.route("/me", meRoutes);
api.route("/projects", projectRoutes);
api.route("/gallery", galleryRoutes);
api.route("/shop", shopRoutes);
api.route("/admin", adminRoutes);
api.route("/internal", internalRoutes);
api.route("/announcements", announcementReadRoutes);

const app = new Hono().route("/api", api);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Cubed backend listening on http://localhost:${info.port}`);
});

scheduleAirtableSync();

// Periodic cleanup of expired session rows.
setInterval(() => {
  deleteExpiredSessions().catch((err) => console.error("Session cleanup failed", err));
}, 60 * 60 * 1000);

// An orchestrator sends SIGTERM before killing the process on every deploy/
// restart — without this, in-flight requests get dropped mid-response and
// Postgres connections are left to time out instead of closing cleanly.
// The force-exit timeout is a backstop in case a connection never drains.
function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    closeDb().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
