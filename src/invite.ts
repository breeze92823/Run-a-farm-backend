import { INVITES_MAX, INVITES_SENT_MAX, USER_ID_PATTERN } from "./constants.js";
import type { PlayerDoc } from "./db.js";

// Invites, which unlock the client's two money boosts (client config.js GAME.boosts):
//  - Money Boost: the player has sent at least one invite (`sent`): a direct Bloxity invite to a
//    friend (`invited` { friendId }, remembered in `invitesSent`) or a shared invite link
//    (`inviteLink`, `linkShared`).
//  - Friends Boost: at least one invited friend actually joined (`joined` = the doc's `invites`),
//    credited by the server: a SIGNED-IN player joins through the inviter's link (`ref` in the join
//    options) or after the inviter's direct invite; each account counts once ever (`invitedBy` is
//    set once, with a conditional write, so two rooms or pods can't both credit it).
// Signed-in players only: a guest can't invite through Bloxity, nor be credited.
export interface InviteState {
  sent: string[]; // friend ids invited directly (newest last, bounded)
  linkShared: boolean; // shared the invite link at least once
  joined: number; // friends who joined through this player's invites
}

export const isUserId = (v: unknown): v is string => typeof v === "string" && USER_ID_PATTERN.test(v);

// The saved state from a player's doc (missing fields = nothing yet), bounded.
export function readInvite(doc: Partial<PlayerDoc> | null): InviteState {
  const joined = Number.isInteger(doc?.invites) ? Math.min(INVITES_MAX, Math.max(0, doc!.invites!)) : 0;
  const sent = Array.isArray(doc?.invitesSent) ? [...new Set(doc!.invitesSent!.filter(isUserId))].slice(-INVITES_SENT_MAX) : [];
  return { sent, linkShared: doc?.linkShared === true, joined };
}

// Remembers a direct invite (newest last, bounded). False when it changed nothing.
export function rememberSent(s: InviteState, friendId: string): boolean {
  if (s.sent[s.sent.length - 1] === friendId) return false;
  s.sent = [...s.sent.filter((id) => id !== friendId), friendId].slice(-INVITES_SENT_MAX);
  return true;
}

// What the client is sent (`invite`): whether each boost is unlocked, plus the counts.
export const inviteView = (s: InviteState) => ({
  sent: s.sent.length > 0 || s.linkShared,
  joined: s.joined,
  moneyBoost: s.sent.length > 0 || s.linkShared,
  friendsBoost: s.joined > 0,
});
