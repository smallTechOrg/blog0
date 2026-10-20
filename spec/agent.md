# blog0 — AI-native design (agent.md)

Outcome of the lens: **AI augments the product** (outcome 2 in `agentic-ai.md`). blog0 is a
conventional publishing app with exactly **one** AI capability — **Jev**, the TLDR line ranker.
Everything else is deterministic code. Provider: **OpenRouter**. Model: **`typesafe/jev-1.13`**, an
OpenRouter *decisions* model (user decision, Phase 8 — "Jev" is this model, not a persona prompt on
a chat model).

## 1. Opportunities considered

| Opportunity | Decision | Rationale |
|---|---|---|
| Pick the TLDR deck lines | **AI — Jev (Phase 1; Phase 8: ranking by `typesafe/jev-1.13`)** | Which sentences carry an argument is judgement a heuristic does badly. User decision (Phase 8): "Take all the sentences and use Jev to rank which are most relevant and mark them for TLDR." Jev scores **every** eligible sentence with a relevance probability; the server takes the top k. Verbatim is guaranteed by construction — the model returns only numbers keyed by our sentence ids. |
| Per-line reasons ("why this line") | **Removed (Phase 8)** | A decisions model returns probabilities, not prose; the score replaces the reason everywhere (editor shows "relevance 0.82"). |
| Rewrite/summarise into new TLDR prose | Rejected | Editorial rule: the deck is verbatim; generated prose would need fact-checking and breaks trust. |
| Sentence splitting / paragraph ids | Deterministic code | Must be stable and reproducible; an LLM would be nondeterministic and costly. |
| Excerpt (dek), title, topic suggestions | Not now | Writers set these; adds cost for little value at < 100 articles. |
| Audio-to-text alignment | Deterministic local model (faster-whisper; was Phase 6 — Frozen, not scheduled) | Free, local; not an OpenRouter call. No reasoning needed, only timestamps. |
| Reader Q&A / chat over articles | Rejected for v0.1 | Out of scope; would put LLM cost on reader paths. |
| Search / recommendations | Rejected | Search dropped by user; < 100 articles. |
| Proofreading / style checks | Not now | Not requested. |
| Alt-text for images | Not now | Images are writer-uploaded with writer alt text. |
| Newsletter issue intro / subject lines (Phase 7) | Rejected for Phase 7 | Issues are assembled deterministically from published posts; generated prose in a mass email would need review per issue for little gain at ≤ 1 issue/week. |
| Newsletter send-time optimisation, segmenting | Rejected | One list, one send; Listmonk owns delivery mechanics. |

## 2. Jev — composition

**Patterns (from `agentic-ai.md`):** a single bounded **structured decision call** (the "reach
down" case of *Choosing patterns*: a fixed scoring transform with **no tools and no branching** — a
ReAct loop would add a tool layer with nothing to call) wrapped in **#18 Guardrails** (the model
can only return numbers for ids we issued; server-side answer validation; the deck text always
comes from our sentence list), **#12 Exception Handling and Recovery** (transport retries in the
adapter, typed errors, a hard deadline, hand-pick fallback — **no repair retry**: a decisions
response is either complete or the run fails), **#13 Human-in-the-Loop** (the writer reviews,
edits and publishes; nothing reaches readers without a human click), **#16 Resource-Aware
Optimization** (one cheap request per click — ~$0.0002 observed — explicit click only, result
cached in the DB, never per reader view, input bounded, batching only when the 32k context would
overflow), **#19 Evaluation and Monitoring** (per-request logs, cost ledger, real-key structural
tests, an eval script that prints the ranking).

**Ranking, not selection.** Jev is never asked "pick k lines". It is asked one yes/no (`noul`)
question per sentence — "is this one of the few lines a reader must see?" — and answers with a
probability. The server sorts by that probability and takes the top k (k from the length bounds).
Selection is therefore deterministic given the scores, every sentence's score is kept, and the
editor can sort the whole article by relevance.

