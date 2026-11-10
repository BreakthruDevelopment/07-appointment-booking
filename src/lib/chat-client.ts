import type { ProposalView } from "@/lib/assistant/proposals";
import { formatDateTime } from "@/lib/slot-format";

/**
 * Client-side logic for the chat panel, kept free of React so it can be tested. The panel only ever renders what
 * the server returned: the card comes from `proposal`, never from the assistant's text, and its label from `kind`.
 */

export const MESSAGE_MAX = 500;
/** Most fresh times shown after a 409. */
export const FRESH_MAX = 6;

export type Proposal = Pick<ProposalView, "id" | "kind" | "status" | "serviceName" | "durationMin" | "startsAt" | "endsAt" | "providerName" | "providerTz" | "expiresAt">;

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  suggestions: string[];
  proposal: Proposal | null;
  /** Set locally on a reply that came from the recorded demo script. */
  demo?: boolean;
  /** Set locally on the canned "couldn't finish" reply. */
  fallback?: boolean;
};

export const STARTER_SUGGESTIONS = ["What times are open this week?", "Anything tomorrow afternoon?", "Cancel my next appointment"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** `trimmed` length is what the server checks (1-500); the counter shows the raw length the textarea holds. */
export function messageState(raw: string): { length: number; trimmed: string; valid: boolean; over: boolean } {
  const trimmed = raw.trim();
  return { length: raw.length, trimmed, valid: trimmed.length >= 1 && trimmed.length <= MESSAGE_MAX, over: raw.length > MESSAGE_MAX };
}

/** What the confirm card says, from `kind` only. */
export function cardLabels(kind: Proposal["kind"]): { badge: string; heading: string; confirm: string; pending: string; done: string } {
  return kind === "cancel"
    ? { badge: "Cancel", heading: "Cancel this appointment?", confirm: "Confirm cancellation", pending: "Cancelling…", done: "Cancelled" }
    : { badge: "Book", heading: "Book this time?", confirm: "Confirm booking", pending: "Booking…", done: "Booked" };
}

export const DISMISS_LABEL = "Not now";

function asProposal(v: unknown): Proposal | null {
  if (!isObject(v)) return null;
  const id = str(v.id);
  const kind = v.kind === "book" || v.kind === "cancel" ? v.kind : null;
  const status = v.status === "open" || v.status === "used" || v.status === "expired" ? v.status : null;
  const providerName = str(v.providerName);
  const providerTz = str(v.providerTz);
  const expiresAt = str(v.expiresAt);
  if (!id || !kind || !status || providerName === null || !providerTz || !expiresAt) return null;
  return {
    id,
    kind,
    status,
    serviceName: str(v.serviceName),
    durationMin: typeof v.durationMin === "number" ? v.durationMin : null,
    startsAt: str(v.startsAt),
    endsAt: str(v.endsAt),
    providerName,
    providerTz,
    expiresAt,
  };
}

function asMessage(v: unknown): ChatMessage | null {
  if (!isObject(v)) return null;
  const id = str(v.id);
  const text = str(v.text);
  const createdAt = str(v.createdAt);
  if (!id || text === null || !createdAt || (v.role !== "user" && v.role !== "assistant")) return null;
  const suggestions = Array.isArray(v.suggestions) ? v.suggestions.filter((s): s is string => typeof s === "string" && s.length > 0).slice(0, 3) : [];
  return { id, role: v.role, text, createdAt, suggestions, proposal: asProposal(v.proposal) };
}

/** The saved conversation from `GET /api/chat/:slug`; `null` when the body isn't the expected shape. */
export function parseHistory(body: unknown): ChatMessage[] | null {
  if (!isObject(body) || !Array.isArray(body.messages)) return null;
  const messages = body.messages.map(asMessage);
  return messages.every((m): m is ChatMessage => m !== null) ? messages : null;
}

export type TurnOutcome =
  | { kind: "ok"; messages: ChatMessage[]; demo: boolean; fallback: boolean }
  | { kind: "error"; message: string; signIn?: boolean };

/** Map a `POST /api/chat/:slug` response to what the panel does. */
export function interpretTurn(status: number, body: unknown): TurnOutcome {
  const serverMessage = isObject(body) ? str(body.error) : null;
  if (status === 200 && isObject(body) && Array.isArray(body.messages)) {
    const demo = body.demo === true;
    const fallback = body.fallback === true;
    const parsed = body.messages.map(asMessage);
    const assistant = parsed.filter((m): m is ChatMessage => m !== null);
    if (assistant.length === parsed.length && assistant.length > 0) {
      // The reply's tag goes on the assistant message only; the card is whatever the server attached to it.
      const messages = assistant.map((m) => (m.role === "assistant" ? { ...m, ...(demo ? { demo: true } : {}), ...(fallback ? { fallback: true } : {}) } : m));
      return { kind: "ok", messages, demo, fallback };
    }
    return { kind: "error", message: "The assistant's reply wasn't readable. Try again." };
  }
  if (status === 401) return { kind: "error", message: "Your session ended. Sign in to keep chatting.", signIn: true };
  if (status === 429) return { kind: "error", message: serverMessage ?? "You've reached the chat limit for now. Try again later, or pick a time on the booking page." };
  if (status === 502 || status === 503 || status === 504) return { kind: "error", message: "The assistant isn't available right now. Try again in a moment, or pick a time on the booking page." };
  if (status === 404) return { kind: "error", message: "This booking page isn't available any more." };
  if (status === 400 && serverMessage) return { kind: "error", message: serverMessage };
  return { kind: "error", message: "Something went wrong sending that. Try again." };
}

export type ConfirmOutcome =
  | { kind: "done"; action: "booked" | "cancelled"; bookingId: string | null }
  /** The time is gone: show these fresh ISO starts and let the customer ask again. Confirm stays off. */
  | { kind: "taken"; message: string; fresh: string[] }
  /** The card can't be used any more (spent, expired, deleted, or the cancel window closed). */
  | { kind: "closed"; reason: "used" | "expired" | "gone" | "cancellation_closed"; message: string }
  /** Nothing was booked and the card still works: try again. */
  | { kind: "retry"; message: string; code?: string; signIn?: boolean };

export function freshSlots(body: unknown): string[] {
  const slots = isObject(body) && Array.isArray(body.slots) ? body.slots : [];
  return slots.filter((s): s is string => typeof s === "string" && !Number.isNaN(Date.parse(s))).slice(0, FRESH_MAX);
}

/**
 * Map a `POST /api/bookings { proposalId }` response. Success is decided by the server's `action`
 * ("booked" 201, "cancelled" 200: also what an already-cancelled booking returns), not by the card's own kind.
 */
export function interpretConfirm(status: number, body: unknown): ConfirmOutcome {
  const obj = isObject(body) ? body : {};
  const code = str(obj.code) ?? undefined;
  const message = str(obj.error);
  if ((status === 201 || status === 200) && (obj.action === "booked" || obj.action === "cancelled")) {
    const booking = isObject(obj.booking) ? obj.booking : null;
    return { kind: "done", action: obj.action, bookingId: booking ? str(booking.id) : null };
  }
  if (status === 409) {
    if (code === "slot_taken" || code === "slot_unavailable") {
      return { kind: "taken", message: message ?? "That time was just taken.", fresh: freshSlots(body) };
    }
    if (code === "proposal_used") return { kind: "closed", reason: "used", message: "This card was already used." };
    if (code === "proposal_expired") return { kind: "closed", reason: "expired", message: "This card expired. Ask the assistant again." };
    if (code === "cancellation_closed") return { kind: "closed", reason: "cancellation_closed", message: message ?? "Online cancellation has closed for this appointment." };
    if (code === "limit_reached") return { kind: "retry", message: message ?? "You've reached your booking limit.", code };
    return { kind: "retry", message: message ?? "That couldn't be confirmed. Try again.", code };
  }
  if (status === 404) return { kind: "closed", reason: "gone", message: "This card isn't available any more." };
  if (status === 401) return { kind: "retry", message: "Your session ended. Sign in to continue.", signIn: true };
  if (status === 429) return { kind: "retry", message: message ?? "Too many attempts. Wait a bit and try again.", code: "rate_limited" };
  return { kind: "retry", message: "Couldn't confirm that. Check your connection and try again." };
}

/** Result of `POST /api/proposals/:id/dismiss`: 200 and 404 (not yours or gone) both end the card. */
export function interpretDismiss(status: number): { ok: boolean; message?: string } {
  if (status === 200 || status === 404) return { ok: true };
  if (status === 401) return { ok: false, message: "Your session ended. Sign in to continue." };
  return { ok: false, message: "Couldn't dismiss that. Try again." };
}

/** A card can only be acted on while open and before its own expiry. */
export function effectiveStatus(proposal: Pick<Proposal, "status" | "expiresAt">, nowMs: number): Proposal["status"] {
  if (proposal.status === "open" && Date.parse(proposal.expiresAt) <= nowMs) return "expired";
  return proposal.status;
}

/** Only the newest card in the conversation can be acted on; the server keeps one open at a time. */
export function latestCardId(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const p = messages[i].proposal;
    if (p) return p.id;
  }
  return null;
}

/** Add new messages, skipping ones already shown (same id). */
export function appendMessages(current: ChatMessage[], added: ChatMessage[]): ChatMessage[] {
  const seen = new Set(current.map((m) => m.id));
  return [...current, ...added.filter((m) => !seen.has(m.id))];
}

/** The text sent when the customer taps a fresh time after a 409. Plain words, no ids. */
export function freshTimePrompt(serviceName: string | null, iso: string, zone: string): string {
  const when = formatDateTime(iso, zone);
  return (serviceName ? `Please book ${serviceName} for ${when}.` : `Please book me for ${when}.`).slice(0, MESSAGE_MAX);
}
