// Figures referenced from an article's Markdown as a line reading @@fig:<id>@@
// (design `FIGURES`). The id list itself is the content contract KNOWN_FIGURES.
import type { ComponentType } from 'react';

import type { KnownFigureId } from '@/lib/content/types';

import { FigAB } from './FigAB';
import { FigSlide47 } from './FigSlide47';

export const FIGURES: Record<KnownFigureId, ComponentType> = {
  slide47: FigSlide47,
  'ab-companies': FigAB,
};

export function figureFor(id: string): ComponentType | null {
  return Object.prototype.hasOwnProperty.call(FIGURES, id) ? FIGURES[id as KnownFigureId] : null;
}
