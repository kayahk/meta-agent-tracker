/**
 * GitHub App authentication: JWT signing + installation token exchange.
 */

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

export interface GitHubAppCredentials {
  appId: string;
  privateKeyPath: string;
  installationId: string;
}

export interface InstallationTokenResult {
  token: string;
  expiresAt: Date;
}

/**
 * Generate a JWT signed with the GitHub App's private key (RS256).
 */
function generateJwt(appId: string, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      iat: now - 60, // issued 60s ago (clock skew tolerance)
      exp: now + 600, // expires in 10 min
      iss: appId
    })
  ).toString("base64url");

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey, "base64url");

  return `${header}.${payload}.${signature}`;
}

/**
 * Exchange a GitHub App JWT for an installation access token.
 */
export async function createInstallationToken(
  credentials: GitHubAppCredentials
): Promise<InstallationTokenResult> {
  const privateKey = readFileSync(credentials.privateKeyPath, "utf8");
  const jwt = generateJwt(credentials.appId, privateKey);

  const resp = await fetch(
    `https://api.github.com/app/installations/${credentials.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: AbortSignal.timeout(15000)
    }
  );

  if (!resp.ok) {
    const err = await resp.text().catch(() => "");
    throw new Error(`GitHub installation token error ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { token: string; expires_at: string };
  return {
    token: data.token,
    expiresAt: new Date(data.expires_at)
  };
}
