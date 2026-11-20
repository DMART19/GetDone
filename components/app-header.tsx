import Link from "next/link";
import { House } from "lucide-react";
import { SignOutButton } from "@/components/sign-out-button";

export function AppHeader() {
  return (
    <header className="app-header">
      <Link className="icon-button" aria-label="Home" href="/">
        <House size={22} strokeWidth={1.8} />
      </Link>
      <span aria-hidden="true" />
      {process.env.GETDONE_DAVID_EDITION === "true" ? <div className="avatar" aria-label="Owner profile">D</div> : <SignOutButton />}
    </header>
  );
}
