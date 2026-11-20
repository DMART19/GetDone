import Link from "next/link";
import { ChevronLeft } from "lucide-react";

export function BackHeader({
  title,
  href,
  rightLabel,
  rightHref
}: {
  title: string;
  href: string;
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
      ) : <span className="header-spacer" />}
    </header>
  );
}
