# Capability: Jev TLDR deck (generate + hand-edit)

Phase 1. Agent design and the HOW: `spec/agent.md`.

## What It Does
On an explicit click, Jev picks the article's most important sentences verbatim (with a one-line
reason each) to form the TLDR deck, which the writer then reviews, edits and publishes.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Saved revision | title, dek, eligible sentences (≥ 5 words) | database / renderer | yes |
| Generate click | explicit action by a signed-in writer | TLDR tab | yes |
| Deck edits | ordered list of sentence ids, each marked Jev or writer | TLDR tab | for hand-editing |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Jev picks | 4–8 sentence indices in document order + one-line reason each | TLDR draft deck, generation record |
| Generation record | model, prompt version, tokens, $ cost, attempts, latency, who, when, outcome | database (cost ledger), TLDR tab meta line |
| Draft deck | ordered verbatim lines with source + reason | database |
| Published deck | verbatim lines | reader TLDR deck (on publish) |
| Log lines | `llm.call`, `jev.run` | structured log |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| OpenRouter chat completions (model from `BLOG0_JEV_MODEL`) | one structured-output selection call per click (+ at most one repair call) | generation recorded as failed; writer sees a specific message and can retry or hand-pick; existing deck untouched |
| Database | read revision, write generation + draft deck | 500 INTERNAL with retry |

## Business Rules
- AI runs only on an explicit Generate/Regenerate click. Never on save, publish, preview or any
  reader request. Text edits never trigger regeneration.
- Jev only selects; every line shown anywhere is taken from the server's own sentence list and is
  byte-identical to a sentence of the revision it was generated from.
- Slide count scales with length: about 4 for short pieces up to 8 for long ones (exact bounds in
  `spec/agent.md`); articles with fewer eligible sentences than the minimum use all of them;
  articles with none cannot be generated.
- Picks are presented in document order. Each pick carries a reason ≤ 200 characters.
- One generation per article at a time; double clicks are refused while one is running.
- Regenerating replaces the draft deck only after the writer confirms when a draft exists.
- Hand-editing: add any eligible sentence, remove, reorder (1–12 lines); lines added by the
  writer are marked as such; a deck may be entirely hand-picked.
- When the article text changes after a deck exists, the deck becomes **stale**; lines whose
  sentence vanished are flagged and must be removed or replaced before publishing.
- The published deck keeps serving until the next publish.
- Every generation, successful or not, is recorded with its cost (null if the provider gave none).
- Reader-facing disclosure on the deck: "Lines selected by Jev (AI), verbatim from the article."
  (variants for hand-edited / hand-picked decks per `spec/architecture.md` divergence 8).

## Success Criteria
- [ ] Real-key integration: generating for each of the 5 seed posts and `hard-cases.md` returns a deck whose size is within the computed bounds, indices unique and ascending, every line byte-identical to a revision sentence and present verbatim in the article plain text, every reason 1–200 chars.
- [ ] The generation row records `model` = `BLOG0_JEV_MODEL`, `prompt_version` = `jev-select-v1`, `attempts` ∈ {1,2}, `total_tokens` > 0, `latency_ms` > 0, `requested_by` = the caller, `status` = succeeded; `cost_usd` is a non-negative number or null with an `llm.cost_missing` warning logged.
- [ ] A second Generate while the first is running returns 409 `GENERATION_IN_PROGRESS` and creates no row.
- [ ] With an invalid model slug (real call) the API returns `LLM_MODEL_NOT_FOUND`, the row is `failed`, and the existing draft deck is unchanged.
- [ ] Unit (stub client): invalid output then valid output → success with `attempts` 2; invalid twice → `LLM_INVALID_OUTPUT`; out-of-range, duplicate, unsorted, empty-reason and over-long-reason cases behave as `spec/agent.md` §2 step 5 states.
- [ ] An article with 0 eligible sentences returns 422 `JEV_NO_SENTENCES` and no generation row exists.
- [ ] Deck save with an unknown sid → 422 `DECK_INVALID` listing it; with 13 slides → 422; reordered valid deck persists in the given order and survives a reload (second GET returns the same order).
- [ ] After saving text that changes a deck sentence: TLDR status = `stale`, that slide has `missing: true`, publish returns `PUBLISH_BLOCKED` reason `TLDR_DECK_STALE` with its sid, the public page still shows the previously published deck, and no new `ai_generation` row was created.
- [ ] After saving text that changes only a heading (sentences unchanged): TLDR status stays `ready`.
- [ ] The reader E2E walk (open article, open deck, play through) creates zero `ai_generation` rows.
