import Link from "next/link";
import { ChevronLeft, MoreHorizontal } from "lucide-react";

export function BackHeader({
  title,
  href,
  showMenu = false,
  rightLabel,
  rightHref
}: {
  title: string;
  href: string;
  showMenu?: boolean;
  rightLabel?: string;
  rightHref?: string;
}) {
  return (
    <header className="back-header">
      <Link href={href} className="icon-button" aria-label="Go back">
        <ChevronLeft size={22} />
      </Link>
      <h1>{title}</h1>
      {rightLabel && rightHref ? (
        <Link className="header-action" href={rightHref}>{rightLabel}</Link>
      ) : showMenu ? (
        <button className="icon-button" aria-label="More actions" type="button">
          <MoreHorizontal size={22} />
        </button>
      ) : <span className="header-spacer" />}
    </header>
  );
}
