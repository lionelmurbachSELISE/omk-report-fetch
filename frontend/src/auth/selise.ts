const BLOCKS_API = import.meta.env.VITE_BLOCKS_API_URL as string;
const X_BLOCKS_KEY = import.meta.env.VITE_X_BLOCKS_KEY as string;

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

async function blocksPost<T>(path: string, body: unknown): Promise<T> {
  const resp = await fetch(`${BLOCKS_API}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-blocks-key": X_BLOCKS_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data?.message ?? data?.title ?? `Auth error ${resp.status}`);
  }

  return resp.json() as Promise<T>;
}

export async function login(email: string, password: string): Promise<AuthSession> {
  const data = await blocksPost<{
    accessToken?: string;
    access_token?: string;
    refreshToken?: string;
    refresh_token?: string;
    expiresIn?: number;
    expires_in?: number;
    user?: SeliseUser;
    email?: string;
    name?: string;
    userId?: string;
  }>("/idp/v1/Authentication/Token", {
    grant_type: "password",
    username: email,
    password,
  });

  const accessToken = data.accessToken ?? data.access_token ?? "";
  const refreshToken = data.refreshToken ?? data.refresh_token ?? "";
  const expiresIn = data.expiresIn ?? data.expires_in ?? 3600;
  const user: SeliseUser = data.user ?? {
    email: data.email ?? email,
    name: data.name ?? email,
    userId: data.userId ?? "",
  };

  return { tokens: { accessToken, refreshToken, expiresIn }, user };
}

export async function refreshTokens(refreshToken: string): Promise<AuthTokens> {
  const data = await blocksPost<{
    accessToken?: string;
    access_token?: string;
    refreshToken?: string;
    refresh_token?: string;
    expiresIn?: number;
    expires_in?: number;
  }>("/idp/v1/Authentication/Token", {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  return {
    accessToken: data.accessToken ?? data.access_token ?? "",
    refreshToken: data.refreshToken ?? data.refresh_token ?? refreshToken,
    expiresIn: data.expiresIn ?? data.expires_in ?? 3600,
  };
}

export async function logout(refreshToken: string): Promise<void> {
  await blocksPost("/idp/v1/Authentication/Logout", { refreshToken }).catch(() => {});
}