**Why one request, not a loop or multi-agent.** The article (state) and one question per sentence
fit in one decisions request for every article we publish (31 sentences: 200 in 802 ms,
$0.00017, observed). There is nothing to fetch and no action to take. A second "critic" pass would
double cost for a gain the writer's review already provides. Only when the request would exceed
the model's 32k context is it split into batches (§2 step 4) — still one logical call.

### State

```ts
// src/server/jev/state.ts
export interface JevInput {
  articleId: string; revisionId: string;
  title: string; dek: string;
  sentences: Sentence[];            // eligible sentences from renderArticle(), index 0..N-1 (src/lib/content/types.ts)
  paragraphs: Paragraph[];          // all paragraphs (for the article plain text in the state)
  requestId: string;
}
export interface JevBounds { min: number; max: number; target: number }   // computeBounds, unchanged; k = target
export interface JevScore { index: number; sid: string; relevance: number }  // relevance = Jev's noul probability in [0,1]
export interface JevUsage { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; costUsd: number | null; providerGenerationIds: string[] }
export interface JevBatch { questions: Array<{ sid: string; index: number }>; requestChars: number }
export type JevErrorCode =
  | 'JEV_NO_SENTENCES' | 'JEV_INPUT_TOO_LONG'
  | 'LLM_AUTH' | 'LLM_INSUFFICIENT_CREDITS' | 'LLM_MODEL_NOT_FOUND' | 'LLM_RATE_LIMITED'
  | 'LLM_TIMEOUT' | 'LLM_UNAVAILABLE' | 'LLM_INVALID_OUTPUT';
export interface JevRunState {
  input: JevInput; bounds: JevBounds; k: number; promptVersion: string; model: string;
  state: JevDecisionState;          // { title, dek, article } — identical in every batch
  batches: JevBatch[];              // planned (≥ 1)
  requestsSent: number;             // decisions requests actually sent (stored as ai_generation.attempts)
  rawOutputs: string[];             // raw response bodies (kept only on failure)
  answerIssues: { missing: string[]; invalid: string[]; extra: number };
  scores: JevScore[] | null;        // all N, document order
  usage: JevUsage;                  // summed over batches
  error: { code: JevErrorCode; message: string } | null;
}
export interface JevDecisionState { title: string; dek: string; article: string }
export type JevResult =
  | { ok: true; scores: JevScore[]; selected: JevScore[]; k: number; bounds: JevBounds; model: string; promptVersion: string; batches: number; usage: JevUsage; latencyMs: number }
  | { ok: false; error: { code: JevErrorCode; message: string }; k: number; bounds: JevBounds; model: string; promptVersion: string; batches: number; usage: JevUsage; latencyMs: number; rawOutputs: string[] };
```

### Steps (nodes) and edges

```
computeBounds ──► buildState ──► guardInput ──► planBatches ──► callBatches ──► validateAnswers ──ok──► rank ──► finalize
                                     │ fail                         │ any error          │ missing/invalid
                                     ▼                              ▼                    ▼
                                finalize(error)              finalize(error)     finalize(LLM_INVALID_OUTPUT)
```

1. **computeBounds** (`bounds.ts`, pure, unchanged). `N` = eligible sentences, `W` = their total
   words. `target = clamp(3 + ceil(W / 250), 4, 8)`; `min = min(N, max(4, target - 1))`;
   `max = min(N, min(8, target + 1))`; target clamped into `[min, max]`. **k = target** (≈300
   words → 5; ≈700 → 6; ≥1 250 → 8; N < 4 → N). `min`/`max` remain only as the hand-edit hint
   in the UI.
2. **buildState** (`build-input.ts`, pure). `state = { title, dek, article }`: `title` and `dek`
   whitespace-collapsed (`dek` empty → `""`); `article` = the revision's plain text in document
   order — every paragraph's plain text (all paragraphs, not only those with eligible
   sentences), separated by a blank line, and a line `## <heading>` inserted before the first
   paragraph whose `headingPath` differs from the previous one (last element of the path).
