export default function Loading() {
  return (
    <div className="app-shell">
      <main className="screen state-page" aria-busy="true" aria-live="polite">
        <div className="skeleton-card" />
        <div className="skeleton-line wide" />
        <div className="skeleton-line" />
        <div className="skeleton-stack">
          <div className="skeleton-row" />
          <div className="skeleton-row" />
          <div className="skeleton-row" />
        </div>
      </main>
    </div>
  );
}
