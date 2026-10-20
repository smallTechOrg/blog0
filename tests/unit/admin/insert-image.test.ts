// Image insertion helpers (spec/capabilities/media-images.md → Unit): the snippet builder and
// the cursor insertion that pads with blank lines only where the neighbours are not blank.
import { describe, expect, it } from 'vitest';

import { altFromFilename, imageSnippet, insertAtCursor, isAcceptedImage, shiftOffset, shiftRange } from '@/components/admin/editor/insert-image';

describe('imageSnippet', () => {
  it('yields ![a](u) without a caption and ![a](u "c") with one', () => {
    expect(imageSnippet('a', 'u')).toBe('![a](u)');
    expect(imageSnippet('a', 'u', 'c')).toBe('![a](u "c")');
    expect(imageSnippet('a', 'u', '   ')).toBe('![a](u)');
  });

  it('escapes " in the caption as \\" and brackets in the alt', () => {
    expect(imageSnippet('a', 'u', 'say "hi"')).toBe('![a](u "say \\"hi\\"")');
    expect(imageSnippet('a [b]', 'u')).toBe('![a \\[b\\]](u)');
  });
});

describe('insertAtCursor', () => {
  it('surrounds the snippet with blank lines when the neighbours are text', () => {
    const r = insertAtCursor('one\ntwo', 3, 3, '![a](u)');
    expect(r.value).toBe('one\n\n![a](u)\n\ntwo');
    expect(r.value.slice(r.caret)).toBe('\n\ntwo');
  });

  it('does not add blank lines that are already there', () => {
    const r = insertAtCursor('one\n\n\n\ntwo', 5, 5, '![a](u)');
    expect(r.value).toBe('one\n\n![a](u)\n\ntwo');
  });

  it('pads nothing at the very start or end of the document', () => {
    expect(insertAtCursor('', 0, 0, 'x').value).toBe('x');
    expect(insertAtCursor('one', 3, 3, 'x').value).toBe('one\n\nx');
    expect(insertAtCursor('one\n', 4, 4, 'x').value).toBe('one\n\nx');
    expect(insertAtCursor('one\n\n', 5, 5, 'x').value).toBe('one\n\nx');
  });

  it('replaces the selection and places the caret after the snippet', () => {
    const r = insertAtCursor('aaa SELECTED bbb', 4, 12, 'x');
    expect(r.value).toBe('aaa \n\nx\n\n bbb');
    expect(r.caret).toBe('aaa \n\nx'.length);
  });

  it('clamps an out-of-range cursor', () => {
    const r = insertAtCursor('abc', 10, 99, 'x');
    expect(r.value).toBe('abc\n\nx');
    expect(r.caret).toBe(r.value.length);
  });
});

describe('altFromFilename', () => {
  it('drops the extension and turns - and _ into spaces', () => {
    expect(altFromFilename('my-great_photo.PNG')).toBe('my great photo');
    expect(altFromFilename('.hidden')).toBe('');
    expect(altFromFilename('noext')).toBe('noext');
  });
  it('caps at 200 characters', () => {
    expect(altFromFilename('a'.repeat(300) + '.jpg')).toHaveLength(200);
  });
});

describe('isAcceptedImage', () => {
  it('accepts png/jpeg/webp/gif by declared type and refuses svg and the rest', () => {
    expect(isAcceptedImage({ type: 'image/png', name: 'a.png' })).toBe(true);
    expect(isAcceptedImage({ type: 'image/jpeg', name: 'a.jpg' })).toBe(true);
    expect(isAcceptedImage({ type: 'image/webp', name: 'a.webp' })).toBe(true);
    expect(isAcceptedImage({ type: 'image/gif', name: 'a.gif' })).toBe(true);
    expect(isAcceptedImage({ type: 'image/svg+xml', name: 'a.svg' })).toBe(false);
    expect(isAcceptedImage({ type: 'text/plain', name: 'a.txt' })).toBe(false);
  });
  it('falls back to the extension when the browser gives no type', () => {
    expect(isAcceptedImage({ type: '', name: 'photo.JPG' })).toBe(true);
    expect(isAcceptedImage({ type: '', name: 'photo.svg' })).toBe(false);
  });
});

describe('shiftOffset / shiftRange (snippet goes where the cursor was when the upload started)', () => {
  it('an edit after the offset leaves it in place', () => {
    expect(shiftOffset(3, 'abc def', 'abc defXYZ')).toBe(3);
    expect(shiftOffset(3, 'abc def', 'abc d')).toBe(3);
  });
  it('an edit before the offset shifts it by the length change', () => {
    expect(shiftOffset(4, 'abc def', 'XXabc def')).toBe(6);
    expect(shiftOffset(4, 'abc def', 'bc def')).toBe(3);
    expect(shiftOffset(7, 'abc def', 'a def')).toBe(5);
  });
  it('typing right at the offset keeps the insertion point before the typed text', () => {
    expect(shiftOffset(3, 'abc', 'abcz')).toBe(3);
  });
  it('a deletion spanning the offset collapses it to the deletion point; a replacement puts it after the new text', () => {
    expect(shiftOffset(4, 'abc def ghi', 'abc ghi')).toBe(4);
    expect(shiftOffset(5, 'abc def ghi', 'abc ghi')).toBe(4);
    expect(shiftOffset(5, 'abc def ghi', 'abc XY ghi')).toBe(6);
  });
  it('shiftRange shifts both ends and never inverts', () => {
    expect(shiftRange({ start: 4, end: 7 }, 'abc def ghi', '__abc def ghi')).toEqual({ start: 6, end: 9 });
    expect(shiftRange({ start: 4, end: 7 }, 'abc def ghi', 'abc ghi')).toEqual({ start: 4, end: 4 });
  });
  it('end to end: caret marked at upload start, the writer types above it, the snippet lands at the shifted caret', () => {
    const atStart = 'Intro.\n\nSecond paragraph.';
    const caret = atStart.indexOf('Second'); // the cursor when the upload started
    // While uploading, the writer edits the first paragraph, then appends at the end — each
    // change reaches the editor as its own value update, and the mark shifts through each.
    const steps = [atStart, 'Intro, now.\n\nSecond paragraph.', 'Intro, now longer.\n\nSecond paragraph.', 'Intro, now longer.\n\nSecond paragraph. More at the end.'];
    let at = caret;
    for (let i = 1; i < steps.length; i += 1) at = shiftOffset(at, steps[i - 1], steps[i]);
    const typed = steps[steps.length - 1];
    expect(typed.slice(at)).toBe('Second paragraph. More at the end.');
    const r = insertAtCursor(typed, at, at, '![a](/media/x.png)');
    expect(r.value).toBe('Intro, now longer.\n\n![a](/media/x.png)\n\nSecond paragraph. More at the end.');
  });
});