3. **guardInput** (pure). `N == 0` → `JEV_NO_SENTENCES` ("This article has no sentences of five
   or more words to choose from."), no call. `N > 400` or `JSON.stringify(state).length >
   JEV_MAX_STATE_CHARS` (32 000) → `JEV_INPUT_TOO_LONG` ("This article is too long for Jev (limit
   400 sentences / about 5 000 words) — pick lines by hand."), no call.
4. **planBatches** (`batches.ts`, pure). One question per eligible sentence, id = the sentence's
   `sid`, built from the prompt file (§4): `{ type: 'noul', instructions, criteria: { true, false } }`.
   Greedy in document order: a batch's size = `JSON.stringify({ model, state, questions }).length`;
   add the next question while the size stays ≤ `JEV_REQUEST_CHAR_BUDGET` (64 000 chars ≈ ≤ 21k
   tokens at a conservative 3 chars/token, leaving > 10k tokens of the 32k context for overhead and
   answers); otherwise start a new batch. **Every batch repeats the full state.** Every sid lands
   in exactly one batch. The budget is injectable (`deps.requestCharBudget`) so tests can force
   batching. Typical articles (≤ ~100 sentences) are one batch.
5. **callBatches** (`run.ts`). One `LlmClient.decide()` per batch, at most
   `JEV_BATCH_CONCURRENCY` (3) in flight, all under the run deadline (`JEV_DEADLINE_MS` 110 000;
   no batch starts with < 5 000 ms left; each request's timeout = `min(BLOG0_JEV_TIMEOUT_MS,
   remaining)`). Transport retries live in the adapter. The first failing batch (in batch order)
   decides the error; no new batches start after a failure; in-flight batches are awaited so their
   usage/cost is still recorded. Usage is summed across batches (a field is null only when no
   batch reported it).
6. **validateAnswers** (`validate.ts`, pure). For each batch: every question id must be present in
   `answers` with `type === 'noul'` and a finite number `noul` with `0 ≤ noul ≤ 1`. Ids we did not
   ask are ignored (counted as `extra`). **Any missing or invalid answer fails the whole run** with
   `LLM_INVALID_OUTPUT` — message "Jev didn't score every sentence (<m> of <N> missing or
   invalid) — try again, or pick lines yourself." — **no repair retry and no imputed scores**
   (a 0 would be a fabricated judgement; a retry costs the writer one click at ~$0.0002). The raw
   response bodies are kept for the failed row.
7. **rank** (`rank.ts`, pure). `scores` = all N in document order. Ranking = sort by `relevance`
   descending, ties by `index` ascending (earlier sentence wins). `selected` = the first k of the
   ranking, then **re-sorted by index** (the deck is presented in document order). No coverage or
   spread rule (see §6 "Clustering").
8. **finalize**. Produce `JevResult`; emit the `jev.run` log line.

**Error handler.** Adapter errors map 1:1 to `JevErrorCode`: 401/403 → `LLM_AUTH`; 402 →
`LLM_INSUFFICIENT_CREDITS`; 404, or 400 whose message matches `MODEL_NOT_FOUND_RE` (extended with
`/decisions model|not a decision/i`) → `LLM_MODEL_NOT_FOUND`; 429 after retries →
`LLM_RATE_LIMITED`; 408, timeout or deadline → `LLM_TIMEOUT`; 5xx/network after retries →
`LLM_UNAVAILABLE`; incomplete/invalid answers → `LLM_INVALID_OUTPUT`. No error is swallowed; the
route returns it in the envelope with a writer-facing message and the generation row records it.

**Concurrency.** One run per article at a time: the route refuses while a `running` generation
younger than 3 minutes exists (`GENERATION_IN_PROGRESS`). Runs for different articles are
independent. Within a run, ≤ 3 batch requests in flight. The UI disables the button while running.

**Assembly** (`src/server/jev/run.ts`):

```ts
export async function runJev(input: JevInput, deps: JevDeps): Promise<JevResult> {
  // JevDeps = { llm: LlmClient; model: string; now: () => number; timeoutMs?: number; deadlineMs?: number; requestCharBudget?: number }
  const t0 = deps.now();
  const s = initState(input, deps.model);                         // promptVersion = JEV_PROMPT_VERSION ('jev-rank-v1')
  s.bounds = computeBounds(input.sentences); s.k = s.bounds.target;
  s.state = buildState(input);
  const guard = guardInput(input, s.state);
  if (guard) return finalize(s, guard, t0, deps);
  s.batches = planBatches(input, s.state, loadRankPrompt(), deps.model, deps.requestCharBudget ?? JEV_REQUEST_CHAR_BUDGET);
  const res = await callBatches(s, deps, t0);                     // requestsSent, usage, raw bodies; stops on first error
  if (!res.ok) return finalize(s, res.error, t0, deps);
  const v = validateAnswers(s.batches, res.answersByBatch);       // { ok, scoresBySid } | { ok:false, missing, invalid, extra }
  if (!v.ok) return finalize(s, invalidOutput(v, input.sentences.length), t0, deps);
  s.scores = input.sentences.map((x) => ({ index: x.index, sid: x.sid, relevance: v.scoresBySid.get(x.sid)! }));
  return finalize(s, null, t0, deps);                             // selected = topK(s.scores, s.k) in document order
}
```

The orchestration around it (generation row, draft deck write, relevance lookup for the editor)
lives in `src/server/articles/tldr.ts` (see `spec/architecture.md` §3).

## 3. Model, endpoint and call shape

- Model slug from `BLOG0_JEV_MODEL`; default **`typesafe/jev-1.13`** (verified live, 2026-10-13).
  It is a **decisions** model: it is **not** listed in `GET /api/v1/models` and `/chat/completions`
  answers 400 "is a decisions model". There is **no fallback model chain** — a chat model cannot
  answer a decisions request; if the slug fails, Generate fails with `LLM_MODEL_NOT_FOUND` and
  the writer hand-picks.
- Endpoint: `POST {BLOG0_OPENROUTER_DECISIONS_URL}` (default
  `https://openrouter.ai/api/alpha/decisions`; docs
  `https://openrouter.ai/docs/guides/community/jev`,
  `https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-request`).
  Headers: `Authorization: Bearer <BLOG0_OPENROUTER_API_KEY>`, `Content-Type: application/json`,
  `HTTP-Referer: <BLOG0_PUBLIC_BASE_URL>`, `X-Title: blog0`.
