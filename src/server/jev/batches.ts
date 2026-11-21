import 'server-only';

import type { ChatMessage } from '../llm/types';
import { renderUser, sentenceLine, type RankPrompt } from './prompt';
import type { JevBatch, JevDecisionState, JevInput } from './state';

// spec/agent.md §2 step 4: the sentences to score, split into chat requests that fit the budget.
// Greedy in document order: a batch's size = system + user message chars with its sentence lines;
// the next sentence joins while the size stays ≤ the budget, else a new batch starts. Every batch
// repeats the whole article; every sid lands in exactly one batch; a batch always holds ≥ 1
// sentence (a single sentence larger than the budget travels alone). Pure.

function slots(state: JevDecisionState, lines: string) {
  return { title: state.title, dek: state.dek || '(none)', article: state.article, sentences: lines };
}

export function planBatches(
  input: Pick<JevInput, 'sentences'>,
  state: JevDecisionState,
  prompt: RankPrompt,
  requestCharBudget: number,
): JevBatch[] {
  const base = prompt.system.length + renderUser(prompt, slots(state, '')).length;
  const batches: JevBatch[] = [];
  let current: JevBatch | null = null;
  for (const s of input.sentences) {
    const add = sentenceLine(s.sid, s.text).length;
    if (current !== null && current.requestChars + 1 + add <= requestCharBudget) {
      current.questions.push({ sid: s.sid, index: s.index });
      current.requestChars += 1 + add; // "\n" + line
    } else {
      current = { questions: [{ sid: s.sid, index: s.index }], requestChars: base + add };
      batches.push(current);
    }
  }
  return batches;
}

/** The chat messages for one batch: the whole article, and only this batch's sentence lines. */
export function batchMessages(
  batch: JevBatch,
  input: Pick<JevInput, 'sentences'>,
  state: JevDecisionState,
  prompt: RankPrompt,
): ChatMessage[] {
  const bySid = new Map(input.sentences.map((s) => [s.sid, s]));
  const lines = batch.questions.map((q) => sentenceLine(q.sid, bySid.get(q.sid)!.text)).join('\n');
  return [
    { role: 'system', content: prompt.system },
    { role: 'user', content: renderUser(prompt, slots(state, lines)) },
  ];
}
