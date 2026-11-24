import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const MIN_TOKEN_BYTES = 32;
const MAX_TOKEN_BYTES = 512;

export interface AiAccessGuardOptions {
  accessToken?: string;
  production?: boolean;
}

/**
 * Production-only bearer gate for the server-owned Gemini endpoints.
 * Development remains frictionless; production fails closed if no sufficiently
 * strong access token is configured. This is an access gate, not a user-account system.
 */
export function createAiAccessGuard(options: AiAccessGuardOptions = {}) {
  const expected = String(options.accessToken ?? '').trim();
  const expectedBytes = Buffer.from(expected, 'utf8');
  const configured = expectedBytes.length >= MIN_TOKEN_BYTES && expectedBytes.length <= MAX_TOKEN_BYTES;
  const production = options.production === true;

  return function aiAccessGuard(req: Request, res: Response, next: NextFunction): void {
    if (!production) {
      next();
      return;
    }
    if (!configured) {
      res.status(503).json({
        error: 'Built-in cloud AI is disabled because the server access token is not configured.',
      });
      return;
    }
    const authorization = req.get('authorization') ?? '';
    const candidate = authorization.slice(0, 7).toLowerCase() === 'bearer '
      ? authorization.slice(7).trim()
      : '';
    const candidateBytes = Buffer.from(candidate, 'utf8');
    const valid = candidateBytes.length === expectedBytes.length &&
      timingSafeEqual(candidateBytes, expectedBytes);
    if (!valid) {
      res.status(401).json({ error: 'A valid SYN MASTER cloud AI access token is required.' });
      return;
    }
    next();
  };
}
