import 'server-only';

import type { Sentence } from '@/lib/content/types';

import type { DecisionQuestion } from '../llm/types';
import { renderInstructions, type RankPrompt } from './prompt';
import type { JevBatch, JevDecisionState, JevInput } from './state';

// spec/agent.md §2 step 4: one `noul` question per eligible sentence, id = the sentence's sid.
// Greedy in document order: a batch's size = JSON.stringify({ model, state, questions }).length;
// the next question joins while the size stays ≤ the budget, else a new batch starts. Every batch
// repeats the full state; every sid lands in exactly one batch; a batch always holds ≥ 1 question
// (a single question larger than the budget travels alone). Pure.

export function buildQuestion(prompt: RankPrompt, sentence: Pick<Sentence, 'text'>): DecisionQuestion {
  return {
    type: 'noul',
    instructions: renderInstructions(prompt, sentence.text),
    criteria: { true: prompt.criteriaTrue, false: prompt.criteriaFalse },
  };
}

/** Characters one `"<id>":<question>` entry adds to a questions object (without the separating comma). */
function entryChars(id: string, question: DecisionQuestion): number {
  return JSON.stringify(id).length + 1 + JSON.stringify(question).length;
}

export function planBatches(
  input: Pick<JevInput, 'sentences'>,
  state: JevDecisionState,
  prompt: RankPrompt,
  model: string,
  requestCharBudget: number,
): JevBatch[] {
  const base = JSON.stringify({ model, state, questions: {} }).length;
  const batches: JevBatch[] = [];
  let current: JevBatch | null = null;
  for (const s of input.sentences) {
    const add = entryChars(s.sid, buildQuestion(prompt, s));
    if (current !== null && current.requestChars + 1 + add <= requestCharBudget) {
      current.questions.push({ sid: s.sid, index: s.index });
      current.requestChars += 1 + add; // "," + entry
    } else {
      current = { questions: [{ sid: s.sid, index: s.index }], requestChars: base + add };
      batches.push(current);
    }
  }
  return batches;
}

/** The `questions` object for one batch, in batch (document) order. */
export function batchQuestions(
  batch: JevBatch,
  input: Pick<JevInput, 'sentences'>,
  prompt: RankPrompt,
): Record<string, DecisionQuestion> {
  const bySid = new Map(input.sentences.map((s) => [s.sid, s]));
  const questions: Record<string, DecisionQuestion> = {};
  for (const q of batch.questions) questions[q.sid] = buildQuestion(prompt, bySid.get(q.sid)!);
  return questions;
}
