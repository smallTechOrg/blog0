/* The wordmark; its final round letter keeps turning (the design CSS holds it still under reduced
   motion). Its typing is the page typewriter's (page-typer.ts), like every other text. */
export interface WordmarkProps {
  /** The site's wordmark (site record, e.g. "blog0"). */
  text: string;
  /** the colophon just needs the name — no turning letter */
  plain?: boolean;
}

export function Wordmark({ text: rawText, plain }: WordmarkProps) {
  const text = String(rawText);
  if (plain) return <span className="wordmark">{text}</span>;
  return (
    <span className="wordmark">
      {text.slice(0, -1)}
      <span className="wordmark__o is-spin">{text.slice(-1)}</span>
    </span>
  );
}
