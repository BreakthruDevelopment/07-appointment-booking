import type { Metadata } from "next";
import { PageIntro, Panel } from "@/components/ui";
import { safeNext } from "@/lib/safe-next";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const next = safeNext((await searchParams).next);
  return (
    <div className="mx-auto max-w-md">
      <PageIntro section="Account" title="Sign in" description="Use your email and password, or create an account." />
      <Panel title="Your account">
        <SignInForm next={next} />
      </Panel>
    </div>
  );
}
