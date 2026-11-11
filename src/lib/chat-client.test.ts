import { describe, expect, it } from "vitest";
import {
  appendMessages,
  cardLabels,
  effectiveStatus,
  freshSlots,
  freshTimePrompt,
  FRESH_MAX,
  interpretConfirm,
  interpretDismiss,
  interpretTurn,
  latestCardId,
  messageState,
  MESSAGE_MAX,
  parseHistory,
  type ChatMessage,
} from "./chat-client";

const proposal = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  kind: "book",
  status: "open",
  serviceName: "Haircut",
  durationMin: 30,
  startsAt: "2030-01-08T22:00:00.000Z",
  endsAt: "2030-01-08T22:30:00.000Z",
  providerName: "Demo Studio",
  providerTz: "America/Denver",
  expiresAt: "2030-01-01T00:10:00.000Z",
  ...over,
});
const msg = (id: string, role: "user" | "assistant", over: Record<string, unknown> = {}) => ({
  id,
  role,
  text: "hello",
  createdAt: "2030-01-01T00:00:00.000Z",
  suggestions: [],
  proposal: null,
  ...over,
});

describe("messageState", () => {
  it("counts raw length and validates the trimmed text", () => {
    expect(messageState("")).toMatchObject({ valid: false, length: 0 });
    expect(messageState("   ")).toMatchObject({ valid: false, length: 3 });
    expect(messageState("  hi  ")).toMatchObject({ valid: true, trimmed: "hi", length: 6 });
    expect(messageState("a".repeat(MESSAGE_MAX)).valid).toBe(true);
    expect(messageState("a".repeat(MESSAGE_MAX + 1))).toMatchObject({ valid: false, over: true });
  });
});

describe("cardLabels", () => {
  it("labels Book and Cancel from the kind alone", () => {
    expect(cardLabels("book")).toMatchObject({ badge: "Book", confirm: "Confirm booking", done: "Booked" });
    expect(cardLabels("cancel")).toMatchObject({ badge: "Cancel", confirm: "Confirm cancellation", done: "Cancelled" });
  });
});

describe("parseHistory", () => {
  it("reads messages and their cards", () => {
    const parsed = parseHistory({ messages: [msg("a", "user"), msg("b", "assistant", { suggestions: ["x", "y", "z", "w"], proposal: proposal() })] });
    expect(parsed).toHaveLength(2);
    expect(parsed?.[1].suggestions).toEqual(["x", "y", "z"]);
    expect(parsed?.[1].proposal).toMatchObject({ kind: "book", status: "open", serviceName: "Haircut" });
  });
  it("rejects a body of the wrong shape, and drops a malformed card instead of guessing", () => {
    expect(parseHistory(null)).toBeNull();
    expect(parseHistory({})).toBeNull();
    expect(parseHistory({ messages: [{ id: 1 }] })).toBeNull();
    expect(parseHistory({ messages: [msg("a", "assistant", { proposal: proposal({ kind: "refund" }) })] })?.[0].proposal).toBeNull();
    expect(parseHistory({ messages: [msg("a", "assistant", { role: "tool" })] })).toBeNull();
  });
  it("keeps the text as is (no markup is interpreted)", () => {
    const text = "**bold** [x](https://evil.example) <img src=x onerror=alert(1)>";
    expect(parseHistory({ messages: [msg("a", "assistant", { text })] })?.[0].text).toBe(text);
  });
});

describe("interpretTurn", () => {
  const ok = { messages: [msg("u", "user"), msg("a", "assistant", { proposal: proposal() })], proposal: proposal(), demo: true, fallback: false };
  it("returns the new messages and tags the assistant's reply as demo", () => {
    const out = interpretTurn(200, ok);
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.demo).toBe(true);
    expect(out.messages[0].demo).toBeUndefined();
    expect(out.messages[1]).toMatchObject({ demo: true, proposal: { kind: "book" } });
  });
  it("tags a fallback reply and carries no card", () => {
    const out = interpretTurn(200, { messages: [msg("u", "user"), msg("a", "assistant", { text: "I couldn't finish that." })], proposal: null, demo: false, fallback: true });
    expect(out.kind === "ok" && out.messages[1].fallback).toBe(true);
    expect(out.kind === "ok" && out.messages[1].proposal).toBeNull();
  });
  it("shows the server's message on 429 and a plain one for 502", () => {
    expect(interpretTurn(429, { error: "Too many messages. Try again in 12 minutes." })).toEqual({ kind: "error", message: "Too many messages. Try again in 12 minutes." });
    expect(interpretTurn(429, {})).toMatchObject({ kind: "error" });
    const bad = interpretTurn(502, { error: "upstream said something technical" });
    expect(bad.kind === "error" && bad.message).not.toContain("upstream");
  });
  it("offers sign-in on 401, and survives an unreadable body", () => {
    expect(interpretTurn(401, {})).toMatchObject({ kind: "error", signIn: true });
    expect(interpretTurn(200, { messages: [{}] })).toMatchObject({ kind: "error" });
    expect(interpretTurn(500, null)).toMatchObject({ kind: "error" });
  });
});

