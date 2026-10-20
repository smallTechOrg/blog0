// The root layout's pre-paint script (spec/ui.md §1 rule 4), kept in its own module so a unit test
// can run it against a fake window/document.
//
// Theme (divergence 16): a stored 'light'|'dark' choice wins, otherwise the OS preference.
// Typing (UI review 2026-10-20): every load of /, /archive or /about without reduced motion marks
// `data-typing`, so additions.css keeps the page's text unpainted until PageTyper takes over
// (`data-typer`); a 2.5 s timeout sets `data-typer` anyway if hydration never arrives.

export const THEME_SCRIPT = `(function(){try{var w=window,d=document.documentElement,t=null;try{t=w.localStorage.getItem('blog0.theme')}catch(e){}
if(t!=='light'&&t!=='dark'){t=w.matchMedia&&w.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}
d.setAttribute('data-theme',t);
var reduce=!!(w.matchMedia&&w.matchMedia('(prefers-reduced-motion: reduce)').matches);
var p=w.location.pathname.replace(/\\/+$/,'')||'/';
if(!reduce&&(p==='/'||p==='/archive'||p==='/about')){d.dataset.typing='1';w.setTimeout(function(){d.setAttribute('data-typer','')},2500)}
}catch(e){}})();`;
