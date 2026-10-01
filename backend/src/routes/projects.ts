// User-facing project routes: create/edit drafts and submit for review.
// Lifecycle: draft → submitted → (approved | rejected), both terminal — no
// resubmit path; small fixes happen via Slack DM and the reviewer approves
// the same Airtable record in place. The reviewer works entirely in
// Airtable; src/jobs/airtable-sync.ts polls it and applies their decision.

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { projects, submissions } from "../db/schema.js";
import { requireAuth, type SessionContext } from "../lib/session.js";
import { createRecord, uploadAttachment } from "../integrations/airtable.js";
import { uploadProjectPhoto, deleteProjectPhoto } from "../integrations/hackclub-cdn.js";
import { checkEligibilityLive } from "../lib/eligibility-check.js";
import { config } from "../config.js";

// Explicit allowlist, not `select *` — avoids leaking columns like user_id.
const projectColumns = {
  id: projects.id,
  name: projects.name,
  description: projects.description,
  repoUrl: projects.repoUrl,
  demoUrl: projects.demoUrl,
  hackatimeProjectsAndDates: projects.hackatimeProjectsAndDates,
  hackatimeUserId: projects.hackatimeUserId,
  photoUrl: projects.photoUrl,
  status: projects.status,
  // Plain column, unlike upvoteCount below — cheap enough for every response.
  viewCount: projects.viewCount,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
};

// upvoteCount is only needed by list/detail, not create/edit/delete.
// Subquery columns are qualified raw SQL (`table.column`), not interpolated
// Drizzle objects — interpolating them here previously emitted UNQUALIFIED
// `where "project_id" = "id"`, which Postgres resolved against
// project_upvotes' own `id` PK instead of projects.id, always returning 0.
function projectColumnsWithUpvotes() {
  return {
    ...projectColumns,
    upvoteCount: sql<number>`(select count(*)::int from project_upvotes where project_upvotes.project_id = projects.id)`,
  };
}

// Editable only in "draft" — once submitted, locked either way (approved or
// rejected). No resubmit path exists.
const EDITABLE_STATUSES = ["draft"] as const;

// Also read by handleSubmission() below — description isn't re-collected at submit time.
const TITLE_MIN = 5;
const TITLE_MAX = 70;
const DESCRIPTION_MIN = 100;
const DESCRIPTION_MAX = 550;

