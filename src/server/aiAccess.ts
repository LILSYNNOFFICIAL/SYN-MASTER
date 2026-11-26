import { createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const COOKIE_NAME = 'syn_master_guest';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const RENEW_WITHIN_MS = 2 * 60 * 60 * 1000;

export interface AiGuestSessionOptions {
  secret?: string;
  providerKey?: string;
  production?: boolean;
  now?: () => number;
}

interface SessionPayload { id: string; expiresAt: number; }

function signature(secret: string, id: string, expiresAt: number): string {
  return createHmac('sha256', secret).update(id + '.' + expiresAt).digest('base64url');
}

function readCookie(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

/** Signed, anonymous guest sessions. The signing key never leaves this server module. */
export function createAiGuestSession(options: AiGuestSessionOptions = {}) {
  const production = options.production === true;
  const now = options.now ?? Date.now;
  const configuredSecret = String(options.secret ?? '').trim();
  const providerKey = String(options.providerKey ?? '').trim();
  const isPlaceholder = (value: string) => /^(GENERATE_|CHANGE_ME|REPLACE_ME|YOUR_|MY_)/i.test(value);
  const configuredSecretIsValid = configuredSecret.length >= 32
    && !isPlaceholder(configuredSecret)
    && configuredSecret !== providerKey;
  // AI Studio provisions GEMINI_API_KEY as a server-side secret automatically.
  // Derive a domain-separated signing key from it when no dedicated override is supplied.
  // HKDF gives every Cloud Run replica the same independent cookie key without requiring
  // another manually configured secret or reusing the raw Gemini credential.
  const derivedSecret = providerKey.length >= 32 && !isPlaceholder(providerKey)
    ? Buffer.from(hkdfSync(
      'sha256',
      providerKey,
      'SYN-MASTER guest-session key derivation v1',
      'HttpOnly signed guest cookie',
      32,
    )).toString('hex')
    : '';
  const secret = configuredSecret
    ? (configuredSecretIsValid ? configuredSecret : '')
    : production
      ? derivedSecret
      : randomBytes(32).toString('hex');

  function parse(req: Request): SessionPayload | null {
    if (!secret) return null;
    const token = readCookie(req.headers.cookie, COOKIE_NAME);
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [id, expiryText, supplied] = parts;
    const expiresAt = Number(expiryText);
    if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isSafeInteger(expiresAt) || expiresAt <= now()) return null;
    const expected = Buffer.from(signature(secret, id, expiresAt));
    const actual = Buffer.from(supplied);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    return { id, expiresAt };
  }

  function sameOrigin(req: Request): boolean {
    const fetchSite = String(req.get('sec-fetch-site') ?? '').toLowerCase();
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return false;
    const origin = req.get('origin');
    if (!origin) return !production && !fetchSite;
    try {
      return new URL(origin).origin === req.protocol + '://' + req.get('host');
    } catch {
      return false;
    }
  }

  function setCookie(req: Request, res: Response, id: string, expiresAt: number): void {
    const token = [id, expiresAt, signature(secret, id, expiresAt)].join('.');
    const maxAge = Math.max(0, Math.floor((expiresAt - now()) / 1000));
    const secure = req.secure ? '; Secure' : '';
    res.setHeader('Set-Cookie', COOKIE_NAME + '=' + token + '; Path=/api/ai; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + secure);
  }

  function bootstrap(req: Request, res: Response): void {
    if (!secret) {
      res.status(503).json({
        error: 'Cloud AI is unavailable because the server-side Gemini connection is not configured. Local DSP mastering remains available.',
        code: !providerKey ? 'missing_key' : 'guest_session',
      });
      return;
    }
    if (!sameOrigin(req)) {
      res.status(403).json({
        error: 'Cloud AI sessions can only be created from the SYN-MASTER application.',
        code: 'guest_session',
      });
      return;
    }
    const existing = parse(req);
    const id = existing?.id ?? randomUUID();
    setCookie(req, res, id, now() + SESSION_TTL_MS);
    res.status(204).end();
  }

  function middleware(req: Request, res: Response, next: NextFunction): void {
    if (!secret) {
      res.status(503).json({
        error: 'Cloud AI is unavailable because the server-side Gemini connection is not configured. Local DSP mastering remains available.',
        code: !providerKey ? 'missing_key' : 'guest_session',
      });
      return;
    }
    if (!sameOrigin(req)) {
      res.status(403).json({
        error: 'Cloud AI requests must originate from the SYN-MASTER application.',
        code: 'guest_session',
      });
      return;
    }
    const session = parse(req);
    if (!session) {
      res.status(401).json({
        error: 'Your Cloud AI session expired. Retry the request to start a new guest session.',
        code: 'guest_session',
      });
      return;
    }
    res.locals.guestSessionId = session.id;
    if (session.expiresAt - now() <= RENEW_WITHIN_MS) setCookie(req, res, session.id, now() + SESSION_TTL_MS);
    next();
  }

  return { bootstrap, middleware, isConfigured: Boolean(secret), readSession: parse };
}
