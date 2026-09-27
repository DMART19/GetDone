"use client";

import Link from "next/link";
import { CircleCheckBig, Database, MessageCircle } from "lucide-react";
import { usePathname } from "next/navigation";

const items = [
  { href: "/", label: "Chat", icon: MessageCircle },
  { href: "/decisions", label: "Decisions", icon: CircleCheckBig },
  { href: "/resources", label: "Resources", icon: Database }
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="bottom-nav" aria-label="Primary navigation">
      {items.map(({ href, label, icon: Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link key={href} href={href} className={active ? "nav-item active" : "nav-item"}>
            <Icon size={21} strokeWidth={active ? 2.4 : 1.8} />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
