'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

import { uploadImage } from '../listen/listen-api';

import type { ImageUploadHandle } from './ImageUploadButton';
import { isAcceptedImage } from './insert-image';
import type { MarkdownEditorHandle } from './MarkdownEditor';
import { fileFromDataUri, findEmbeddedImages, replaceEmbeddedImages } from './paste-images';

// Pasting into the Markdown field (spec/capabilities/media-images.md → "Pasted Markdown"):
//  - an image on the clipboard (a screenshot) goes to the Image dialog, like a dropped file;
//  - text whose images are embedded as data URLs (Google Docs, Notion, …) is held back while each
//    image is uploaded, then inserted with every data URL swapped for its `/media/<key>` address.
//    If any upload fails nothing is inserted and the writer is told which image failed.
// Everything else pastes as normal text.

export type PasteStatus = { kind: 'working' | 'ok' | 'error'; text: string };

export interface PasteContent {
  text: string;
  files: File[];
}

export interface UsePasteImages {
  /** For MarkdownEditor's `onPasteContent`: true = handled (the browser's paste is cancelled). */
  onPaste: (clip: PasteContent) => boolean;
  status: PasteStatus | null;
}

const DONE_MS = 4000;

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function usePasteImages(
  articleId: string,
  editorRef: RefObject<MarkdownEditorHandle | null>,
  imageRef: RefObject<ImageUploadHandle | null>,
): UsePasteImages {
  const [status, setStatus] = useState<PasteStatus | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (status?.kind !== 'ok') return;
    const t = window.setTimeout(() => setStatus(null), DONE_MS);
    return () => window.clearTimeout(t);
  }, [status]);

  const run = useCallback(
    async (text: string, images: ReturnType<typeof findEmbeddedImages>['images'], mark: number | null) => {
      const urls = new Map<string, string>();
      const fail = (message: string): void => {
        if (mark !== null) editorRef.current?.releaseMark(mark);
        if (alive.current) setStatus({ kind: 'error', text: `${message} Nothing was pasted — try again.` });
      };
      for (let i = 0; i < images.length; i++) {
        const image = images[i];
        if (alive.current) setStatus({ kind: 'working', text: `Uploading pasted image ${i + 1} of ${images.length}…` });
        const file = fileFromDataUri(image, i + 1);
        if (!file) return fail(`Pasted image ${i + 1} could not be read.`);
        const res = await uploadImage(file, { alt: image.alt, articleId });
        if (!res.ok) return fail(`Couldn’t upload pasted image ${i + 1} of ${images.length}: ${res.error.message}`);
        urls.set(image.uri, res.data.asset.url);
      }
      const editor = editorRef.current;
      const out = replaceEmbeddedImages(text, urls);
      if (editor) {
        if (mark !== null) editor.insertAtMark(mark, out);
        else editor.insertAtCursor(out);
      }
      if (alive.current) setStatus({ kind: 'ok', text: `Uploaded ${images.length} pasted ${plural(images.length, 'image', 'images')}.` });
    },
    [articleId, editorRef],
  );

  const onPaste = useCallback(
    (clip: PasteContent): boolean => {
      const files = clip.files.filter(isAcceptedImage);
      if (files.length > 0 && clip.text.trim() === '') {
        imageRef.current?.addFiles(files);
        return true;
      }
      const { images, unsupported } = findEmbeddedImages(clip.text);
      if (images.length === 0) {
        if (unsupported > 0) {
          setStatus({
            kind: 'error',
            text: `${unsupported} embedded ${plural(unsupported, 'image is', 'images are')} in a format that can’t be uploaded (PNG, JPEG, WebP or GIF only), so ${plural(unsupported, 'it', 'they')} won’t show.`,
          });
        }
        return false;
      }
      const mark = editorRef.current?.markInsertion() ?? null;
      void run(clip.text, images, mark);
      return true;
    },
    [editorRef, imageRef, run],
  );

  return { onPaste, status };
}