- Body (one batch):
  ```json
  { "model": "typesafe/jev-1.13",
    "state": { "title": "…", "dek": "…", "article": "…plain text…" },
    "questions": {
      "p-3f2c9a1b-s0": { "type": "noul",
        "instructions": "Is this sentence one of the few most important lines a reader must see to grasp the article's core argument in a 1-minute summary? Sentence: \"…\"",
        "criteria": { "true": "It states a central claim, key evidence, or the conclusion of the article.",
                      "false": "It is supporting detail, an aside, an example, a transition, or repetition." } } } }
  ```
  noul criteria must include **both** `true` and `false`. No temperature/max-tokens parameters.
- Response: `{ model, answers: { <id>: { type: 'noul', noul: 0.82 } }, usage: { input_tokens,
  output_tokens, cost }, id, provider }`. Mapping: `inputTokens ← usage.input_tokens`,
  `outputTokens ← usage.output_tokens`, `totalTokens = input + output` (null when both absent),
  `costUsd ← usage.cost` (USD credits), `providerGenerationId ← id`, `provider ← provider`.
  Missing `usage.cost` → `costUsd: null` + a `warn` `llm.cost_missing`; the generation row stores
  null and the UI shows "cost n/a". A 200 whose body is not JSON, or has no `answers` object, is
  treated as a gateway glitch (retryable like 502). A 200 carrying `{ error: { code, message } }`
  maps by its code (as before).
- Timeouts/retries (adapter): per-request timeout `BLOG0_JEV_TIMEOUT_MS` (45 000); transport
  retries for 429, 500, 502, 503, 504 and network errors: 2 retries with backoff 1 s then 3 s
  (+0–250 ms jitter), honouring `Retry-After` up to 10 s; a timeout is not retried. Run deadline
  110 s (route `maxDuration = 120`). Known gap (R1, Frozen — not scheduled, `spec/roadmap.md`):
  in-flight requests and their transport retries are not aborted at the run deadline.

