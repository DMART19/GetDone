import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Brand } from "@/components/brand";

export default function NotFound() {
  return (
    <AppShell navigation={false}>
      <section className="state-page">
        <Brand compact />
        <h1>Not found</h1>
        <p>This item is not available in the current GetDone scope.</p>
        <Link href="/" className="primary-action">Return home</Link>
      </section>
    </AppShell>
  );
}