// Zod's `.url()` just runs the value through the WHATWG `URL` constructor,
// which has no scheme allowlist — `new URL("javascript:...")` parses fine
// and would pass `.url()` alone. These render as raw `<a href>` in
// GalleryPopup.svelte/ProjectDetail.svelte with no scheme check on that
// end either, so restricting the scheme has to happen here, at the only
// point this value is ever validated.
const httpUrlSchema = z.string().url().refine((v) => /^https?:\/\//i.test(v), "Must be an http(s) URL");

const createProjectSchema = z.object({
  name: z.string().trim().min(TITLE_MIN).max(TITLE_MAX),
  description: z.string().trim().min(DESCRIPTION_MIN).max(DESCRIPTION_MAX),
  // Empty string from the form is normalized to undefined (stored as NULL).
  repoUrl: httpUrlSchema.optional().or(z.literal("")).transform((v) => v || undefined),
  demoUrl: httpUrlSchema.optional().or(z.literal("")).transform((v) => v || undefined),
  // Set from HackatimeProjectPicker.svelte while still a draft — required
  // before submit (checked in handleSubmission below), not collected again there.
  hackatimeProjectsAndDates: z.string().trim().max(2000).optional().or(z.literal("")).transform((v) => v || undefined),
  hackatimeUserId: z.string().trim().max(50).optional().or(z.literal("")).transform((v) => v || undefined),
});

const patchProjectSchema = createProjectSchema.partial();

// PII the YSWS program requires but CLAUDE.md forbids storing in Postgres —
// validated here, forwarded to Airtable in handleSubmission(), never
// persisted. first/last name is re-collected rather than reusing Hack Club
// Auth's login name — that's legal identity too, kept separate from the
// account's own nickname.
const submissionTextSchema = z.object({
  firstName: z.string().trim().min(1).max(100).regex(/^[A-Za-z ]+$/, "Only letters and spaces are allowed"),
  lastName: z.string().trim().min(1).max(100).regex(/^[A-Za-z ]+$/, "Only letters and spaces are allowed"),
  // Email/description/repoUrl/demoUrl aren't collected here — read straight
  // from user/project below so the submission can't silently diverge from them.
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  stateProvince: z.string().trim().min(1).max(100),
  country: z.string().trim().min(1).max(100),
  zip: z.string().trim().min(1).max(20),
  // Plain YYYY-MM-DD passthrough to Airtable — parsing to Date risks timezone shifts.
  birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
  githubUsername: z.string().trim().min(1).max(100),
  // Optional feedback fields Cubed added on top of the required YSWS fields.
  howHeard: z.string().trim().max(1000).optional(),
  doingWell: z.string().trim().max(2000).optional(),
  improve: z.string().trim().max(2000).optional(),
  // Sent as string "true"/"false" (multipart body) rather than checkbox
  // presence. aiDetails is required only when usedAi is true — enforced via
  // superRefine below.
  usedAi: z.enum(["true", "false"]).transform((v) => v === "true"),
  aiDetails: z.string().trim().max(2000).optional(),
  // Distinct from Airtable's own "Internal Review Notes" (reviewer-private,
  // never touched here) — this is the submitter's note to the reviewer.
  reviewerNotes: z.string().trim().max(2000).optional(),
}).superRefine((data, ctx) => {
  if (data.usedAi && !data.aiDetails?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["aiDetails"],
      message: "Please describe where and how much AI was used",
    });
  }
});

// Airtable enforces its own attachment limits too, but we check mime/size
// before ever buffering the file into memory.
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// A multipart part's declared Content-Type (`File.type`) is whatever the
// client claims — trivial to spoof outside a real browser file picker, so
// it's never trusted as the actual security check. This instead reads the
// first few bytes and matches them against each format's real file
// signature, the same thing `file`/`libmagic` do. Only PNG/JPEG/GIF/WebP
// are accepted anywhere in the app, so that's all this needs to recognize.
async function sniffImageType(file: File): Promise<string | null> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38) return "image/gif";
  if (
    head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
    head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

// Enforced by Hono before the body is buffered — separate from the
// per-field checks above. 6MB = 5MB image cap + form/multipart headroom.
const submissionBodyLimit = bodyLimit({ maxSize: 6 * 1024 * 1024 });

// 10MB per product decision — single-file upload, no other fields riding along.
const MAX_PROJECT_PHOTO_BYTES = 10 * 1024 * 1024;
const projectPhotoBodyLimit = bodyLimit({ maxSize: 11 * 1024 * 1024 });

// Shared by handleSubmission() and the photo routes below.
async function validateImageField(
  value: unknown,
  fieldName: string,
  maxBytes: number = MAX_IMAGE_BYTES,
): Promise<{ ok: true; file: File } | { ok: false; error: string }> {
  if (!(value instanceof File)) {
    return { ok: false, error: `${fieldName} is required` };
  }
  if (value.size > maxBytes) {
    return { ok: false, error: `${fieldName} exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit` };
  }
  // The declared type is checked too (cheap, avoids a pointless byte read
  // for an obviously-wrong upload), but the sniffed type is what actually decides it.
  if (!ALLOWED_IMAGE_TYPES.has(value.type)) {
    return { ok: false, error: `${fieldName} must be png, jpeg, gif, or webp` };
  }
  const sniffed = await sniffImageType(value);
  if (!sniffed || !ALLOWED_IMAGE_TYPES.has(sniffed)) {
    return { ok: false, error: `${fieldName} isn't a valid image file` };
  }
  return { ok: true, file: value };
}

export const projectRoutes = new Hono<SessionContext>();

projectRoutes.get("/", requireAuth, async (c) => {
  const user = c.get("user")!;

  const rows = await db
    .select(projectColumnsWithUpvotes())
    .from(projects)
    .where(eq(projects.userId, user.id))
    .orderBy(desc(projects.createdAt));

  return c.json(rows);
});

projectRoutes.post("/", requireAuth, zValidator("json", createProjectSchema), async (c) => {
  const user = c.get("user")!;
  const input = c.req.valid("json");

  const [row] = await db
    .insert(projects)
    .values({
      userId: user.id,
      name: input.name,
      description: input.description,
      repoUrl: input.repoUrl,
      demoUrl: input.demoUrl,
      // status defaults to "draft" (see schema.ts) — not set explicitly here.
    })
    .returning(projectColumns);

  return c.json(row, 201);
});

projectRoutes.get("/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const rows = await db
    .select(projectColumnsWithUpvotes())
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, user.id)));

  if (rows.length === 0) {
    // Same 404 whether the id doesn't exist or belongs to someone else —
    // avoids leaking which case it is.
    return c.json({ error: "Not found" }, 404);
  }

  return c.json(rows[0]);
});

