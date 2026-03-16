import crypto from 'crypto';

// Generated once when the server process starts.
// A new value is created on every server restart.
export const serverStartId = crypto.randomUUID();
