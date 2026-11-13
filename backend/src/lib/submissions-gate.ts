// An admin can stop ALL new submissions (including resubmits after "need changes"); named
// people on the exemption list can still submit. Nothing else stops: reviews, moles, the shop
// and drafts carry on. No row means open, so deploying this changes nothing until it is used.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { appSettings, submissionExemptions } from "../db/schema.js";

const KEY = "submissions_open";

export async function areSubmissionsOpen(): Promise<boolean> {
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, KEY));
  return row?.value !== "false";
}

export async function setSubmissionsOpen(open: boolean): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: KEY, value: open ? "true" : "false" })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: open ? "true" : "false", updatedAt: new Date() } });
}

export async function isSubmissionExempt(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: submissionExemptions.userId })
    .from(submissionExemptions)
    .where(eq(submissionExemptions.userId, userId));
  return !!row;
}

export async function canUserSubmit(userId: string): Promise<boolean> {
  return (await areSubmissionsOpen()) || (await isSubmissionExempt(userId));
}
