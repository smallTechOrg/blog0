/* ============================================================
   The About body on its own page (design `AboutBody` without `lead`):
   plain paragraphs, no typewriter. The texts come from the site record
   (Admin → Site), never constants.
   ============================================================ */
export function AboutBody({ paragraphs }: { paragraphs: string[] }) {
  return (
    <div className="aboutbody">
      <div className="abt__body">
        {paragraphs.map((t, i) => (
          <p key={i}>{t}</p>
        ))}
      </div>
    </div>
  );
}
