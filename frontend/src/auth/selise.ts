// All Blocks IAM calls now go through iam.seliseblocks.com (new IDP),
// NOT api.seliseblocks.com/idp/v1/ (legacy, Application_Not_Found for this project).
const IAM_BASE = "https://iam.seliseblocks.com";
const TENANT_ID = import.meta.env.VITE_X_BLOCKS_KEY as string;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface SeliseUser {
  email: string;
  name: string;
  userId: string;
}

export interface AuthSession {
  tokens: AuthTokens;
  user: SeliseUser;
}

function iamUrl(path: string): string {
  return `${IAM_BASE}${path}?tenant_id=${TENANT_ID}`;
}

async function iamPost<T>(path: string, body: unknown, accessToken?: string): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const resp = await fetch(iamUrl(path), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(
      data?.error_description ??
      data?.errors?.Code ??
      data?.message ??
      data?.title ??
      `Auth error ${resp.status}`
    );
  }

  const result = await resp.json() as Record<string, unknown>;

  // Some endpoints wrap the result with isSuccess/errors
  if (result && result.isSuccess === false) {
    const errors = result.errors as Record<string, string> | null;
    const msg = errors ? Object.values(errors)[0] : `Auth error: request failed`;
    throw new Error(msg);
  }

  return result as T;
}

export async function login(email: string, password: string): Promise<AuthSession> {
  const data = await iamPost<{
    accessToken?: string;
    access_token?: string;
    refreshToken?: string;
    refresh_token?: string;
    expiresIn?: number;
    expires_in?: number;
    email?: string;
    name?: string;
    userName?: string;
    userId?: string;
    user?: SeliseUser;
  }>("/api/auth/login", { email, password });

  const accessToken = data.accessToken ?? data.access_token ?? "";
  const refreshToken = data.refreshToken ?? data.refresh_token ?? "";
  const expiresIn = data.expiresIn ?? data.expires_in ?? 3600;
  const user: SeliseUser = data.user ?? {
    email: data.email ?? email,
    name: data.name ?? data.userName ?? email,
    userId: data.userId ?? "",
  };

  return { tokens: { accessToken, refreshToken, expiresIn }, user };
}

export async function refreshTokens(currentRefreshToken: string): Promise<AuthTokens> {
  const data = await iamPost<{
    accessToken?: string;
    access_token?: string;
    refreshToken?: string;
    refresh_token?: string;
    expiresIn?: number;
    expires_in?: number;
  }>("/api/auth/refresh", { refreshToken: currentRefreshToken });

  return {
    accessToken: data.accessToken ?? data.access_token ?? "",
    refreshToken: data.refreshToken ?? data.refresh_token ?? currentRefreshToken,
    expiresIn: data.expiresIn ?? data.expires_in ?? 3600,
  };
}

export async function logout(refreshToken: string, accessToken?: string): Promise<void> {
  await iamPost("/api/auth/logout", { refreshToken }, accessToken).catch(() => {});
}

export async function forgotPassword(email: string): Promise<void> {
  // Try both known paths; swallow errors since we don't know which one is active
  const tried = await iamPost("/api/auth/forgot-password", { email }).catch(() => null);
  if (!tried) {
    await iamPost("/api/iam/forgot-password", { email }).catch(() => {});
  }
}

export async function activateAccount(code: string, password: string): Promise<void> {
  await iamPost("/api/auth/activate", { code, password });
}
