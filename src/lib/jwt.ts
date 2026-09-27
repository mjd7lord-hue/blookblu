import jwt, { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';

export type AccessPayload = { sub: string; typ: 'access' };

export function signAccess(userId: string): string {
  const payload: AccessPayload = { sub: userId, typ: 'access' };
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
  });
}

export function verifyAccess(token: string): AccessPayload | null {
  try {
    const p = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;
    return p.typ === 'access' ? p : null;
  } catch {
    return null;
  }
}
