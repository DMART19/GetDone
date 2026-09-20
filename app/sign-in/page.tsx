import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { Brand } from "@/components/brand";

export default function SignInPage() {
  return (
    <AppShell navigation={false}>
      <section className="sign-in-page">
        <Brand />
        <p>Less work. More life.</p>
        <form className="sign-in-card">
          <label>Email<input type="email" placeholder="you@example.com" autoComplete="email" /></label>
          <label>Password<input type="password" placeholder="••••••••" autoComplete="current-password" /></label>
          <button type="button" className="primary-action">Sign in preview</button>
          <small>Authentication is intentionally not implemented in Phase 1.</small>
        </form>
        <Link href="/">Continue to development shell</Link>
      </section>
    </AppShell>
  );
}