> **Verified (S8.1, 2026-10-13, real call):** question ids are the sentence `sid`s
> (`p-<8 hex>[-n]-s<k>`, ASCII `[a-z0-9-]`) — a request with ids `p-3f2c9a1b-s0` and
> `p-3f2c9a1b-2-s1` answered `200 { "model": "typesafe/jev-1.13-20260917", "answers":
> { "p-3f2c9a1b-s0": { "type": "noul", "noul": 0.98 }, "p-3f2c9a1b-2-s1": { "type": "noul",
> "noul": 0.02 } }, "usage": { "input_tokens": 394, "output_tokens": 60, "cost": 0.000016548 },
> "id": "gen-dec-…", "provider": "TypeSafe" }`. No id mapping is needed. (The response `model`
> carries a dated suffix; the row stores the slug we sent.)
> **Verified (S8.1, same call):** `criteria` is `{ "true": string, "false": string }`; omitting
> `false` answers `400` (a zod `invalid_union` body), so both keys are always sent.
> **Verified (S8.1):** a wrong slug answers `400 {"error":{"message":"Model typesafe/does-not-exist
> does not exist","code":400}}`; a chat slug (`google/gemini-2.5-flash`) answers the same shape
> ("Model google/gemini-2.5-flash does not exist"). `MODEL_NOT_FOUND_RE` matches it (its
> `model … does not exist` branch allows dots in the slug, e.g. `typesafe/jev-1.12`).
> **Assumed:** the sentence is embedded as `JSON.stringify(text)` (quoted, inner quotes escaped).
> **Assumed (S8.1):** `JevDeps` also takes an optional `concurrency` (default
> `JEV_BATCH_CONCURRENCY` = 3; tests only) beside `requestCharBudget`.

## 4. Prompt (versioned file)

- File: `src/server/jev/prompts/rank-v1.md`; constant `JEV_PROMPT_VERSION = 'jev-rank-v1'` in
  `src/server/jev/prompt.ts`. Any wording change → `rank-v2.md` + bump the constant; old files
  stay for audit (`select-v1.md`, the chat-era prompt, stays unreferenced for the rows stamped
  `jev-select-v1`). The version is stored on every generation row and every fixture.
- Exact content of `rank-v1.md` (three sections, parsed by `loadRankPrompt()`; a missing section
  throws at load; `{{sentence}}` is the only placeholder):
  ```markdown
  # jev-rank-v1
  ## instructions
  Is this sentence one of the few most important lines a reader must see to grasp the article's core argument in a 1-minute summary? Sentence: {{sentence}}
  ## true
  It states a central claim, key evidence, or the conclusion of the article.
  ## false
  It is supporting detail, an aside, an example, a transition, or repetition.
  ```
- Prompt injection is harmless by construction: article text is data in `state`/`instructions`,
  and the only output used is a number per id we issued.

## 5. Cost controls

- AI only on an explicit **Generate/Regenerate** click by a signed-in admin; never on save,
  publish, preview, or any reader request (asserted: the reader E2E walk adds 0 generation rows).
- Result cached as the TLDR draft/published payload + the generation row in Postgres; readers
  read the payload.
- One decisions request per click for every normal article (batches only past the 64k-char
  budget); input bounded (≤ 400 sentences, state ≤ 32k chars); no repair retries.
- Double-click / concurrent protection (`GENERATION_IN_PROGRESS`).
- Every generation records model, prompt version, input/output tokens, $ cost (`usage.cost`
  summed over batches), requests sent, who, when; the TLDR panel shows the per-generation cost;
  the ledger view is `ai-cost-ledger` (dashboard: Frozen — not scheduled).

## 6. Failure modes and the hand-pick fallback

