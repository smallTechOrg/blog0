import { Typewriter } from '@/components/design/Typewriter';

/* ============================================================
   About, on the homepage (design Home → About section + AboutBody lead).
   About opens the homepage, which is why it left the nav. The texts come
   from the site record (Admin → Site), never constants.

   It types in with the rest of the page (page-typer.ts): every character
   holds its place from the first frame and only its paint changes, so the
   block takes its full height immediately.
   ============================================================ */
export interface HomeAboutProps {
  strap: string;
  stand: string;
  bodyParagraphs: string[];
}

export function HomeAbout({ strap, stand, bodyParagraphs }: HomeAboutProps) {
  return (
    <section className="home-sec" id="about" aria-labelledby="about-h">
      <div className="sechead">
        <Typewriter tag="h2" id="about-h" text="About Us" />
      </div>
      <div className="abt">
        <div className="abt__lead">
          <Typewriter tag="p" className="abt__strap" text={strap} />
          <Typewriter tag="p" className="abt__stand" text={stand} />
        </div>
        <div className="abt__body">
          {bodyParagraphs.map((t, i) => (
            <Typewriter key={i} tag="p" text={t} />
          ))}
        </div>
      </div>
    </section>
  );
}
