import { Menu } from "lucide-react";

export function AppHeader() {
  return (
    <header className="app-header">
      <button className="icon-button" aria-label="Open menu" type="button">
        <Menu size={24} strokeWidth={1.8} />
      </button>
      <span aria-hidden="true" />
      <div className="avatar" aria-label="Owner profile">D</div>
    </header>
  );
}
