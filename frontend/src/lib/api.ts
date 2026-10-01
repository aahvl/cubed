// Server-side (Astro SSR) fetch helper — forwards the incoming request's  session cookie to the backend so route handlers can check auth before
// rendering. Never call this from the browser
export async function serverApiFetch(request: Request, path: string, init: RequestInit = {}) {
  const backendUrl = import.meta.env.BACKEND_URL;
  const cookie = request.headers.get("cookie") ?? "";

  return fetch(`${backendUrl}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      cookie,
    },
  });
}

// Mirrors backend/src/integrations/hackclub-auth.ts's YswsStatus exactly.
export type YswsStatus =
  | "needs_submission"
  | "pending"
  | "verified_eligible"
  | "verified_but_over_18"
  | "rejected"
  | "not_found";

export type Me = {
  id: string;
  slackId: string;
  email: string;
  nickname: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  hackatimeBanned: boolean;
  yswsStatus: YswsStatus | null;
  molesBalance: number;
  onboardedAt: string | null;
};

export async function getSessionUser(request: Request): Promise<Me | null> {
  try {
    const response = await serverApiFetch(request, "/me");
    if (!response.ok) return null;
    return await response.json();
  } catch {
    // Backend unreachable — fail closed rather than 500 the whole page.
    return null;
  }
}