| Failure | Detection | Writer sees | System state |
|---|---|---|---|
| No eligible sentences | `guardInput` | "No sentences of 5+ words to choose from." Generate disabled when `sentenceCount == 0`. | No call, no row. |
| Article too long | `guardInput` | "This article is too long for Jev … pick lines by hand." | No call, no row. |
| Bad/missing key | 401/403 | "OpenRouter rejected the API key — check BLOG0_OPENROUTER_API_KEY in .env." | Row `failed`, `LLM_AUTH`. |
| Out of credits | 402 | "OpenRouter account is out of credits." | Row `failed`. |
| Model slug wrong / not a decisions model | 404, or 400 matching `MODEL_NOT_FOUND_RE` | "Model '<slug>' isn't available as a decisions model — set BLOG0_JEV_MODEL (default typesafe/jev-1.13)." | Row `failed`. |
| Rate limited / provider down / timeout / deadline | 429/5xx/timeout after retries | "Jev couldn't reach the model — try again in a minute." | Row `failed`. |
| Incomplete or invalid answers | `validateAnswers` | "Jev didn't score every sentence (m of N missing or invalid) — try again, or pick lines yourself." | Row `failed`, `LLM_INVALID_OUTPUT`, raw bodies stored. |
| One batch fails in a multi-batch run | `callBatches` | that batch's error message | Row `failed`; usage of the completed batches recorded. |
| Process dies mid-call | row `running` > 3 min | Status chip falls back; Generate re-enabled. | Shown as failed (`GENERATION_ABANDONED`). |
| Article edited after deck | sentences fingerprint differs | TLDR chip **stale**; vanished lines flagged; Publish refuses them. Never auto-regenerates. | Published deck keeps serving. Scores survive per paragraph (a sid is the paragraph's content hash + the sentence's position): sentences in unchanged paragraphs keep their scores; editing a sentence clears the scores of its paragraph. |

**Hand-pick fallback (no heuristic):** whenever Jev fails (or the writer prefers), the TLDR tab's
sentence picker builds the deck manually (toggle, add, remove, reorder); a deck with zero Jev lines
is valid and its disclosure reads "Lines selected by the editors, verbatim from the article."
> **Assumed:** no heuristic fallback (user has not chosen one).

**Clustering (observed, accepted).** Pure top-k can cluster — e.g. several picks from an article's
closing paragraphs. > **Assumed (user):** keep pure ranking; the writer adjusts in the editor (the
picker is sorted by relevance, so the next-best lines from other parts are one click away).
> **Frozen — not scheduled:** a "one line per third" coverage guard (swap the lowest-scored pick in
> an over-represented third for the best-scored line of an empty third) — not built
> (`spec/roadmap.md` → Frozen — not scheduled).

## 7. Evaluation and monitoring

- **Unit (deterministic, stub `LlmClient` whose responses carry `provider: '<stub:jev>'`):**
  `buildState` (heading lines, blank-line separation, empty dek); guard paths make no call;
  `planBatches` (one batch under budget; forced small budget → ≥ 2 batches, each with the
  identical state, every sid exactly once, document order); `validateAnswers` (missing id, `noul`
  1.2 / −0.1 / NaN / string / wrong `type` → `LLM_INVALID_OUTPUT` with the count, extra ids
  ignored, no second call); `rank` (desc order, ties by index, k = target clamped to N,
  `selected` in document order); usage summed across batches (cost null only when all null);
  concurrency ≤ 3; first failing batch decides the error and stops new launches; deadline →
  `LLM_TIMEOUT`; `loadRankPrompt` sections + version. Adapter: URL = decisions URL, body
  `{ model, state, questions }`, headers, retries on 429/5xx/network, 401/402/404/400-model
  mapping, usage mapping, `llm.cost_missing`, `provider_generation_id` and `provider` logged.
