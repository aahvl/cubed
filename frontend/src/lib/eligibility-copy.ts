// Shared by middleware.ts and login-blocked.astro. one place for the reason-priority
// order and the copy, so the two flows can't drift apart.
import type { YswsStatus } from "./api";

export type BlockReason = "hackatime_banned" | "rejected" | "over_18" | "needs_verification";

export const BLOCK_REASONS: BlockReason[] = ["hackatime_banned", "rejected", "over_18", "needs_verification"];

// Mirrors backend/src/lib/eligibility.ts's eligibilityBlockReason exactly.
export function eligibilityBlockReason(hackatimeBanned: boolean, yswsStatus: YswsStatus | null): BlockReason | null {
  if (hackatimeBanned) return "hackatime_banned";
  if (yswsStatus === "rejected") return "rejected";
  if (yswsStatus === "verified_but_over_18") return "over_18";
  if (yswsStatus === "needs_submission" || yswsStatus === "pending") return "needs_verification";
  return null;
}

export function getBlockCopy(reason: BlockReason): { heading: string; body: string; showAuthCta: boolean } {
  switch (reason) {
    case "hackatime_banned":
      return {
        heading: "You're Hackatime banned",
        body: "Your Hackatime account is currently banned, so you can't participate in Cubed. If you think this is a mistake, reach out on Slack.",
        showAuthCta: false,
      };
    case "rejected":
      return {
        heading: "You're not eligible for YSWS programs",
        body: "Hack Club Auth has marked you as not eligible for YSWS (You Ship, We Ship) programs, so you can't participate in Cubed.",
        showAuthCta: false,
      };
    case "over_18":
      return {
        heading: "You're a little too old for this one",
        body: "Cubed is a YSWS program for teens aged 13–18, and your verified age is 18+. You can't participate yourself, but you're welcome to tell friends aged 13–18 about it!",
        showAuthCta: false,
      };
    case "needs_verification":
      return {
        heading: "Finish verifying your identity",
        body: "Cubed requires a verified Hack Club identity before you can participate. Head to Hack Club Auth to finish (or check on) your verification, then come back here.",
        showAuthCta: true,
      };
  }
}
