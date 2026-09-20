export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "brand brand-compact" : "brand"} aria-label="GetDone">
      Get<span>Done</span>
    </span>
  );
}
