import { Typewriter } from '@/components/design/Typewriter';

/* ============================================================
   About, on the homepage (design Home → About section + AboutBody lead).
   About opens the homepage, which is why it left the nav. The texts come
   from the site record (Admin → Site), never constants.

   The load sequence runs through here too, carrying on from the masthead.
   It is the typewriter and nothing else: every character holds its place
   from the first frame and only its opacity changes, so the block takes
   its full height immediately and the featured card below it never gets
   pushed under the fold — which is what a fade-in reveal used to do.
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
        <Typewriter tag="h2" id="about-h" text="About Us" delay={700} />
      </div>
      <div className="abt">
        <div className="abt__lead">
          <Typewriter tag="p" className="abt__strap" text={strap} delay={900} />
          <Typewriter tag="p" className="abt__stand" text={stand} delay={1180} />
        </div>
        <div className="abt__body">
          {bodyParagraphs.map((t, i) => (
            <Typewriter key={i} tag="p" text={t} delay={1460 + i * 240} />
          ))}
        </div>
      </div>
    </section>
  );
}