// At most one row in practice (no resubmit path). Excludes
// airtable_record_id and the original form's PII — those never left
// Airtable to begin with.
projectRoutes.get("/:id/submissions", requireAuth, async (c) => {
  const user = c.get("user")!;
  const projectId = c.req.param("id");

  // Joined through projects since submissions has no user_id column of its own.
  const rows = await db
    .select({
      id: submissions.id,
      status: submissions.status,
      approvedHours: submissions.approvedHours,
      feedback: submissions.feedback,
      submittedAt: submissions.submittedAt,
      syncedAt: submissions.syncedAt,
    })
    .from(submissions)
    .innerJoin(projects, eq(submissions.projectId, projects.id))
    .where(and(eq(submissions.projectId, projectId), eq(projects.userId, user.id)))
    .orderBy(desc(submissions.submittedAt));

  return c.json(rows);
});

projectRoutes.patch("/:id", requireAuth, zValidator("json", patchProjectSchema), async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");
  const input = c.req.valid("json");

  // Separate lookup so 404 vs "not editable" can be distinguished for the client.
  const existing = await db
    .select({ status: projects.status })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, user.id)));

  if (existing.length === 0) {
    return c.json({ error: "Not found" }, 404);
  }

  // Must be enforced here, not just the UI — this is the actual security boundary.
  if (!EDITABLE_STATUSES.includes(existing[0].status as (typeof EDITABLE_STATUSES)[number])) {
    return c.json({ error: "This project can't be edited right now" }, 409);
  }

  const [row] = await db
    .update(projects)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(projects.id, id), eq(projects.userId, user.id)))
    .returning(projectColumns);

  return c.json(row);
});

// Draft only — anything submitted has reviewer history attached, so it's
// not offered for delete.
projectRoutes.delete("/:id", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const existing = await db
    .select({ status: projects.status, photoCdnId: projects.photoCdnId })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, user.id)));

  if (existing.length === 0) {
    return c.json({ error: "Not found" }, 404);
  }
  if (existing[0].status !== "draft") {
    return c.json({ error: "Only draft projects can be deleted" }, 409);
  }

  await db.delete(projects).where(and(eq(projects.id, id), eq(projects.userId, user.id)));

  // Best-effort — the project row is already gone either way, so a CDN
  // failure here just leaves one orphaned file, not worth failing the request over.
  if (existing[0].photoCdnId) {
    deleteProjectPhoto(existing[0].photoCdnId).catch((err) => {
      console.error(
        "Failed to clean up deleted project's photo",
        err instanceof Error ? err.message : err,
      );
    });
  }

  return c.json({ ok: true });
});

