import { env, randomId } from './utils';
import { Issuer, generators } from 'openid-client';
import type { DB } from './db';

type OIDCClient = {
  authorizeURL: (state: string, code_challenge: string) => string;
  callback: (params: { state: string; code: string; code_verifier: string }) => Promise<{
    sub: string; email?: string; name?: string;
  }>;
};

let cachedClient: OIDCClient | null = null;

export async function getOIDC(): Promise<OIDCClient> {
  if (cachedClient) return cachedClient;
  const issuerUrl = env('OIDC_ISSUER');
  const clientId = env('OIDC_CLIENT_ID');
  const clientSecret = env('OIDC_CLIENT_SECRET');
  const redirectUri = env('OIDC_REDIRECT_URI');

  const issuer = await Issuer.discover(issuerUrl);
  const client = new issuer.Client({
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uris: [redirectUri],
    response_types: ['code']
  });

  cachedClient = {
    authorizeURL: (state: string, code_challenge: string) => {
      const url = client.authorizationUrl({
        scope: 'openid email profile',
        state,
        code_challenge,
        code_challenge_method: 'S256'
      });
      return url;
    },
    callback: async ({ state, code, code_verifier }) => {
      const tokenSet = await client.callback(redirectUri, { code, state }, { code_verifier });
      const userinfo = await client.userinfo(tokenSet.access_token!);
      return {
        sub: (userinfo.sub as string) ?? '',
        email: (userinfo.email as string | undefined),
        name: (userinfo.name as string | undefined)
      };
    }
  };

  return cachedClient;
}

// Helpers to store ephemeral OIDC state in cookies (signed state is out of scope; running on same origin only).
export function createOIDCStateCookies() {
  const state = generators.state();
  const code_verifier = generators.codeVerifier();
  const code_challenge = generators.codeChallenge(code_verifier);
  const value = Buffer.from(JSON.stringify({ state, code_verifier })).toString('base64url');
  return { state, code_challenge, cookieValue: value };
}

export function readOIDCStateCookie(cookie: string | null) {
  if (!cookie) return null;
  try {
    const json = Buffer.from(cookie, 'base64url').toString('utf-8');
    return JSON.parse(json) as { state: string; code_verifier: string };
  } catch {
    return null;
  }
}

export async function handleLoginRedirect(baseUrl: string) {
  const { state, code_challenge, cookieValue } = createOIDCStateCookies();
  const client = await getOIDC();
  const url = client.authorizeURL(state, code_challenge);
  return { url, cookieValue };
}

export async function handleCallback(db: DB, params: URLSearchParams, oidcCookie: string | null) {
  const state = params.get('state') ?? '';
  const code = params.get('code') ?? '';
  const st = readOIDCStateCookie(oidcCookie);
  if (!st || st.state !== state) throw new Error('Invalid OIDC state');

  const client = await getOIDC();
  const profile = await client.callback({ state, code, code_verifier: st.code_verifier });

  // Map OIDC profile to user (must already be authorized in DB)
  const hl7_id = profile.sub;
  const email = profile.email ?? '';
  const name = profile.name ?? email ?? 'Unknown';

  // Upsert user basic info (org_role default TSC if unknown)
  const user = db.createOrUpdateUser({ hl7_id, email, name });

  // Optional: auto-admin by email list
  const seedAdmins = (process.env.SEED_ADMIN_EMAILS ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (seedAdmins.includes((email ?? '').toLowerCase())) {
    db.setAdminByEmail(email);
    const refreshed = db.getUserById(user.id)!;
    return refreshed;
  }
  return user;
}
