export function DevelopmentBadge() {
  if (process.env.NEXT_PUBLIC_APP_ENV !== "development") return null;
  return <span className="dev-badge" title="Seeded development data; no production actions">DEV</span>;
}
