// Talks directly to the backend — sends the session
// cookie via `credentials` and the header the backend's CSRF middleware requires.
const BACKEND_URL = import.meta.env.PUBLIC_BACKEND_URL;

export async function apiFetch(path: string, init: RequestInit = {}) {
  const method = (init.method ?? "GET").toUpperCase();
  const needsCsrfHeader = method !== "GET" && method !== "HEAD";

  return fetch(`${BACKEND_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...init.headers,
      ...(needsCsrfHeader ? { "X-Requested-With": "cubed" } : {}),
    },
  });
}
