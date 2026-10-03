/**
 * Redaction. Two layers:
 *
 * 1. By key: any settings field whose name looks like a credential
 *    (password, stream key, token, ...) is replaced by "[redacted]", and URLs
 *    are cut down to their origin (alert-box and widget URLs carry their
 *    token in the path).
 * 2. By value: every string that leaves this process (tool results, log
 *    lines, error messages) is scrubbed of the configured secrets, whatever
 *    the field is called.
 */

export const REDACTED = "[redacted]";

/** Field names that hold credentials in OBS sources, filters and services. */
const SECRET_KEY =
  /(password|passwd|passphrase|(^|_)pass$|^pwd$|secret|token|bearer|cookie|credential|(^|_)auth($|_|orization)|api_?key|stream_?key|private_?key|^key$|_key$)/i;
/** Field names that are not secrets although they match the pattern above. */
const NOT_SECRET_KEY = /^(key_color|key_color_type|keyint|keyint_sec|keyframe.*|color_key.*|chroma_key.*|luma_key.*|hotkey.*|use_auth)$/i;
/** Field names that hold a URL. */
const URL_KEY = /(^|_)(url|uri|link|webhook)s?$/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key) && !NOT_SECRET_KEY.test(key);
}

function redactUrl(value: string): string {
  try {
    const u = new URL(value);
    if (u.protocol === "file:") return value;
    const hasMore = (u.pathname && u.pathname !== "/") || u.search || u.hash || u.username || u.password;
    return hasMore ? `${u.protocol}//${u.host}/${REDACTED}` : `${u.protocol}//${u.host}`;
  } catch {
    return value;
  }
}

/** Deep copy of `value` with secret-looking fields redacted. */
export function redactSettings<T>(value: T): T {
  return walk(value, undefined) as T;
}

function walk(value: unknown, key: string | undefined): unknown {
  if (key !== undefined && isSecretKey(key)) {
    if (value === "" || value === null || value === undefined) return value;
    return REDACTED;
  }
  if (typeof value === "string") {
    if (key !== undefined && URL_KEY.test(key)) return redactUrl(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, undefined));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, k);
    return out;
  }
  return value;
}

/** Keeps the list of literal secrets that must never appear in any output. */
export class SecretRegistry {
  private readonly secrets = new Set<string>();

  add(secret: string | undefined): void {
    // Very short values would scrub ordinary words; they are rejected by OBS anyway.
    if (secret && secret.length >= 4) this.secrets.add(secret);
  }

  scrub(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join(REDACTED);
    return out;
  }

  /** Scrubs every string inside a JSON-compatible value. */
  scrubDeep<T>(value: T): T {
    if (this.secrets.size === 0) return value;
    return JSON.parse(this.scrub(JSON.stringify(value))) as T;
  }
}
