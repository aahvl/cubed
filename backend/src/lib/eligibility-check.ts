// Live eligibility re-check for an already-logged-in user — called from the
// two places that actually matter (submitting a project, buying from the
// shop), not on a schedule. Replaces the old scheduled batch job
// (jobs/eligibility-sync.ts's automatic timer) entirely: checking once at
// login plus again at the two real "gates" catches a ban/eligibility change
// exactly when it matters, without ever polling in the background.

import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { fetchHackatimeTrustLevel } from "../integrations/hackatime.js";
import { checkYswsEligibility } from "../integrations/hackclub-auth.js";
import { eligibilityBlockReason, type BlockReason } from "./eligibility.js";
import type { SessionUser } from "./session.js";

export async function checkEligibilityLive(
  user: Pick<SessionUser, "id" | "slackId" | "hackatimeBanned" | "yswsStatus">,
): Promise<BlockReason | null> {
  // Both swallow their own errors and return null on a hiccup — same
  // fail-open philosophy as login: a null result just means "couldn't
  // confirm right now," so it falls back to whatever's already stored
  // rather than wrongly banning someone over a transient API outage.
  const [trustLevel, yswsStatus] = await Promise.all([
    fetchHackatimeTrustLevel(user.slackId),
    checkYswsEligibility(user.slackId),
  ]);

  const hackatimeBanned = trustLevel !== null ? trustLevel === "red" : user.hackatimeBanned;
  const resolvedYswsStatus = yswsStatus ?? user.yswsStatus;

  if (trustLevel !== null || yswsStatus !== null) {
    await db
      .update(users)
      .set({
        ...(trustLevel !== null ? { hackatimeBanned } : {}),
        ...(yswsStatus !== null ? { yswsStatus } : {}),
      })
      .where(eq(users.id, user.id));
  }

  return eligibilityBlockReason(hackatimeBanned, resolvedYswsStatus);
}
