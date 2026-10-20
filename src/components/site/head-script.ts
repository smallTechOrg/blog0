// The root layout's pre-paint script (spec/ui.md §1 rule 4), kept in its own module so a unit test
// can run it against a fake window/document.
//
// Theme (divergence 16): a stored 'light'|'dark' choice wins, otherwise the OS preference.
// Intro (Stage A): only the visit's first document load of `/`, without reduced motion. Every first
// load marks the visit (whatever the path), so a visit that starts on an article never sees it;
// blocked storage counts as "already seen". Only the intro holds `#blog0-root` back
// (`html[data-printing]`, additions.css) until PrintIn stages the lines; a 2.5 s timeout lifts the
// hold if hydration never arrives.
// Typing (UI review 2026-10-20): `data-typing` marks a document whose typed lines (wordmark,
// tagline, Home About) may start hidden and type in — EVERY load of /, /archive or /about, not just
// the visit's first (no hold there: the text is in the HTML, only its characters are revealed; only
// the once-per-visit intro holds `#blog0-root`). Client
// navigations maintain the mark in PrintIn (`setTypingRoute`).

/** sessionStorage key: set on the visit's first load. */
export const INTRO_KEY = 'blog0.intro';

export const THEME_SCRIPT = `(function(){try{var w=window,d=document.documentElement,t=null;try{t=w.localStorage.getItem('blog0.theme')}catch(e){}
if(t!=='light'&&t!=='dark'){t=w.matchMedia&&w.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}
d.setAttribute('data-theme',t);
var reduce=!!(w.matchMedia&&w.matchMedia('(prefers-reduced-motion: reduce)').matches),intro=false;
try{var s=w.sessionStorage,seen=s.getItem('${INTRO_KEY}');s.setItem('${INTRO_KEY}','1');intro=w.location.pathname==='/'&&!seen&&!reduce}catch(e){intro=false}
var p=w.location.pathname.replace(/\\/+$/,'')||'/',typing=!reduce&&(p==='/'||p==='/archive'||p==='/about');
if(intro){d.dataset.intro='1';d.setAttribute('data-printing','');w.setTimeout(function(){d.removeAttribute('data-printing')},2500)}
if(typing){d.dataset.typing='1'}
}catch(e){}})();`;