describe("interpretConfirm", () => {
  it("201 booked and 200 cancelled are successes decided by the server's action", () => {
    expect(interpretConfirm(201, { action: "booked", booking: { id: "b1" } })).toEqual({ kind: "done", action: "booked", bookingId: "b1" });
    expect(interpretConfirm(200, { action: "cancelled", booking: { id: "b1", status: "cancelled" } })).toEqual({ kind: "done", action: "cancelled", bookingId: "b1" });
  });
  it("does not treat a 200 without an action as success", () => {
    expect(interpretConfirm(200, { booking: {} }).kind).toBe("retry");
  });
  it("slot_taken and slot_unavailable keep the fresh times, capped, valid dates only", () => {
    const slots = ["2030-01-09T17:00:00Z", "nope", 5, ...Array.from({ length: 10 }, (_, i) => `2030-01-1${i}T17:00:00Z`)];
    for (const code of ["slot_taken", "slot_unavailable"]) {
      const out = interpretConfirm(409, { error: "That time was just taken.", code, slots });
      expect(out.kind).toBe("taken");
      if (out.kind === "taken") {
        expect(out.message).toBe("That time was just taken.");
        expect(out.fresh).toHaveLength(FRESH_MAX);
        expect(out.fresh[0]).toBe("2030-01-09T17:00:00Z");
        expect(out.fresh).not.toContain("nope");
      }
    }
    expect(interpretConfirm(409, { code: "slot_taken" })).toMatchObject({ kind: "taken", fresh: [] });
  });
  it("closes the card for used, expired, cancellation_closed and a 404", () => {
    expect(interpretConfirm(409, { code: "proposal_used" })).toMatchObject({ kind: "closed", reason: "used" });
    expect(interpretConfirm(409, { code: "proposal_expired" })).toMatchObject({ kind: "closed", reason: "expired" });
    expect(interpretConfirm(409, { code: "cancellation_closed", error: "Too late to cancel online." })).toMatchObject({ kind: "closed", reason: "cancellation_closed", message: "Too late to cancel online." });
    expect(interpretConfirm(404, { error: "Not found" })).toMatchObject({ kind: "closed", reason: "gone" });
  });
  it("keeps the card usable for 429, limit_reached, 401 and network-ish failures", () => {
    expect(interpretConfirm(429, { error: "Slow down." })).toEqual({ kind: "retry", message: "Slow down.", code: "rate_limited" });
    expect(interpretConfirm(409, { code: "limit_reached", error: "Booking limit reached." })).toMatchObject({ kind: "retry", code: "limit_reached" });
    expect(interpretConfirm(401, {})).toMatchObject({ kind: "retry", signIn: true });
    expect(interpretConfirm(500, null)).toMatchObject({ kind: "retry" });
  });
});

describe("interpretDismiss", () => {
  it("ends the card on 200 and 404, and reports other failures", () => {
    expect(interpretDismiss(200).ok).toBe(true);
    expect(interpretDismiss(404).ok).toBe(true);
    expect(interpretDismiss(500)).toMatchObject({ ok: false });
    expect(interpretDismiss(401)).toMatchObject({ ok: false });
  });
});

describe("effectiveStatus", () => {
  it("expires an open card at its expiry, leaves other states alone", () => {
    const at = Date.parse("2030-01-01T00:10:00.000Z");
    expect(effectiveStatus({ status: "open", expiresAt: "2030-01-01T00:10:00.000Z" }, at - 1)).toBe("open");
    expect(effectiveStatus({ status: "open", expiresAt: "2030-01-01T00:10:00.000Z" }, at)).toBe("expired");
    expect(effectiveStatus({ status: "used", expiresAt: "2030-01-01T00:10:00.000Z" }, at + 1)).toBe("used");
  });
});

describe("conversation helpers", () => {
  const list = parseHistory({ messages: [msg("1", "user"), msg("2", "assistant", { proposal: proposal() }), msg("3", "user"), msg("4", "assistant", { proposal: proposal({ id: "22222222-2222-4222-8222-222222222222" }) })] }) as ChatMessage[];
  it("only the newest card is current", () => {
    expect(latestCardId(list)).toBe("22222222-2222-4222-8222-222222222222");
    expect(latestCardId(list.slice(0, 1))).toBeNull();
  });
  it("append skips messages already shown", () => {
    expect(appendMessages(list, [list[3], { ...list[0], id: "5" }]).map((m) => m.id)).toEqual(["1", "2", "3", "4", "5"]);
  });
  it("freshTimePrompt is plain words inside the message cap", () => {
    const text = freshTimePrompt("Haircut", "2030-01-09T17:00:00Z", "America/Denver");
    expect(text).toMatch(/^Please book Haircut for .*MST\.$/);
    expect(freshTimePrompt(null, "2030-01-09T17:00:00Z", "UTC")).toMatch(/^Please book me for /);
    expect(freshTimePrompt("x".repeat(900), "2030-01-09T17:00:00Z", "UTC").length).toBeLessThanOrEqual(MESSAGE_MAX);
    expect(freshSlots({ slots: "nope" })).toEqual([]);
  });
});
