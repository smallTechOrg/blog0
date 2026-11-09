// Clipboard with the design's textarea fallback (spec/design/design-app.js copyToClipboard).
export function copyToClipboard(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    function fallback() {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        resolve(!!ok);
      } catch {
        resolve(false);
      }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => resolve(true), fallback);
      } else {
        fallback();
      }
    } catch {
      fallback();
    }
  });
}
