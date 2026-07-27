export const SESSION_COOKIE_NAME = 'fastquote-session';
export const AUDIT_USER_COOKIE_NAME = 'fastquote-user-id';
// Non-httpOnly companion to SESSION_COOKIE_NAME carrying ONLY the session's expiry
// (unix seconds). The SPA reads it to decide whether it still has a live session; the
// httpOnly session cookie itself is unreadable from JS, so without this the client had
// to re-authenticate on a timer just in case. Written, renewed and cleared in lockstep
// with the session cookie (see middleware.ts / lib/sessionShared.ts) and NEVER trusted
// for authorization — it is a hint about timing, not an identity.
export const SESSION_EXP_COOKIE_NAME = 'fastquote-session-exp';
