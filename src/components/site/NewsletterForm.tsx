/* The signup (design NewsletterForm): name (optional), then e-mail and the
   arrow in one row. Phase 1 renders it as a labelled, disabled stub — storing
   signups arrives in Phase 2 (S2.3 takes this file over). */
export function NewsletterForm() {
  return (
    <section className="ft-left" id="newsletter" aria-labelledby="nl-h">
      <h2 className="ft-h2" id="nl-h">
        One issue a week, on what actually changed
      </h2>
      <form noValidate aria-describedby="nl-stub">
        <label className="sr" htmlFor="nl-name">
          Name (optional)
        </label>
        <input
          className="ft-fld"
          id="nl-name"
          type="text"
          placeholder="Name (optional)"
          autoComplete="name"
          disabled
        />
        <div className="ft-row">
          <label className="sr" htmlFor="nl-email">
            Email
          </label>
          <input
            className="ft-fld"
            id="nl-email"
            type="email"
            placeholder="E-mail"
            autoComplete="email"
            required
            disabled
          />
          <button className="ft-go" type="submit" aria-label="Subscribe" disabled data-stub="">
            →
          </button>
        </div>
        <p className="ft-micro">Unsubscribe in one click. We don’t share the list.</p>
        <p className="ft-st" id="nl-stub">
          Coming in a later phase — newsletter signup opens in Phase 2.
        </p>
      </form>
    </section>
  );
}
