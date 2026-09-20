import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Brand } from "@/components/brand";

export default function OfflinePage() {
  return (
    <AppShell navigation={false}>
      <section className="state-page">
        <Brand compact />
        <h1>You’re offline</h1>
        <p>GetDone’s control surface can reconnect when the network returns. No autonomous job is modeled as browser-dependent.</p>
        <Link href="/" className="primary-action">Return home</Link>
      </section>
    </AppShell>
  );
}
