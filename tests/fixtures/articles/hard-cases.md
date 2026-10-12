# Hard Cases for the Content Pipeline

This fixture exercises every tricky corner of the Markdown renderer and the sentence splitter. Each paragraph below exists for a reason, so edit it with care.

**Humans are creatures of convenience.** Even the smallest barrier to acting discourages most of us from starting.

The reference guide lives at [docs.example.co.uk/guide.v2.html](https://docs.example.co.uk/guide.v2.html) and it explains the whole format. Read it before you change anything here.

## Abbreviations and Numbers

Some tools, e.g. a careful sentence splitter, must not break on common abbreviations. The U.S. market grew by 3.5% last year according to the report we read. Dr. Rao reviewed the numbers twice before the team published them.

Can a machine really tell where one sentence ends and the next begins? It can, if we are careful! She said, “The splitter must respect quotes.” Then the meeting moved on to other business.

### Unicode and Emoji

The discourse in MN 18, the Madhupiṇḍikasutta, describes how perception becomes proliferation. Shipping a renderer that handles this text correctly feels great 🎉 every single time.

## Lists

A tight list of short items:

- First tight item with enough words in it
- Second tight item also with enough words
  - A nested tight item inside the second one
- Third tight item to close the list out

A loose list of longer items:

1. The first loose item is a full paragraph of its own.

2. The second loose item is also a full paragraph of its own.

The old plan was ~~to ship everything at once~~ quietly dropped. Nobody missed it in the weeks after that.

A task list of open chores:

- [ ] Write the remaining chapters of the guide
- [x] Review the ~~first~~ opening draft with the team

## Quotes

> Dependent on the eye and forms, eye-consciousness arises.
> The meeting of the three is contact.
> With contact as condition there is feeling.

## Code

Call `a.b()` to run the inline example from the documentation page.

```ts
// A comment that ends with a full stop.
export function greet(name: string): string {
  return `Hello, ${name}.`;
}
```

```foo
this block uses an unknown language. It must render as plain text.
```

## Table

| Format | Selected by | Status |
| --- | --- | --- |
| Read | Writer | Ready |
| TLDR | Jev | Stale |
| Listen | Writer | Missing |

## Notes and Images

This sentence carries the first footnote for the test suite.[^1] This one carries a named footnote for good measure.[^note]

![A diagram of the rendering pipeline](/media/test/pipeline.png "The rendering pipeline, end to end")

An inline image ![tiny icon](/media/test/icon.png) sits in the middle of this sentence on purpose.

---

<div class="raw">This raw HTML line must never reach the page.</div>

@@fig:slide47@@

@@fig:does-not-exist@@

This exact paragraph appears twice in the article on purpose.

This exact paragraph appears twice in the article on purpose.

Only three words.

[^1]: The first footnote explains a detail. It contains two sentences.
[^note]: The named footnote adds a second note for the Notes section.
