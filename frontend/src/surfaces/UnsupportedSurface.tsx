export default function UnsupportedSurface({ label }: { readonly label: string }) {
  void label;

  return (
    <main
      className="auxiliary-surface auxiliary-surface--unsupported"
      data-surface="unsupported"
    >
      <section
        className="auxiliary-surface-card"
        aria-labelledby="unsupported-surface-title"
      >
        <p className="auxiliary-surface-eyebrow">Note</p>
        <h1 id="unsupported-surface-title">Unsupported window</h1>
        <p>This window type is not supported.</p>
        <span
          aria-label="Not available yet"
          className="auxiliary-surface-status"
          role="status"
        >
          Not available yet
        </span>
      </section>
    </main>
  );
}
