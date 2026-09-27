"use client";

import Link from "next/link";
import { CircleCheckBig, Menu, MessageCircle, Server, X } from "lucide-react";
import { useState } from "react";

const menuItems = [
  { href: "/", label: "Chat", icon: MessageCircle },
  { href: "/decisions", label: "Decisions", icon: CircleCheckBig },
  { href: "/resources", label: "Resources", icon: Server }
] as const;

export function AppHeader() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <header className="app-header">
        <button
          className="icon-button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="owner-menu"
          type="button"
          onClick={() => setOpen((value) => !value)}
        >
          <Menu size={24} strokeWidth={1.8} />
        </button>
        <span aria-hidden="true" />
        <div className="avatar" aria-label="Owner profile">D</div>
      </header>

      {open ? (
        <div className="ufo-menu-layer">
          <button
            className="ufo-menu-backdrop"
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
          />
          <aside id="owner-menu" className="ufo-menu-drawer" aria-label="Owner menu">
            <div className="ufo-menu-heading">
              <span>
                <strong>Get<span>Done</span></strong>
                <small>OWNER CONTROL</small>
              </span>
              <button type="button" className="icon-button" aria-label="Close menu" onClick={() => setOpen(false)}>
                <X size={22} />
              </button>
            </div>

            <nav aria-label="Owner menu navigation">
              {menuItems.map(({ href, label, icon: Icon }) => (
                <Link key={href} href={href} onClick={() => setOpen(false)}>
                  <Icon size={20} strokeWidth={1.8} />
                  <span>{label}</span>
                </Link>
              ))}
            </nav>

            <div className="ufo-menu-note">
              <span className="ufo-live-dot" />
              <span>
                <strong>GetDone is active</strong>
                <small>AI proposes. GetDone authorizes. Workers execute.</small>
              </span>
            </div>
          </aside>
        </div>
      ) : null}
    </>
  );
}
