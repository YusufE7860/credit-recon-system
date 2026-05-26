/**
 * Tiny fetch wrapper that handles the bits every API call needs:
 *  - prepends NEXT_PUBLIC_API_URL
 *  - sends the auth cookie (`credentials: 'include'`)
 *  - parses JSON
 *  - throws on non-2xx with a useful message
 *  - bounces to /login on 401
 *
 * Use `api()` for JSON requests, `apiUpload()` for multipart uploads.
 */

const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

// Run after every response. If the user's session expired, send them
// to login. Lives in one place so we don't sprinkle redirects everywhere.
function handleAuthFailure() {
  if (typeof window !== 'undefined') {
    window.location.href = '/login';
  }
}

// Read the JSON body if present, falling back to text or null.
async function readErrorBody(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data?.message ?? res.statusText;
  } catch {
    return res.statusText;
  }
}

// Main JSON API call. Pass `json` for an automatic JSON body+header.
export async function api<T = any>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, headers, ...rest } = init;

  const finalHeaders = new Headers(headers);
  let body = rest.body as BodyInit | null | undefined;

  if (json !== undefined) {
    finalHeaders.set('Content-Type', 'application/json');
    body = JSON.stringify(json);
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...rest,
    body,
    headers: finalHeaders,
    credentials: 'include',
  });

  if (res.status === 401) {
    handleAuthFailure();
    throw new ApiError(401, 'Session expired');
  }
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorBody(res));
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// Multipart uploads. Browser sets the correct Content-Type with boundary,
// so we must NOT set it manually — that's why this is a separate function.
export async function apiUpload<T = any>(
  path: string,
  formData: FormData,
): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    body: formData,
    credentials: 'include',
  });

  if (res.status === 401) {
    handleAuthFailure();
    throw new ApiError(401, 'Session expired');
  }
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorBody(res));
  }
  return (await res.json()) as T;
}

// Fetch a file (image/PDF) as a Blob URL we can use as <img src=...>.
// Needed because <img> tags don't include credentials by default in
// cross-origin requests, so we fetch it manually and create a blob URL.
export async function fetchFileAsBlobUrl(path: string): Promise<string> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
  });
  if (res.status === 401) {
    handleAuthFailure();
    throw new ApiError(401, 'Session expired');
  }
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorBody(res));
  }
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}
