import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SlotPicker } from "@/components/booking/slot-picker";
import Link from "next/link";
import { PageIntro, Panel, buttonOutlineAccent } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth/session";
import { getOwnProfileOrNull, getPublicProvider } from "@/lib/provider";

export const dynamic = "force-dynamic";

const SLUG = /^[a-z0-9-]{3,40}$/;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const provider = SLUG.test(slug) ? await getPublicProvider(slug) : null;
  return { title: provider ? `Book with ${provider.displayName}` : "Booking page" };
}

/**
 * A provider's public booking page. Anyone can look at times; booking needs an account. The page reads the
 * public provider (no owner id, no email) and the viewer only to decide what the confirm step offers: the
 * booking route authorizes again.
 */
export default async function ProviderBookingPage({ params }: Props) {
  const { slug } = await params;
  if (!SLUG.test(slug)) notFound();
  const provider = await getPublicProvider(slug);
  if (!provider) notFound();

  const user = await getCurrentUser();
  const own = user ? await getOwnProfileOrNull(user) : null;

  return (
    <>
      <PageIntro section="Book a time" title={provider.displayName} />
      {provider.bio && (
        <Panel title="About">
          <p className="whitespace-pre-line break-words">{provider.bio}</p>
        </Panel>
      )}
      {own?.slug !== provider.slug && (
        <Panel title="Rather ask?">
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 basis-60 text-sm text-muted">
              Tell the assistant what suits you, like &ldquo;anything Tuesday after 3?&rdquo;. It suggests a time and you confirm it. {user ? "" : "You need to sign in to chat."}
            </p>
            <Link href={`/p/${provider.slug}/chat`} className={buttonOutlineAccent} data-action="ask-assistant">
              Ask the assistant
            </Link>
          </div>
        </Panel>
      )}
      <Panel title="Book an appointment">
        <SlotPicker
          slug={provider.slug}
          providerName={provider.displayName}
          providerZone={provider.timeZone}
          horizonDays={provider.horizonDays}
          services={provider.services.map((s) => ({ id: s.id, name: s.name, description: s.description, durationMin: s.durationMin }))}
          signedIn={Boolean(user)}
          isOwner={own?.slug === provider.slug}
        />
      </Panel>
    </>
  );
}
