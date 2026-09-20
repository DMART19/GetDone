import { AppHeader } from "@/components/app-header";
import { AppShell } from "@/components/app-shell";
import { ChatComposer } from "@/components/chat-composer";
import { DevelopmentBadge } from "@/components/dev-badge";
import { HomeActions } from "@/components/home-actions";

export default function HomePage() {
  return (
    <AppShell>
      <AppHeader />
      <DevelopmentBadge />
      <section className="home-content">
        <h1>How can I<br />move things forward<br />today?</h1>
        <HomeActions />
      </section>
      <ChatComposer />
    </AppShell>
  );
}
