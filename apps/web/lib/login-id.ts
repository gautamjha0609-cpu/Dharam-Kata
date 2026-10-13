/** Login IDs map to an internal auth email (no social login; SRS A5). Kept apart from the database client so the sign-in page stays light. */
export function loginIdToEmail(loginId: string): string {
  return `${loginId.trim().toLowerCase()}@users.dharamkata.app`;
}
export const LOGIN_ID_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
