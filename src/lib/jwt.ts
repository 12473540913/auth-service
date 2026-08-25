import jwt from "jsonwebtoken";
import { config } from "../config.js";

export type AuthTokenPayload = {
  sub: string;
  email: string;
  tokenVersion: number;
  appId?: string;
};

export function signAuthToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn as jwt.SignOptions["expiresIn"],
  });
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  return jwt.verify(token, config.jwtSecret) as AuthTokenPayload;
}
