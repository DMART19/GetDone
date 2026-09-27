import { Link, useRouterState } from "@tanstack/react-router";
import { CircleCheckBig, MessageCircle, Server } from "lucide-react";
import { Brand } from "@/components/brand";

const items = [
  { to: "/", label: "Chat", icon: MessageCircle },
  { to: "/decisions", label: "Decisions", icon: CircleCheckBig },
  { to: "/resources", label: "Resources", icon: Server },
] as const;

export function BottomNav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <nav className="bottom-nav" aria-label="Primary navigation">
      <div className="nav-brand"><Brand compact /></div>
      <div className="nav-links">
        {items.map(({ to, label, icon: Icon }) => {
          const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
          return (
            <Link key={to} to={to} className={active ? "nav-item active" : "nav-item"}>
              <Icon size={21} strokeWidth={active ? 2.4 : 1.8} />
              <span>{label}</span>
            </Link>
          );
        })}
      </div>
      <div className="owner-chip" aria-label="Signed in owner">
        <span className="avatar">D</span>
        <span><strong>David</strong><small>Owner</small></span>
      </div>
    </nav>
  );
}
