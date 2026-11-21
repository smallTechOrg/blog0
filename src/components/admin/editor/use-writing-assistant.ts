'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { AiProviderResponse, AssistantComment, AssistantReviewResponse } from '@/lib/api/dto';

import { apiRequest } from '../api';
import { changedExcerpt, cooldownLeft, IDLE_MS, reviewTrigger, type ReviewTrigger } from './assistant-trigger';

// The writing assistant in the editor (SMA-43). Watches the draft; after a pause in typing, when
// about 40 words changed or a sentence was finished since its last read (assistant-trigger.ts), it
// sends the draft + the changed paragraphs to POST /api/admin/assistant/review. One read at a time,
// at most one per MIN_INTERVAL_MS; a change during a read is picked up after it. Comments live for
// the session only (the latest round plus two earlier ones). On/off is remembered per browser.

export type AssistantStatus =
  | { kind: 'checking' }
  | { kind: 'unconfigured' }
  | { kind: 'off' }
  | { kind: 'watching' }
  | { kind: 'reading'; trigger: ReviewTrigger | 'manual' }
  | { kind: 'error'; message: string };

export interface AssistantRound {
  at: number;
  trigger: ReviewTrigger | 'manual';
  comments: AssistantComment[];
}

const STORAGE_KEY = 'blog0.assistant.on';
const KEEP_ROUNDS = 3;

function readOn(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function writeOn(on: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    /* storage blocked — the toggle still works for this page */
  }
}

export interface WritingAssistant {
  status: AssistantStatus;
  rounds: AssistantRound[];
  on: boolean;
  setOn: (on: boolean) => void;
  /** Read now, whatever changed. */
  reviewNow: () => void;
}

export function useWritingAssistant(input: { articleId: string; title: string; dek: string; bodyMd: string }): WritingAssistant {
  const [configured, setConfigured] = useState<boolean | null>(null);
  // The Write tab renders only after the article loads in the browser, so reading storage here is safe.
  const [on, setOnState] = useState(() => (typeof window === 'undefined' ? true : readOn()));
  const [reading, setReading] = useState<ReviewTrigger | 'manual' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rounds, setRounds] = useState<AssistantRound[]>([]);

  const latest = useRef(input);
  useLayoutEffect(() => {
    latest.current = input;
  });
  /** The text the assistant last read (starts as the text it opened with: no read on load). */
  const reviewed = useRef<string | null>(null);
  const lastStartedAt = useRef<number | null>(null);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    void apiRequest<AiProviderResponse>('/api/admin/ai').then((res) => {
      if (live) setConfigured(res.ok ? res.data.ai.configured : false);
    });
    return () => {
      live = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    if (reviewed.current === null) reviewed.current = input.bodyMd;
  }, [input.bodyMd]);

  const run = useCallback(async (trigger: ReviewTrigger | 'manual'): Promise<void> => {
    if (inFlight.current) return;
    const { articleId, title, dek, bodyMd } = latest.current;
    const before = reviewed.current ?? '';
    inFlight.current = true;
    lastStartedAt.current = Date.now();
    setReading(trigger);
    setError(null);
    const res = await apiRequest<AssistantReviewResponse>('/api/admin/assistant/review', {
      method: 'POST',
      body: { articleId, title, dek, bodyMd, changed: trigger === 'manual' && before === bodyMd ? '' : changedExcerpt(before, bodyMd), trigger },
    });
    inFlight.current = false;
    setReading(null);
    if (res.ok) {
      reviewed.current = bodyMd;
      setRounds((prev) => [{ at: Date.now(), trigger, comments: res.data.comments }, ...prev].slice(0, KEEP_ROUNDS));
      return;
    }
    if (res.error.code === 'LLM_NOT_CONFIGURED') {
      setConfigured(false);
      return;
    }
    if (res.error.code === 'RATE_LIMITED') return; // the next change tries again
    setError(res.error.message);
  }, []);

  const active = on && configured === true;

  // After each pause in typing: read when enough changed (respecting the cooldown and one-at-a-time).
  useEffect(() => {
    if (!active) return;
    if (timer.current) clearTimeout(timer.current);
    const check = () => {
      timer.current = null;
      const trigger = reviewTrigger(reviewed.current ?? latest.current.bodyMd, latest.current.bodyMd);
      if (!trigger) return;
      if (inFlight.current) {
        timer.current = setTimeout(check, IDLE_MS);
        return;
      }
      const wait = cooldownLeft(lastStartedAt.current, Date.now());
      if (wait > 0) {
        timer.current = setTimeout(check, wait);
        return;
      }
      void run(trigger).then(() => {
        // Text typed during the read: look again.
        if (!timer.current) timer.current = setTimeout(check, IDLE_MS);
      });
    };
    timer.current = setTimeout(check, IDLE_MS);
  }, [active, input.bodyMd, run]);

  const setOn = useCallback((next: boolean) => {
    setOnState(next);
    writeOn(next);
    if (!next && timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    // Turning it back on reads from here: changes made while off count from now.
    if (next) reviewed.current = latest.current.bodyMd;
  }, []);

  const reviewNow = useCallback(() => {
    if (configured) void run('manual');
  }, [configured, run]);

  let status: AssistantStatus;
  if (configured === null) status = { kind: 'checking' };
  else if (!configured) status = { kind: 'unconfigured' };
  else if (!on) status = { kind: 'off' };
  else if (reading) status = { kind: 'reading', trigger: reading };
  else if (error) status = { kind: 'error', message: error };
  else status = { kind: 'watching' };

  return { status, rounds, on, setOn, reviewNow };
}
