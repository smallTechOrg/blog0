# Capability: Jev TLDR deck (rank + hand-edit)

Phase 1; Phase 8 replaces selection-with-reasons by relevance ranking (`typesafe/jev-1.13`).
Agent design and the HOW: `spec/agent.md`.

## What It Does
On an explicit click, Jev scores every eligible sentence of the saved article for relevance; the
top-ranked sentences, verbatim and in document order, become the TLDR draft deck, which the writer
then reviews (sentences sorted by relevance), edits and publishes.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Saved revision | title, dek, article plain text, eligible sentences (≥ 5 words) | database / renderer | yes |
| Generate click | explicit action by a signed-in writer | TLDR tab | yes |
| Deck edits | ordered list of sentence ids, each marked Jev or writer | TLDR tab | for hand-editing |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Relevance scores | one probability in [0,1] per eligible sentence (all of them) | generation record |
| Jev picks | the top k sentences by score (k = 4–8, scaled to length), in document order | TLDR draft deck, generation record |
| Generation record | model, prompt version, input/output tokens, $ cost, requests sent, latency, who, when, outcome, scores | database (cost ledger), TLDR tab meta line |
| Draft deck | ordered verbatim lines with source (Jev / writer) | database |
| Editor view | each deck line and each article sentence with its relevance ("relevance 0.82") when scored | TLDR tab |
| Published deck | verbatim lines | reader TLDR deck (on publish) |
| Log lines | `llm.call`, `jev.run` | structured log |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| OpenRouter decisions endpoint (model from `BLOG0_JEV_MODEL`, default `typesafe/jev-1.13`) | one decisions request per click (one yes/no relevance question per sentence; split into batches only when the request would exceed the model's context) | generation recorded as failed; writer sees a specific message and can retry or hand-pick; existing deck untouched |
| Database | read revision, write generation + draft deck | 500 INTERNAL with retry |

## Business Rules
- AI runs only on an explicit Generate/Regenerate click. Never on save, publish, preview or any
  reader request. Text edits never trigger regeneration.
- Jev only scores; every line shown anywhere is taken from the server's own sentence list and is
  byte-identical to a sentence of the revision it was generated from.
- Every eligible sentence gets a score, or the generation fails — a sentence is never silently
  dropped or given an invented score.
- Deck size k scales with length: about 4–5 for short pieces up to 8 for long ones (k = the
  `target` bound in `spec/agent.md` §2); articles with fewer eligible sentences use all of them;
  articles with none cannot be generated.
- Selection is pure ranking: highest score first, ties to the earlier sentence; no rule spreads
  picks across the article (clustering accepted, `spec/agent.md` §6).
- Picks are presented in document order.
- There are no per-line reasons; the relevance score is shown instead, everywhere a reason used to
  be. Lines added by the writer show "Added by you" plus their score when they have one.
- Scores shown in the editor come from the article's latest successful generation, matched by
  sentence id. Scores survive per paragraph (a sentence id is its paragraph's content hash + its
  position): sentences in unchanged paragraphs keep their scores; editing a sentence clears the
  scores of its paragraph; a sentence in a new paragraph shows no score.
- The sentence picker lists sentences by relevance (highest first, unscored last in article
  order) by default when scores exist, with a switch back to article order.
- One generation per article at a time; double clicks are refused while one is running.
- Regenerating replaces the draft deck only after the writer confirms when a draft exists.
- Hand-editing: add any eligible sentence, remove, reorder (1–12 lines); lines added by the
  writer are marked as such; a deck may be entirely hand-picked.
- When the article text changes after a deck exists, the deck becomes **stale**; lines whose
  sentence vanished are flagged and must be removed or replaced before publishing.
- The published deck keeps serving until the next publish.
- Every generation, successful or not, is recorded with its cost (null if the provider gave none).
- Decks and generations made before Phase 8 (with reasons) still open, edit and publish; they show
  no scores until regenerated.
- Reader-facing disclosure on the deck stays: "Lines selected by Jev (AI), verbatim from the
  article." (variants for hand-edited / hand-picked decks per `spec/architecture.md` divergence 8).

## Success Criteria
- [ ] Real-key integration: ranking each of the 5 seed posts and `hard-cases.md` returns a score in [0,1] for every eligible sentence (each sid once), a deck of exactly k = `bounds.target` lines, indices ascending, the selected lines' lowest score ≥ the unselected lines' highest score, every line byte-identical to a revision sentence and present verbatim in the article plain text.
- [ ] Real-key integration with the request budget forced small: the run sends ≥ 2 requests and still scores every sentence.
- [ ] The generation row records `model` = `typesafe/jev-1.13`, `prompt_version` = `jev-rank-v1`, `task` = `tldr.rank`, `attempts` (requests sent) ≥ 1, `prompt_tokens` > 0, `total_tokens` = prompt + completion tokens, `latency_ms` > 0, `requested_by` = the caller, `status` = succeeded, `output.scores` with N entries and `output.selected` with k sids; `cost_usd` is a non-negative number or null with an `llm.cost_missing` warning logged.
- [ ] `GET …/tldr` after a Generate: every `sentences[i].relevance` equals the stored score for that sid; every draft slide's `relevance` equals its sentence's score; `latestGeneration.picks` lists the k selected sids with their scores; no DTO carries a `reason` field.
- [ ] After editing one sentence and saving: every sentence of that sentence's paragraph has `relevance` null, every sentence in an unchanged paragraph keeps its score, and no new `ai_generation` row exists.
- [ ] Unit (stub client): a response missing one answer, or with `noul` outside [0,1], fails with `LLM_INVALID_OUTPUT` after exactly one request per batch (no retry) and the row stores the raw response; extra answer ids are ignored; ties rank the earlier sentence first.
- [ ] A second Generate while the first is running returns 409 `GENERATION_IN_PROGRESS` and creates no row.
- [ ] With an invalid model slug (real call) the API returns `LLM_MODEL_NOT_FOUND`, the row is `failed`, and the existing draft deck is unchanged.
- [ ] An article with 0 eligible sentences returns 422 `JEV_NO_SENTENCES` and no generation row exists.
- [ ] Deck save with an unknown sid → 422 `DECK_INVALID` listing it; with 13 slides → 422; reordered valid deck persists in the given order and survives a reload (second GET returns the same order).
- [ ] A stored pre-Phase-8 draft payload whose slides carry `reason` strings reads back as a valid deck (slides with `relevance: null`), can be saved and published.
- [ ] After saving text that changes a deck sentence: TLDR status = `stale`, that slide has `missing: true`, publish returns `PUBLISH_BLOCKED` reason `TLDR_DECK_STALE` with its sid, the public page still shows the previously published deck, and no new `ai_generation` row was created.
- [ ] After saving text that changes only a heading (sentences unchanged): TLDR status stays `ready`.
- [ ] E2E (real key): Generate → the deck shows k lines each with text matching `relevance [01]\.\d\d`; the picker's first row has the highest score shown; the published deck's intro slide reads "Lines selected by Jev (AI), verbatim from the article."
- [ ] The reader E2E walk (open article, open deck, play through) creates zero `ai_generation` rows.
