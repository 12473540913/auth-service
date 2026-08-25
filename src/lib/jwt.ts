import jwt from "jsonwebtoken";
import { config } from "../config.js";

const ISSUER = "auth-service";

export type AuthTokenPayload = {
  sub: string;
  email: string;
  tokenVersion: number;
  appId: string;
};

// All tenants share one signing secret, so the app id is pinned into the audience claim.
// Without this a token minted for one app would authenticate against every other app.
export function signAuthToken(payload: AuthTokenPayload): string {
  const { appId, ...claims } = payload;
  return jwt.sign(claims, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as jwt.SignOptions["expiresIn"],
    audience: appId,
    issuer: ISSUER,
  });
}

export function verifyAuthToken(token: string, appId: string): AuthTokenPayload {
  const decoded = jwt.verify(token, config.jwtSecret, {
    audience: appId,
    issuer: ISSUER,
  }) as jwt.JwtPayload;

  return {
    sub: String(decoded.sub),
    email: String(decoded.email),
    tokenVersion: Number(decoded.tokenVersion),
    appId,
  };
}
