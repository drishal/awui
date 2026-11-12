// Animated loader for long waits (Hermes Desktop: never ship bare "Loading…").
// `overlay` is for a lazy dialog's fallback: that sits in `.app`'s grid beside the sidebar and `<main>`, and a plain block
// there takes a cell and shoves `<main>` into the sidebar's column until the chunk arrives.
export function Loader({ label, overlay = false }: { label: string; overlay?: boolean }) {
  return (
    <div className={overlay ? "loader loader-overlay" : "loader"} role="status" aria-label={label}>
      <svg width="56" height="28" viewBox="0 0 56 28" aria-hidden="true">
        <path className="loader-track" d="M28 14c-6-8-18-8-18 0s12 8 18 0 18-8 18 0-12 8-18 0z" />
        <path className="loader-run" d="M28 14c-6-8-18-8-18 0s12 8 18 0 18-8 18 0-12 8-18 0z" pathLength="100" />
      </svg>
      <span className="loader-label">{label}</span>
    </div>
  );
}
