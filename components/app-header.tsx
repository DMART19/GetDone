import Link from "next/link";
import { House } from "lucide-react";

export function AppHeader() {
  return (
    <header className="app-header">
      <Link className="icon-button" aria-label="Home" href="/">
        <House size={22} strokeWidth={1.8} />
      </Link>
      <span aria-hidden="true" />
      <div className="avatar" aria-label="Owner profile">D</div>
    </header>
  );
}
