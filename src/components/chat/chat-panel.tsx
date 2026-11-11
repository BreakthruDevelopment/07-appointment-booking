"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useViewerZone } from "@/components/booking/viewer-zone";
import { DemoBadge } from "@/components/ui/DemoBadge";
import { buttonPrimary, buttonSecondary, inputClass } from "@/components/ui/styles";
import { appendMessages, interpretTurn, latestCardId, MESSAGE_MAX, messageState, parseHistory, STARTER_SUGGESTIONS, type ChatMessage } from "@/lib/chat-client";
import { ConfirmCard } from "./confirm-card";

type History = { attempt: number; messages: ChatMessage[] } | { attempt: number; error: string; signIn?: boolean };
type SendError = { message: string; signIn?: boolean } | null;

/**
 * The booking assistant's chat. Messages and replies are plain text children (no markdown, no links made from
 * text, no raw HTML). History comes from GET /api/chat/:slug, turns go through POST /api/chat/:slug, and a card is
 * rendered only from the `proposal` the server attached to a reply.
 */
export function ChatPanel({ slug, providerName }: { slug: string; providerName: string }) {
  const viewerZone = useViewerZone();
  const [attempt, setAttempt] = useState(0);
  const [history, setHistory] = useState<History | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<SendError>(null);
  const [demo, setDemo] = useState(false);
  const [announce, setAnnounce] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const refocus = useRef(false);

  const loading = history?.attempt !== attempt;
  const loaded = history && history.attempt === attempt && "messages" in history ? history : null;
  const loadError = history && history.attempt === attempt && "error" in history ? history : null;

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/chat/${encodeURIComponent(slug)}`, { signal: controller.signal, cache: "no-store" })
      .then(async (res) => {
        const body: unknown = await res.json().catch(() => null);
        if (res.status === 401) return setHistory({ attempt, error: "Sign in to chat with the assistant.", signIn: true });
        const parsed = res.ok ? parseHistory(body) : null;
        if (!parsed) return setHistory({ attempt, error: res.status === 404 ? "This booking page isn't available any more." : "Couldn't load your conversation." });
        setMessages((current) => appendMessages(parsed, current));
        setHistory({ attempt, messages: parsed });
      })
      .catch(() => {
        if (!controller.signal.aborted) setHistory({ attempt, error: "Couldn't load your conversation. Check your connection and try again." });
      });
    return () => controller.abort();
  }, [slug, attempt]);

  // Keep the newest message in view inside the list (the page itself doesn't jump).
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, loaded]);

  // After a turn sent from the box, put the cursor back so the next message is one tap away.
  useEffect(() => {
    if (!sending && refocus.current) {
      refocus.current = false;
      inputRef.current?.focus();
    }
  }, [sending]);

  async function send(raw: string, fromInput: boolean) {
    const state = messageState(raw);
    if (!state.valid || sending !== null) return;
    refocus.current = fromInput;
    setSending(state.trimmed);
    setSendError(null);
    setAnnounce("The assistant is working on your message.");
    try {
      const res = await fetch(`/api/chat/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: state.trimmed, ...(viewerZone ? { timeZone: viewerZone } : {}) }),
      });
      const body: unknown = await res.json().catch(() => null);
      const outcome = interpretTurn(res.status, body);
      if (outcome.kind === "ok") {
        setMessages((current) => appendMessages(current, outcome.messages));
        if (outcome.demo) setDemo(true);
        if (fromInput) setInput("");
        const reply = outcome.messages.find((m) => m.role === "assistant");
        setAnnounce(reply ? `Assistant: ${reply.text}${reply.proposal?.status === "open" ? " A confirm card is below." : ""}` : "");
      } else {
        setSendError({ message: outcome.message, signIn: outcome.signIn });
        setAnnounce("");
      }
    } catch {
      setSendError({ message: "Couldn't reach the server. Check your connection and try again." });
      setAnnounce("");
    } finally {
      setSending(null);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input, true);
    }
  }

  const state = messageState(input);
  const lastId = latestCardId(messages);
  const lastMessage = messages.at(-1);
  const chips = !sending && loaded ? (lastMessage?.role === "assistant" ? lastMessage.suggestions : messages.length === 0 ? STARTER_SUGGESTIONS : []) : [];
  const busy = sending !== null;

  return (
    <div className="space-y-4" data-chat-panel data-chat-slug={slug}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">Ask for a time in plain words. The assistant only suggests; nothing is booked until you tap Confirm.</p>
        {demo && (
          <span data-demo-badge>
            <DemoBadge label="Demo assistant (recorded)" />
          </span>
        )}
      </div>

      <p className="sr-only" role="status" aria-live="polite" data-chat-announce>
        {announce}
      </p>

      <div ref={listRef} className="max-h-[55svh] min-h-40 overflow-y-auto overflow-x-hidden rounded-card border border-border bg-background p-3" data-chat-list>
        {loading && (
          <p role="status" className="py-6 text-center text-sm text-muted" data-chat-loading>
            Loading your conversation…
          </p>
        )}
        {loadError && (
          <div role="alert" className="space-y-2 rounded-card border border-border bg-blocked-soft px-4 py-3 text-sm text-blocked" data-chat-error>
            <p>{loadError.error}</p>
            {loadError.signIn ? (
              <Link href={`/sign-in?next=${encodeURIComponent(`/p/${slug}/chat`)}`} className={buttonPrimary}>
                Sign in
              </Link>
            ) : (
              <button type="button" className={buttonSecondary} onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </button>
            )}
          </div>
        )}
        {loaded && messages.length === 0 && !sending && (
          <p className="py-6 text-center text-sm text-muted" data-chat-empty>
            No messages yet. Ask {providerName}&apos;s assistant about open times, or try one of the suggestions below.
          </p>
        )}
        {(loaded || messages.length > 0) && (
          <ol className="space-y-3" aria-label="Conversation">
            {messages.map((m) => (
              <li key={m.id} className="space-y-2" data-message-role={m.role} data-message-id={m.id} data-fallback={m.fallback ? "true" : undefined}>
                <div className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[88%] whitespace-pre-wrap break-words rounded-card px-3 py-2 text-sm ${
                      m.role === "user" ? "bg-accent text-accent-foreground" : "border border-border bg-surface"
                    }`}
                  >
                    <span className="sr-only">{m.role === "user" ? "You said: " : "Assistant said: "}</span>
                    {m.text}
                    {m.role === "assistant" && m.demo && (
                      <span className="mt-1 block">
                        <DemoBadge label="Demo reply" />
                      </span>
                    )}
                  </div>
                </div>
                {m.fallback && (
                  <p className="text-sm text-muted">
                    The assistant couldn&apos;t finish that.{" "}
                    <Link href={`/p/${slug}`} className="inline-flex min-h-11 items-center font-medium text-accent underline underline-offset-2" data-action="open-booking-page">
                      See open times on the booking page
                    </Link>
                  </p>
                )}
                {m.role === "assistant" && m.proposal && (
                  <ConfirmCard proposal={m.proposal} slug={slug} viewerZone={viewerZone} superseded={m.proposal.id !== lastId} busy={busy} onAsk={(text) => void send(text, false)} />
                )}
              </li>
            ))}
            {sending && (
              <li data-message-role="user" data-pending="true" className="space-y-2">
                <div className="flex justify-end">
                  <div className="max-w-[88%] whitespace-pre-wrap break-words rounded-card bg-accent px-3 py-2 text-sm text-accent-foreground opacity-80">{sending}</div>
                </div>
                <p className="text-sm text-muted" aria-hidden="true">
                  Assistant is thinking…
                </p>
              </li>
            )}
          </ol>
        )}
      </div>

      {chips.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Suggestions" data-chat-suggestions>
          {chips.map((chip) => (
            <li key={chip}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void send(chip, false)}
                className="min-h-11 rounded-full border border-border-strong bg-surface px-4 text-sm font-medium hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-60"
              >
                {chip}
              </button>
            </li>
          ))}
        </ul>
      )}

      {sendError && (
        <div role="alert" className="space-y-2 rounded-card border border-border bg-blocked-soft px-4 py-3 text-sm text-blocked" data-chat-send-error>
          <p>{sendError.message}</p>
          {sendError.signIn && (
            <Link href={`/sign-in?next=${encodeURIComponent(`/p/${slug}/chat`)}`} className={buttonPrimary}>
              Sign in
            </Link>
          )}
        </div>
      )}

      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input, true);
        }}
      >
        <label htmlFor="chat-message" className="block text-sm font-medium">
          Your message
        </label>
        <textarea
          id="chat-message"
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={MESSAGE_MAX}
          rows={3}
          disabled={busy || !loaded}
          aria-describedby="chat-count"
          placeholder="Anything Tuesday after 3?"
          className={inputClass}
          data-chat-input
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span id="chat-count" className={`text-xs ${state.length >= MESSAGE_MAX ? "font-semibold text-danger" : "text-muted"}`} data-chat-count>
            {state.length} / {MESSAGE_MAX}
          </span>
          <button type="submit" disabled={busy || !loaded || !state.valid} className={`${buttonPrimary} w-full sm:w-auto`} data-action="send">
            {busy ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
