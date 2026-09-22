import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Brand } from "@/components/brand";
import { PasskeySignIn } from "@/components/passkey-sign-in";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <AppShell navigation={false}>
      <section className="sign-in-page">
        <Brand />
        <p>Less work. More life.</p>
        <div className="sign-in-card">
          <PasskeySignIn />
          <small>
            Your passkey proves identity. Portfolio and company authority are resolved separately from server-side memberships.
          </small>
        </div>
        <Link href="/">Back to GetDone</Link>
      </section>
    </AppShell>
  );
}
