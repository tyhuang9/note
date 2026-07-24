type AuxiliarySurfaceProps = {
  readonly description: string;
  readonly surface: "event-editor" | "quick-command" | "widget";
  readonly title: string;
};

export function AuxiliarySurface({
  description,
  surface,
  title,
}: AuxiliarySurfaceProps) {
  return (
    <main
      className={`auxiliary-surface auxiliary-surface--${surface}`}
      data-surface={surface}
    >
      <section className="auxiliary-surface-card" aria-labelledby="surface-title">
        <p className="auxiliary-surface-eyebrow">Note</p>
        <h1 id="surface-title" tabIndex={-1}>
          {title}
        </h1>
        <p>{description}</p>
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