- **Integration (real key, `tests/integration/jev-openrouter.test.ts`; PENDING KEY rule per
  `spec/architecture.md` → Conventions → Real-key tests; same rule for `eval:jev`):** for each of
  the 5 seed posts and `tests/fixtures/articles/hard-cases.md` run `runJev` and assert: `ok`;
  `scores.length == N`, each sid once, every `relevance` in `[0,1]`; `selected.length == k ==
  bounds.target`; selected indices ascending; the selection is the top k (min selected relevance
  ≥ max unselected relevance); every selected text byte-identical to `sentences[index].text` and
  present verbatim in the article plain text; `usage.inputTokens > 0`; `costUsd` ≥ 0 or null with
  `llm.cost_missing`; `model == 'typesafe/jev-1.13'`, `promptVersion == 'jev-rank-v1'`,
  `latencyMs > 0`. Plus: one article with `requestCharBudget` forced small → `batches ≥ 2` and
  still every sentence scored (real calls); a wrong slug (`typesafe/does-not-exist`) →
  `LLM_MODEL_NOT_FOUND` (the generator records the observed body in a comment and extends
  `MODEL_NOT_FOUND_RE` if needed).
- **Eval script (non-gating quality, gating as a run):** `pnpm eval:jev` runs the same 6
  articles and prints, per article: slug, N, k, batches, the **top k lines with scores** in rank
  order (`0.91  [12]  <first 70 chars>`), coverage (`(max selected index − min selected index + 1)
  / N`), thirds covered (`n/3`), picks per third (`first/middle/last`, with `clustered` when all k fall in one third),
  input/output tokens, cost, latency; then totals (cost, mean latency). Exit 1 if any run fails
  with a real key; PENDING KEY → prints the reason, exit 0. Run on every prompt version change;
  paste the output into the commit/PR.
- **Monitoring:** `llm.call` + `jev.run` log lines (`spec/architecture.md` §7), `ai_generation`
  rows as the durable ledger (scores included).

## 8. Layout of the agent code (mirrors this file for drift audits)

```
src/server/llm/types.ts        LlmClient (decide), DecisionsRequest, DecisionQuestion, DecisionsResponse, LlmUsage, LlmError(code, httpStatus)
src/server/llm/openrouter.ts   OpenRouterDecisionsClient implements LlmClient (fetch, timeout, retries, classify, llm.call logs)
src/server/llm/index.ts        getLlmClient() singleton + resetLlmClientForTests() + isLlmConfigured() (LLM_NOT_CONFIGURED without a key)
src/server/llm/key.ts          openRouterKeyStatus(), realKeyRequired(), PENDING_KEY_REASON (unchanged)
src/server/jev/state.ts        types + constants (JEV_MAX_SENTENCES 400, JEV_MAX_STATE_CHARS 32 000, JEV_REQUEST_CHAR_BUDGET 64 000, JEV_BATCH_CONCURRENCY 3, JEV_DEADLINE_MS 110 000)
src/server/jev/bounds.ts       computeBounds (unchanged)
src/server/jev/build-input.ts  jevInputFromRendered, buildState, guardInput
src/server/jev/batches.ts      buildQuestion, planBatches
src/server/jev/validate.ts     validateAnswers
src/server/jev/rank.ts         rankScores, topK
src/server/jev/prompt.ts       JEV_PROMPT_VERSION = 'jev-rank-v1', loadRankPrompt()
src/server/jev/prompts/rank-v1.md   (select-v1.md kept for audit, unreferenced)
src/server/jev/run.ts          runJev (assembly)
src/server/jev/articles.ts     the 6-article set shared by the integration test and eval:jev
```

The chat-completions client (`completeJson`, `ChatMessage`, JSON-schema `response_format`, fence
stripping) is **removed**: Jev was its only user (verified: no other import of `src/server/llm`
outside Jev, its orchestration, seeds and tests).

```ts
// src/server/llm/types.ts (contract)
export interface DecisionQuestion { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
export interface DecisionsRequest {
  model: string; state: string | Record<string, unknown> | unknown[]; questions: Record<string, DecisionQuestion>;
  requestId: string; promptVersion: string; timeoutMs: number; batch: { index: number; count: number };   // index 1-based, for logs
}
export interface LlmUsage { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }
export interface DecisionsResponse { answers: Record<string, unknown>; usage: LlmUsage; providerGenerationId: string | null; provider: string | null; latencyMs: number; rawBody: string }
export interface LlmClient { decide(req: DecisionsRequest): Promise<DecisionsResponse> }   // throws LlmError
```
