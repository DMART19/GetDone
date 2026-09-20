import Link from "next/link";
import { ChevronLeft, MoreHorizontal } from "lucide-react";

export function BackHeader({ title, href, showMenu = false }: { title: string; href: string; showMenu?: boolean }) {
  return (
    <header className="back-header">
      <Link href={href} className="icon-button" aria-label="Go back">
        <ChevronLeft size={24} />
      </Link>
      <h1>{title}</h1>
      {showMenu ? (
        <button className="icon-button" aria-label="More actions" type="button">
          <MoreHorizontal size={24} />
        </button>
      ) : <span className="header-spacer" />}
    </header>
  );
}
