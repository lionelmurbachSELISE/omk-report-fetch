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
  const body = new URLSearchParams();
  body.append("grant_type", "password");
  body.append("username", email);
  body.append("password", password);

  const resp = await fetch(`${BLOCKS_API}/idp/v1/Authentication/Token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-blocks-key": X_BLOCKS_KEY,
    },
    body,
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err?.message ?? err?.title ?? `Login failed: ${resp.status}`);
  }

  const data = await resp.json() as {
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
  };

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

export async function refreshTokens(currentRefreshToken: string): Promise<AuthTokens> {
  const body = new URLSearchParams();
  body.append("grant_type", "refresh_token");
  body.append("refresh_token", currentRefreshToken);

  const resp = await fetch(`${BLOCKS_API}/idp/v1/Authentication/Token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "x-blocks-key": X_BLOCKS_KEY,
    },
    body,
  });

  if (!resp.ok) throw new Error(`Token refresh failed: ${resp.status}`);

  const data = await resp.json() as {
    accessToken?: string;
    access_token?: string;
    refreshToken?: string;
    refresh_token?: string;
    expiresIn?: number;
    expires_in?: number;
  };

  return {
    accessToken: data.accessToken ?? data.access_token ?? "",
    refreshToken: data.refreshToken ?? data.refresh_token ?? currentRefreshToken,
    expiresIn: data.expiresIn ?? data.expires_in ?? 3600,
  };
}

export async function logout(refreshToken: string): Promise<void> {
  await blocksPost("/idp/v1/Authentication/Logout", { refreshToken }).catch(() => {});
}

export async function forgotPassword(email: string): Promise<void> {
  await blocksPost("/idp/v1/Iam/ForgotPassword", {
    email,
    projectKey: X_BLOCKS_KEY,
    captchaCode: "",
    preventPostEvent: true,
  });
}

export async function activateAccount(code: string, password: string): Promise<void> {
  await blocksPost("/idp/v1/Iam/Activate", {
    code,
    password,
    captchaCode: "",
    projectKey: X_BLOCKS_KEY,
    preventPostEvent: true,
  });
}
