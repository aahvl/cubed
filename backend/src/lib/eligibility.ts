// Mirrors frontend/src/lib/eligibility-copy.ts's `eligibilityBlockReason`
// exactly (same priority order, same reason values) — frontend and backend
// are separate deployables with no shared code path, so this can't just be
// imported from one side; keep both in sync if this logic ever changes.
// Used at first-ever login (routes/auth.ts, deciding whether to create an
// account at all) and by lib/eligibility-check.ts's live re-check (deciding
// whether to let an existing account submit/buy).

import type { YswsStatus } from "../integrations/hackclub-auth.js";

export type BlockReason = "hackatime_banned" | "rejected" | "over_18" | "needs_verification";

export function eligibilityBlockReason(hackatimeBanned: boolean, yswsStatus: YswsStatus | null): BlockReason | null {
  if (hackatimeBanned) return "hackatime_banned";
  if (yswsStatus === "rejected") return "rejected";
  if (yswsStatus === "verified_but_over_18") return "over_18";
  if (yswsStatus === "needs_submission" || yswsStatus === "pending") return "needs_verification";
  return null;
}
