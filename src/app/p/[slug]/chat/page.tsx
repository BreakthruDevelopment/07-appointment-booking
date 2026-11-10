import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChatPanel } from "@/components/chat/chat-panel";
import { PageIntro, Panel, buttonOutlineAccent } from "@/components/ui";
import { requireUserOrRedirect } from "@/lib/auth/session";
import { getOwnProfileOrNull, getPublicProvider } from "@/lib/provider";

export const dynamic = "force-dynamic";

const SLUG = /^[a-z0-9-]{3,40}$/;

type Props = { params: Promise<{ slug: string }> };

export const metadata: Metadata = { title: "Booking assistant" };

/**
 * The booking assistant's chat. Signed-in users only (the chat route authorizes again). The page itself holds no
 * conversation: the panel reads and writes it through /api/chat/[slug], and a confirm card books through
 * /api/bookings, so the server decides every outcome.
 */
export default async function ProviderChatPage({ params }: Props) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const user = await requireUserOrRedirect(`/p/${slug}/chat`);
  const provider = await getPublicProvider(slug);
  if (!provider) notFound();
  const own = await getOwnProfileOrNull(user);
  const isOwner = own?.slug === provider.slug;

  return (
    <>
      <PageIntro
        section="Booking assistant"
        title={provider.displayName}
        description="Ask for a time in plain words. You confirm every booking yourself."
        actions={
          <Link href={`/p/${provider.slug}`} className={buttonOutlineAccent} data-action="back-to-booking-page">
            Pick a time on the booking page
          </Link>
        }
      />
      <Panel title="Chat with the assistant">
        {isOwner ? (
          <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted" data-chat-own>
            This is your own page, so there&apos;s no one to book for. Customers chat with the assistant here.
          </p>
        ) : provider.services.length === 0 ? (
          <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted" data-chat-no-services>
            {provider.displayName} hasn&apos;t added any services yet. Check back soon.
          </p>
        ) : (
          <ChatPanel slug={provider.slug} providerName={provider.displayName} />
        )}
      </Panel>
    </>
  );
}