// Validates the submission form, forwards it to Airtable, flips the project
// to "submitted". Only reachable from "draft"; no resubmit path afterward.
async function handleSubmission(c: Context<SessionContext>) {
  const user = c.get("user")!;
  const projectId = c.req.param("id");
  if (!projectId) {
    return c.json({ error: "Not found" }, 404);
  }

  // Live re-check, not just relying on the value from login — eligibility
  // can change mid-session (a 30-day cookie easily outlives a same-day
  // ban). Also persists the fresh result, so this user's very next page
  // load is correctly gated to /blocked by middleware.ts even though this
  // request itself isn't a page load.
  const blockReason = await checkEligibilityLive(user);
  if (blockReason) {
    return c.json({ error: "not_eligible", reason: blockReason }, 403);
  }

  const existing = await db
    .select(projectColumns)
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, user.id)));

  if (existing.length === 0) {
    return c.json({ error: "Not found" }, 404);
  }

  const project = existing[0];
  if (project.status !== "draft") {
    return c.json({ error: "Project must be a draft to do this" }, 409);
  }

  // repoUrl/demoUrl are optional while drafting but required to submit —
  // this is the real source of truth; the frontend checks too but isn't trusted alone.
  if (!project.repoUrl || !project.demoUrl) {
    return c.json({ error: "missing_urls" }, 409);
  }

  // Same idea — chosen in the draft editor (HackatimeProjectPicker.svelte),
  // required before submit, never (re-)collected in this submission form.
  if (!project.hackatimeProjectsAndDates || !project.hackatimeUserId) {
    return c.json({ error: "missing_hackatime" }, 409);
  }

  // multipart/form-data, not JSON, because of the screenshot file.
  const body = await c.req.parseBody();

  const parsed = submissionTextSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid submission", details: parsed.error.flatten() }, 400);
  }
  const input = parsed.data;

  const screenshot = await validateImageField(body.screenshot, "screenshot");
  if (!screenshot.ok) {
    return c.json({ error: screenshot.error }, 400);
  }

  // Field names on the right must match the real "YSWS Project Submission"
  // table exactly (Hack Club's shared "Unified YSWS" schema). Reviewer-owned
  // fields ("Optional - Override Hours Spent", "Optional - Override Approved
  // Moles") are deliberately never written here — writing them would mean
  // this code is silently making review decisions instead of the reviewer.
  // The two "Justification - ..." fields below are the one deliberate
  // exception: their own field description reads like reviewer-facing
  // instructions ("a project update should include only dates after the
  // previous update was submitted"), so pre-filling them from the
  // submitter's own Hackatime data is a conscious choice, not an oversight
  // — the reviewer still sees and can correct whatever's filled in here.
  let airtableRecordId: string;
  try {
    airtableRecordId = await createRecord(config.airtable.submissionsTableId, {
      project_name: project.name,
      Description: project.description,
      "Code URL": project.repoUrl,
      "Playable URL": project.demoUrl,
      "First Name": input.firstName,
      "Last Name": input.lastName,
      Email: user.email,
      "GitHub Username": input.githubUsername,
      "Address (Line 1)": input.addressLine1,
      "Address (Line 2)": input.addressLine2 ?? "",
      City: input.city,
      "State / Province": input.stateProvince,
      Country: input.country,
      "ZIP / Postal Code": input.zip,
      Birthday: input.birthday,
      "Justification - Hackatime Project Name(s) + Date Range(s)": project.hackatimeProjectsAndDates,
      "Justification - Submitter Hackatime ID": project.hackatimeUserId,
      "How did you hear about this?": input.howHeard ?? "",
      "What are we doing well?": input.doingWell ?? "",
      "How can we improve?": input.improve ?? "",
      // No separate AI checkbox field on the real table — collapsed into one
      // string (details, or "Not used") to match.
      ai_declaration: input.usedAi ? input.aiDetails! : "Not used",
      user_reviewer_notes: input.reviewerNotes ?? "",
      // Submitter's own Slack id — distinct from the reviewer-owned "reviewer_slack id".
      user_slack_id: user.slackId,
    });

    // Separate Airtable endpoint for attachments; the file only ever lives in memory.
    const screenshotBase64 = Buffer.from(await screenshot.file.arrayBuffer()).toString("base64");
    await uploadAttachment(
      config.airtable.submissionsTableId,
      airtableRecordId,
      config.airtable.screenshotFieldId,
      screenshotBase64,
      screenshot.file.type,
      screenshot.file.name,
    );
  } catch (err) {
    // No retry queue (would mean address/birthday data sitting around).
    // Status never left "draft" here, so the client can just call /submit again.
    console.error("Airtable submission failed", err instanceof Error ? err.message : err);
    return c.json({ error: "Submission failed, please try again" }, 502);
  }

  // Only the Airtable link + status flip are persisted — the form's PII
  // never touches Postgres. One transaction keeps submissions/projects in sync.
  await db.transaction(async (tx) => {
    await tx.insert(submissions).values({
      projectId: project.id,
      airtableRecordId,
      status: "pending",
    });

    await tx
      .update(projects)
      .set({ status: "submitted", updatedAt: new Date() })
      .where(eq(projects.id, project.id));
  });

  return c.json({ ...project, status: "submitted" as const, updatedAt: new Date() }, 200);
}

