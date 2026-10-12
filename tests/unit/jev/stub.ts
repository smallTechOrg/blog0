// Deterministic stub LlmClient for Jev unit tests. Outputs are tagged `<stub:jev>` (provider id)
// so they can never be mistaken for real model output.
import type { Sentence } from '@/lib/content/types';
import type { JevInput } from '@/server/jev/state';
import type { LlmClient, LlmJsonRequest, LlmJsonResponse, LlmUsage } from '@/server/llm/types';

export type StubReply = string | Error | { content: string; usage?: Partial<LlmUsage> };

export class StubLlm implements LlmClient {
  readonly requests: LlmJsonRequest[] = [];
  readonly #replies: StubReply[];

  constructor(replies: StubReply[]) {
    this.#replies = [...replies];
  }

  async completeJson(req: LlmJsonRequest): Promise<LlmJsonResponse> {
    this.requests.push(structuredClone(req));
    const next = this.#replies.shift();
    if (next === undefined) throw new Error('<stub:jev> no more replies');
    if (next instanceof Error) throw next;
    const reply = typeof next === 'string' ? { content: next } : next;
    return {
      content: reply.content,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, costUsd: 0.001, ...reply.usage },
      providerGenerationId: `<stub:jev>-${this.requests.length}`,
      latencyMs: 7,
    };
  }
}

/** n eligible sentences of `words` words each, pids p-0.. (2 sentences per paragraph). */
export function makeSentences(n: number, words = 12): Sentence[] {
  return Array.from({ length: n }, (_, i) => ({
    sid: `s-${i.toString().padStart(3, '0')}`,
    index: i,
    pid: `p-${Math.floor(i / 2)}`,
    text: `Sentence ${i} ${Array.from({ length: Math.max(0, words - 2) }, () => 'word').join(' ')}.`,
    words,
  }));
}

export function makeInput(sentences: Sentence[], overrides: Partial<JevInput> = {}): JevInput {
  return {
    articleId: 'art-1',
    revisionId: 'rev-1',
    title: 'A Title',
    dek: 'A dek.',
    sentences,
    headingPathByPid: { 'p-1': ['Section One'], 'p-2': ['Section One', 'Sub'] },
    requestId: 'req-jev',
    ...overrides,
  };
}

export function picksJson(indices: number[], reason = 'States the thesis'): string {
  return JSON.stringify({ picks: indices.map((index) => ({ index, reason })) });
}
