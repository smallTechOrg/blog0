// Deterministic stub LlmClient for the TLDR ranking unit tests (SMA-44: a chat client). Every
// response carries `provider: '<stub:jev>'` so it can never be mistaken for real model output
// (real-key paths never use it). Replies are given as scores by sentence id; the stub turns them
// into the model's JSON text `{"scores":{…}}` (legacy `{ type: 'noul', noul }` values are unwrapped).
import type { Paragraph, Sentence } from '@/lib/content/types';
import type { JevInput } from '@/server/jev/state';
import type { ChatRequest, ChatResponse, LlmClient, LlmUsage } from '@/server/llm/types';

/** A recorded request, plus the sentence ids/texts of its <sentences> block (`questions`). */
export type StubRequest = ChatRequest & { batch: { index: number; count: number }; questions: Record<string, string> };

/** A reply: scores by id, raw content, an Error to throw, or a function of the request. */
type StubAnswer = { answers: Record<string, unknown>; usage?: Partial<LlmUsage>; delayMs?: number } | { content: string; usage?: Partial<LlmUsage>; delayMs?: number };
export type StubReply = Error | { error: Error; delayMs: number } | StubAnswer | ((req: StubRequest) => StubAnswer | Error);

export const STUB_PROVIDER = '<stub:jev>';

/** The `id: text` lines of the user message's <sentences> block. */
export function sentencesOf(req: ChatRequest): Record<string, string> {
  const user = req.messages.find((m) => m.role === 'user')?.content ?? '';
  const block = /<sentences>\n([\s\S]*?)\n<\/sentences>/.exec(user)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const line of block.split('\n')) {
    const m = /^(\S+): (.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function unwrap(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'noul') return (value as { noul: unknown }).noul;
  return value;
}

export class StubLlm implements LlmClient {
  readonly requests: StubRequest[] = [];
  /** Max requests observed in flight at once. */
  maxInFlight = 0;
  #inFlight = 0;
  readonly #replies: StubReply[];
  readonly #fallback: StubReply | null;
  readonly #advance: ((ms: number) => void) | null;

  /**
   * `replies` are consumed in request order; `fallback` answers every request after them.
   * `advance` (fake clock) is called with a reply's delayMs instead of waiting on a real timer.
   */
  constructor(replies: StubReply[], opts: { fallback?: StubReply; advance?: (ms: number) => void } = {}) {
    this.#replies = [...replies];
    this.#fallback = opts.fallback ?? null;
    this.#advance = opts.advance ?? null;
  }

  async chat(raw: ChatRequest): Promise<ChatResponse> {
    const req: StubRequest = { ...structuredClone(raw), batch: raw.batch ?? { index: 1, count: 1 }, questions: sentencesOf(raw) };
    this.requests.push(req);
    const n = this.requests.length;
    this.#inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
    try {
      const next = this.#replies.shift() ?? this.#fallback;
      if (next === null || next === undefined) throw new Error('<stub:jev> no more replies');
      const reply = typeof next === 'function' ? next(req) : next;
      if (reply instanceof Error) {
        await Promise.resolve();
        throw reply;
      }
      if ('error' in reply) {
        if (this.#advance) this.#advance(reply.delayMs);
        else await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
        throw reply.error;
      }
      const delay = reply.delayMs ?? 0;
      if (this.#advance) this.#advance(delay);
      else await new Promise((resolve) => setTimeout(resolve, delay));
      const content =
        'content' in reply
          ? reply.content
          : JSON.stringify({ scores: Object.fromEntries(Object.entries(reply.answers).map(([k, v]) => [k, unwrap(v)])) });
      const body = { id: `<stub:jev>-${n}`, provider: STUB_PROVIDER, choices: [{ message: { role: 'assistant', content } }] };
      return {
        content,
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0.0001, ...reply.usage },
        providerGenerationId: `<stub:jev>-${n}`,
        provider: STUB_PROVIDER,
        latencyMs: delay,
        rawBody: JSON.stringify(body),
      };
    } finally {
      this.#inFlight -= 1;
    }
  }
}

/** n eligible sentences of `words` words each, pids p-0.. (2 sentences per paragraph). */
export function makeSentences(n: number, words = 12): Sentence[] {
  return Array.from({ length: n }, (_, i) => ({
    sid: `p-${Math.floor(i / 2)}-s${i % 2}`,
    index: i,
    pid: `p-${Math.floor(i / 2)}`,
    text: `Sentence ${i} ${Array.from({ length: Math.max(0, words - 2) }, () => 'word').join(' ')}.`,
    words,
  }));
}

/** One paragraph per pair of sentences; p-1 and p-2 sit under headings. */
export function makeParagraphs(sentences: Sentence[]): Paragraph[] {
  const byPid = new Map<string, string[]>();
  for (const s of sentences) byPid.set(s.pid, [...(byPid.get(s.pid) ?? []), s.text]);
  return [...byPid.entries()].map(([pid, texts], index) => ({
    pid,
    index,
    text: texts.join(' '),
    kind: 'p' as const,
    headingPath: pid === 'p-1' ? ['Section One'] : pid === 'p-2' ? ['Section One', 'Sub'] : [],
  }));
}

export function makeInput(sentences: Sentence[], overrides: Partial<JevInput> = {}): JevInput {
  return {
    articleId: 'art-1',
    revisionId: 'rev-1',
    title: 'A Title',
    dek: 'A dek.',
    sentences,
    paragraphs: makeParagraphs(sentences),
    requestId: 'req-jev',
    ...overrides,
  };
}

/** Answers every question of a request with relevance(sid) (default: a deterministic spread). */
export function answerAll(relevance: (sid: string, i: number) => unknown = (_sid, i) => ((i * 37) % 100) / 100) {
  return (req: StubRequest) => ({
    answers: Object.fromEntries(Object.keys(req.questions).map((sid, i) => [sid, relevance(sid, i)])),
  });
}

/** Answers by sid from a fixed map (ids not in the request are returned too — "extra"). */
export function answersFor(scores: Record<string, number>): { answers: Record<string, unknown> } {
  return { answers: { ...scores } };
}