projectRoutes.post("/:id/submit", requireAuth, submissionBodyLimit, handleSubmission);

// Showcase photo — unrelated to the submission screenshot (never stored
// here). No status check: changing it doesn't affect anything a reviewer is
// currently looking at.
projectRoutes.post("/:id/photo", requireAuth, projectPhotoBodyLimit, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  // photoCdnId isn't in projectColumns (client doesn't need it) — needed
  // here to clean up the old file after a successful replace.
  const existing = await db
    .select({ photoCdnId: projects.photoCdnId })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, user.id)));

  if (existing.length === 0) {
    return c.json({ error: "Not found" }, 404);
  }

  const body = await c.req.parseBody();
  const photo = await validateImageField(body.photo, "photo", MAX_PROJECT_PHOTO_BYTES);
  if (!photo.ok) {
    return c.json({ error: photo.error }, 400);
  }

  let uploaded: { url: string; cdnId: string };
  try {
    uploaded = await uploadProjectPhoto(photo.file);
  } catch (err) {
    console.error("Hack Club CDN upload failed", err instanceof Error ? err.message : err);
    return c.json({ error: "Upload failed, please try again" }, 502);
  }

  const [row] = await db
    .update(projects)
    .set({ photoUrl: uploaded.url, photoCdnId: uploaded.cdnId, updatedAt: new Date() })
    .where(and(eq(projects.id, id), eq(projects.userId, user.id)))
    .returning(projectColumns);

  // Best-effort, not awaited — the new photo is already live either way; a
  // failure here just leaves one orphaned CDN file.
  if (existing[0].photoCdnId) {
    deleteProjectPhoto(existing[0].photoCdnId).catch((err) => {
      console.error(
        "Failed to clean up replaced project photo",
        err instanceof Error ? err.message : err,
      );
    });
  }

  return c.json(row);
});

projectRoutes.delete("/:id/photo", requireAuth, async (c) => {
  const user = c.get("user")!;
  const id = c.req.param("id");

  const existing = await db
    .select({ photoCdnId: projects.photoCdnId })
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.userId, user.id)));

  if (existing.length === 0) {
    return c.json({ error: "Not found" }, 404);
  }
  if (!existing[0].photoCdnId) {
    return c.json({ error: "This project doesn't have a photo" }, 404);
  }

  // Unlike the best-effort cleanup above, this IS awaited — losing the CDN
  // id without confirming deletion would make the file unrecoverable.
  try {
    await deleteProjectPhoto(existing[0].photoCdnId);
  } catch (err) {
    console.error("Hack Club CDN delete failed", err instanceof Error ? err.message : err);
    return c.json({ error: "Couldn't delete photo, please try again" }, 502);
  }

  const [row] = await db
    .update(projects)
    .set({ photoUrl: null, photoCdnId: null, updatedAt: new Date() })
    .where(and(eq(projects.id, id), eq(projects.userId, user.id)))
    .returning(projectColumns);

  return c.json(row);
});
