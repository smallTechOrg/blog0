
"use strict";
/* ============================================================
   BRAND — one constant. Swap BRAND to WORDMARK_ALT to compare the
   digit treatment ("Log 0") against the word one ("Log Zero").
   ============================================================ */
/* The digit form, lowercase, per the design review. The spelled-out form is
   kept as the alternate so the two can still be compared by changing BRAND
   alone. Note the idle spin targets the wordmark's last character, so on
   "log0" it turns the nought — which is what the brief asked for. */
var WORDMARK = 'log0';
var WORDMARK_ALT = 'log Zero';
var BRAND = WORDMARK;
var BRAND_MAIL = 'hello@logzero.blog';

/* ============================================================
   Helpers
   ============================================================ */
var h = React.createElement;
var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef,
    useMemo = React.useMemo, useCallback = React.useCallback, useLayoutEffect = React.useLayoutEffect;

function cx() {
  var out = [];
  for (var i = 0; i < arguments.length; i++) { if (arguments[i]) out.push(arguments[i]); }
  return out.join(' ');
}

function Icon(props) {
  var n = props.name, s = props.size || 17;
  var common = { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
                 strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' };
  var paths = {
    search: [h('circle', { key: 'a', cx: 11, cy: 11, r: 7 }), h('path', { key: 'b', d: 'M20 20l-3.6-3.6' })],
    sun: [h('circle', { key: 'a', cx: 12, cy: 12, r: 4.2 }),
          h('path', { key: 'b', d: 'M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6' })],
    moon: [h('path', { key: 'a', d: 'M20 14.2A8.2 8.2 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2z' })],
    close: [h('path', { key: 'a', d: 'M6 6l12 12M18 6L6 18' })],
    copy: [h('rect', { key: 'a', x: 9, y: 9, width: 11, height: 11, rx: 2 }), h('path', { key: 'b', d: 'M5 15V6a2 2 0 0 1 2-2h8' })],
    check: [h('path', { key: 'a', d: 'M4.5 12.5l5 5 10-11' })],
    x: [h('path', { key: 'a', d: 'M4 4l16 16M20 4L4 20' })],
    rss: [h('path', { key: 'a', d: 'M5 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2M5 12a7 7 0 0 1 7 7M5 5a14 14 0 0 1 14 14' })],
    mail: [h('rect', { key: 'a', x: 3, y: 5, width: 18, height: 14, rx: 2 }), h('path', { key: 'b', d: 'M3.5 6.5l8.5 6 8.5-6' })],
    note: [h('rect', { key: 'a', x: 5, y: 3, width: 14, height: 18, rx: 2 }), h('path', { key: 'b', d: 'M8.5 8h7M8.5 12h7M8.5 16h4' })],
    notion: [h('rect', { key: 'a', x: 4, y: 4, width: 16, height: 16, rx: 2.5 }), h('path', { key: 'b', d: 'M9 16V8l6 8V8' })],
    chat: [h('path', { key: 'a', d: 'M20 12a8 8 0 0 1-11.8 7L4 20l1.1-4A8 8 0 1 1 20 12z' })],
    heart: [h('path', { key: 'a', d: 'M12 20s-7.2-4.5-7.2-9.3A4.2 4.2 0 0 1 12 8.2a4.2 4.2 0 0 1 7.2 2.5C19.2 15.5 12 20 12 20z' })],
    'heart-on': [h('path', { key: 'a', fill: 'currentColor', stroke: 'none', d: 'M12 20s-7.2-4.5-7.2-9.3A4.2 4.2 0 0 1 12 8.2a4.2 4.2 0 0 1 7.2 2.5C19.2 15.5 12 20 12 20z' })],
    share: [h('path', { key: 'a', d: 'M12 15V4M8.5 7.2L12 3.7l3.5 3.5M5 13.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-5.5' })],
    linkedin: [h('rect', { key: 'a', x: 3.5, y: 3.5, width: 17, height: 17, rx: 2.5 }), h('path', { key: 'b', d: 'M8 10.5V16M8 7.8v.01M11.5 16v-3.2a2.2 2.2 0 0 1 4.4 0V16M11.5 10.5V16' })],
    bolt: [h('path', { key: 'a', d: 'M13 3 5.5 13.5H11l-1 7.5L18.5 10H13z' })],
    text: [h('path', { key: 'a', d: 'M4.5 6.5h15M4.5 11h15M4.5 15.5h10' })],
    headphones: [h('path', { key: 'a', d: 'M4 14v-2a8 8 0 0 1 16 0v2' }),
                 h('rect', { key: 'b', x: 2.5, y: 13.5, width: 4.5, height: 7, rx: 2 }),
                 h('rect', { key: 'c', x: 17, y: 13.5, width: 4.5, height: 7, rx: 2 })]
  };
  return h('svg', common, paths[n] || null);
}

/* Images are off for v1. Flip SHOW_IMAGES to true and every card that has a `v`
   (thumbnail variant) renders its image slot again — no layout rebuild needed. */
var SHOW_IMAGES = false;
function Thumb(props) {
  if (!SHOW_IMAGES || props.v == null) return null;
  return h('div', { className: 'thumb', 'aria-hidden': 'true' });
}

/* ============================================================
   Entrance motion — shared with the existing .reveal system
   ============================================================ */
function prefersReducedMotion() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
  catch (e) { return false; }
}

/* Adds .is-in once the element is on screen. Identical observer contract to
   useRevealFallback; it just does not defer to the view() timeline, because
   these elements start in view. */
function useEnter(ref) {
  useEffect(function () {
    var el = ref.current;
    if (!el) return;
    if (prefersReducedMotion() || !('IntersectionObserver' in window)) { el.classList.add('is-in'); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { el.classList.add('is-in'); io.disconnect(); }
      });
    }, { threshold: 0.12 });
    io.observe(el);
    return function () { io.disconnect(); };
  }, []);
}

var SPLIT_STAGGER = 55, SPLIT_DUR = 620, SPLIT_BUFFER = 40, SPLIT_MAX = 1300;

function splitPieces(text, by) {
  return by === 'char' ? String(text).split('') : String(text).split(/\s+/).filter(Boolean);
}
/* The dek waits for the actual headline to finish, so a nine-word title does
   not get cut off by a delay tuned for a three-word one. */
function dekDelay(text, by) {
  var n = splitPieces(text, by).length;
  return Math.min((n - 1) * SPLIT_STAGGER + SPLIT_DUR + SPLIT_BUFFER, SPLIT_MAX);
}

/* Headline-level only — never body copy, section headings or nav labels. */
var SplitHeadline = React.memo(function (props) {
  var ref = useRef(null);
  useEnter(ref);
  var by = props.by || 'word';
  var pieces = splitPieces(props.text, by);
  return h(props.tag || 'h1', {
    ref: ref, id: props.id, className: cx('split', props.className), 'aria-label': props.text
  }, pieces.map(function (p, i) {
    return h(React.Fragment, { key: i },
      h('span', {
        className: 'sw', 'aria-hidden': 'true',
        style: { animationDelay: (i * SPLIT_STAGGER) + 'ms' }
      }, p),
      (by === 'word' && i < pieces.length - 1) ? ' ' : null);
  }));
}, function (a, b) { return a.text === b.text && a.className === b.className; });

function Dek(props) {
  var ref = useRef(null);
  useEnter(ref);
  return h(props.tag || 'p', {
    ref: ref, className: cx('dekin', props.className),
    style: { animationDelay: (props.delay || 0) + 'ms' }
  }, props.children);
}

var TAGLINE = 'the meaning of life, universe, and everything';

/* ------------------------------------------------------------------
   Typewriter — characters land in sequence on load. Every character is
   in the DOM from the first frame and only its visibility changes, so
   the line keeps its final width and nothing around it reflows as it
   types. Reduced motion gets the whole string at once.
   ------------------------------------------------------------------ */
/* One clock for the whole load sequence.

   Each line used to start its own timer from its own mount, so the
   masthead and the About block were two independent animations that
   drifted apart, and anything that remounted replayed from zero. Every
   line now measures against a single origin: a line that mounts late
   catches up to where the sequence already is instead of restarting,
   which is what makes the whole page land as one choreographed beat. */
var TYPE_T0 = null;
function typeClock() {
  if (TYPE_T0 === null) {
    TYPE_T0 = (window.performance && window.performance.now)
      ? window.performance.now() : Date.now();
  }
  return TYPE_T0;
}
function typeNow() {
  return (window.performance && window.performance.now)
    ? window.performance.now() : Date.now();
}

/* Long lines type faster, so every line takes about the same beat
   however many characters it holds. */
var TYPE_RUN_MS = 820;
function typeStep(len) {
  if (!len) return 26;
  return Math.max(7, Math.min(26, TYPE_RUN_MS / len));
}

function Typewriter(props) {
  var text = String(props.text || '');
  var chars = text.split('');
  var reduce = prefersReducedMotion();
  var delay = props.delay || 0;
  var step = typeStep(chars.length);

  /* mounting late is not a reason to start from the beginning */
  function caughtUp() {
    var el = typeNow() - (typeClock() + delay);
    if (el <= 0) return 0;
    return Math.min(chars.length, Math.floor(el / step));
  }
  var s = useState(reduce ? chars.length : caughtUp), shown = s[0], setShown = s[1];

  useEffect(function () {
    if (reduce) { setShown(chars.length); return; }
    var raf = null, done = false;
    function tick() {
      var want = caughtUp();
      setShown(want);
      if (want < chars.length && !done) raf = window.requestAnimationFrame(tick);
    }
    raf = window.requestAnimationFrame(tick);
    return function () { done = true; if (raf) window.cancelAnimationFrame(raf); };
  }, [text, delay]);

  /* Spaces are emitted as bare text nodes, not as spans.

     A line split into per-character inline spans has nowhere to wrap if
     the spaces sit inside spans too: the browser sees one unbreakable run
     and a long line shoots off the side of the screen. A real text node
     between the characters is what gives it a break opportunity, and a
     space has no glyph, so nothing is lost by leaving it out of the fade. */
  var parts = [];
  for (var ci = 0; ci < chars.length; ci++) {
    if (chars[ci] === ' ') { parts.push(' '); continue; }
    parts.push(h('span', {
      key: ci, className: cx('typed__c', ci < shown && 'is-in'), 'aria-hidden': 'true'
    }, chars[ci]));
  }
  return h(props.tag || 'span',
    { className: cx('typed', props.className), id: props.id, 'aria-label': text }, parts);
}

/* The wordmark types itself in, and its final round letter keeps turning
   until the reader scrolls — an idle state for the landing, not a
   scroll-driven effect. */
function Wordmark(props) {
  var text = String(props.text || BRAND);
  /* the colophon just needs the name — no typing, no turning letter */
  if (props.plain) return h('span', { className: 'wordmark' }, text);
  var head = text.slice(0, -1), tail = text.slice(-1);
  var reduce = prefersReducedMotion();
  var s = useState(function () {
    if (reduce) return text.length;
    return Math.min(text.length, Math.max(0, Math.floor((typeNow() - typeClock()) / 60)));
  }), shown = s[0], setShown = s[1];

  /* same page clock as every other typed line, so the masthead and the
     About block below it read as one sequence rather than two */
  useEffect(function () {
    if (reduce) { setShown(text.length); return; }
    var raf = null, done = false;
    function tick() {
      var want = Math.min(text.length, Math.max(0, Math.floor((typeNow() - typeClock()) / 60)));
      setShown(want);
      if (want < text.length && !done) raf = window.requestAnimationFrame(tick);
    }
    raf = window.requestAnimationFrame(tick);
    return function () { done = true; if (raf) window.cancelAnimationFrame(raf); };
  }, [text]);

  /* The nought turns at all times now — it used to stop on the first
     scroll. Reduced motion still holds it still. */
  return h('span', { className: 'wordmark', 'aria-label': text },
    head.split('').map(function (c, i) {
      return h('span', {
        key: i, className: cx('typed__c', i < shown && 'is-in'), 'aria-hidden': 'true'
      }, c === ' ' ? ' ' : c);
    }),
    h('span', {
      className: cx('typed__c', 'wordmark__o', shown >= text.length && 'is-in',
                    !reduce && 'is-spin'),
      'aria-hidden': 'true'
    }, tail)
  );
}

var SB_STAGGER = 110;

/* A sentence that assembles phrase by phrase, with small figures popping in at
   the term they illustrate. Memoized so it never re-renders — that keeps any
   margin-note spans the reader has added inside it intact. */
var SentenceBuilder = React.memo(function (props) {
  var ref = useRef(null);
  useEnter(ref);
  return h('p', { ref: ref, className: cx('sb', props.className), 'data-ann-safe': '' },
    props.fragments.map(function (f, i) {
      var style = { animationDelay: (i * SB_STAGGER) + 'ms' };
      if (f.type === 'image') {
        return h('span', {
          key: i, className: cx('sb__frag', 'sb__fig', f.v ? 'sb__fig--' + f.v : null),
          style: style, role: 'img', 'aria-label': f.alt
        });
      }
      return h('span', { key: i, className: 'sb__frag', style: style }, f.content);
    })
  );
}, function () { return true; });

function fmtDate(iso) {
  var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var p = iso.split('-');
  return Number(p[2]) + ' ' + m[Number(p[1]) - 1] + ' ' + p[0];
}

/* ============================================================
   CONTENT — the five draft articles from the smallTech Drive doc
   ("smallTech Blog - Articles"). Bodies are the authors' own words
   as Markdown; dates are inferred from the order they appear in the
   doc, since the source gives none. TLDR slides are placeholders
   derived from each article, ready to be replaced by generated ones.
   ============================================================ */
var POSTS = [
  {
    id: 'humans-are-software',
    title: 'Humans are Software',
    tag: 'Perspectives',
    date: '2026-09-08',
    author: 'Sai Krishna V',
    readMin: 2,
    audioSec: 132,
    excerpt: 'A human is a collection of perceptions, feelings, thoughts and intentions — read through the Buddha’s account of how perception becomes proliferation.',
    tldr: [
      'A human, on this account, is not a thing but a process: perception, feeling, thought, desire, intention, action, consciousness.',
      'The claim is not new — it is the Buddha’s, set out in MN 18.',
      'We take input through six senses: sight, sound, smell, taste, touch, and thought.',
      'Perception produces feeling, feeling produces thought, thought produces desire, desire produces planning and action.',
      'These steps run so closely together that we abstract the whole loop and call it a human.'
    ],
    md: [
      'What is a human?',
      '',
      'A human is nothing but a collection of perceptions, memories, feelings, thoughts, desires, intentions, actions and consciousness. I am not saying this, the Buddha said this.',
      '',
      '> Dependent on the eye and forms, eye-consciousness arises.',
      '> The meeting of the three is contact.',
      '> With contact as condition there is feeling.',
      '> What one feels, that one perceives.',
      '> What one perceives, that one thinks about.',
      '> What one thinks about, that one mentally proliferates.',
      '> With what one has mentally proliferated as the source,',
      '> perceptions and notions tinged by mental proliferation',
      '> beset a man with respect to past, future, and present forms',
      '> cognizable through the eye.',
      '',
      '*MN 18, Madhupiṇḍikasutta*',
      '',
      'We perceive things through our sensory input devices. The six inputs are: sight, sound, smell, taste, touch and thought. Sight through our eyes, sound through our ears, smell through our noses, taste through our tongue, touch through our body and thought through our mind.',
      '',
      'When we perceive, we feel things like pleasure and pain and all the combinations of pleasure and pain we call complex emotions. We feel good, we feel bad, we feel happy, we feel sad.',
      '',
      'When we feel things, we think about them, we rationalise our interests in those things, we like some things and we don’t like some things. The things we like, we want to get more. The things we don’t like, we want to get less of.',
      '',
      'So when we think, we desire things. We plan how to acquire said desired things. And plan how to get rid of the undesired things.',
      '',
      'And when we acquire desired things or not acquire them, we know. We act. We perceive. We feel. We think. We desire. We plan. We act. Sometimes it feels like all at the same time. Maybe that’s why it gets hard to recognise these processes on their own. It gets so hard to define that we abstract it into what we call a HUMAN, a body capable of above par reasoning capabilities.',
      '',
      '## Notes',
      '',
      '1. [Skandha](https://en.wikipedia.org/wiki/Skandha)',
      '2. [MN 18 Madhupiṇḍikasutta](https://suttacentral.net/mn18?view=normal&lang=en)'
    ].join('\n')
  },

  {
    id: 'tech-company-first',
    title: 'Before you become an AI company you will need to become a Tech company',
    tag: 'Op-Ed',
    date: '2026-09-15',
    author: 'Sai Krishna V',
    readMin: 3,
    audioSec: 186,
    excerpt: 'AI lowers the barrier to building software. It does not remove the 1% of problems that decide whether a business survives.',
    tldr: [
      'The claim that AI makes tech expertise unnecessary is half true, and the half that is false is the expensive one.',
      'Tech knowledge was never the barrier people assume — programmers have always learnt from Google, StackOverflow and the docs.',
      'What changed is convenience. Even a small barrier to acting stops most people, and AI removed it.',
      'AI gets you almost all the way there. The last 1% is where software breaks in production.',
      /* the closing point carries the article's own question to the reader */
      { text: 'If you want a real product and a real business, the 1% is exactly where you still need tech, and humans.',
        poll: 'ab-companies' }
    ],
    md: [
      'A lot of people on the TL preaching that **you no longer need tech**. Tech is no longer a differentiator. AI democratises tech. Anyone can build and scale products with [Zer0](https://zero.smalltech.in/) tech expertise, and all such wild claims.',
      '',
      'Our job here at [smallTech](https://smalltech.in/) is to help you sift the useful from the BS. And to help you define an **AI strategy not based on trends but fundamentals**. So are all these claims true? Like most important questions of life the answer is, It Depends (Context is Everything).',
      '',
      '@@fig:slide47@@',
      '',
      'Yes, you can build software today without tech expertise. But the fact is that even before AI, tech knowledge wasn’t the huge barrier we assume it was. All programmers, including me, have learnt from the internet (using Google, StackOverflow and Official Docs). We built, we made mistakes and we learnt. **Nobody stopped you from building "agents" or "orchestrators" even before AI.** But something has changed hasn’t it?',
      '',
      '**Humans are creatures of convenience.** Even the smallest barrier to act discourages us. Everyone had the resources to build their own apps and agents a decade ago. But except for the driven folks nobody attempted it. I can imagine how hard it was to code in 2010, where I would handwrite and format code into a Notepad++. And today, I don’t even bother to complete my statements because pressing TAB lets *AI read my mind now.*',
      '',
      '@@fig:ab-companies@@',
      '',
      'The point I am coming to folks, is that **the barrier is a factor but it is not the ultimate factor.** You still need to have the patience to deal with the ugliness of the software when it breaks, because it will break. You may say, oh 99% accuracy is good enough for me. You know the potholes on your streets, do you think that falls into the 99% or the 1% of issues? The 1% is what can make a city heaven or hell. And who knows maybe that 1% is the difference between your business surviving or getting washed away.',
      '',
      'AI will get you almost all the way there. But when you have built the thing and you are running the thing, you will run into the 1% problems. If you don’t care about the 1% go ahead, AI will work perfect for you. **If you want to re-invent the wheel go ahead and do it.** But if you want to build great products and great businesses, you can’t ignore the 1%. And yeah that’s when you’ll need Tech, and that’s when you’ll need humans.'
    ].join('\n')
  },

  {
    id: 'artefact-driven-development',
    title: 'Artefact Driven Development',
    tag: 'Educational',
    date: '2026-09-19',
    author: 'Sai Krishna V',
    readMin: 2,
    audioSec: 124,
    excerpt: 'Two techniques for staying in flow with AI: version everything you make, and treat context as a collection of artefacts.',
    tldr: [
      'Two techniques carry most of the weight when working with AI: artefact driven development, and context management.',
      'Artefact driven development is the old software lesson restated: backup, version, backup, version.',
      'No one can guarantee a good response from an LLM, and prompt craft is mostly just good English.',
      'Context is what actually decides the output — and context is nothing but a collection of artefacts.',
      'Kept this way, your work is portable: switching between GPT and Claude takes seconds.'
    ],
    md: [
      'Two critical techniques to maximise flow when working with AI:',
      '',
      '- Artefact Driven Development',
      '- Context Management',
      '',
      '## Artefact Driven Development',
      '',
      'Decades of nightmares developing software by hand (and not AI) has taught software engineers this incredibly easy but hard lesson: Backup, version, backup, version, backup, version.',
      '',
      '## Context Management',
      '',
      'No one can guarantee a great response from the LLMs. All these people claiming to be prompt kings are just good at English language. And we know your prompts are cool and all, but really context is everything.',
      '',
      'Not to mention how these techniques allow you to not be tied to one LLM/AI provider. I can shift from GPT to Claude in seconds because my context and artefacts are all transferrable.',
      '',
      '## So what are Artefacts, and what is Context?',
      '',
      'A ppt is an artefact. The excel from which the numbers are populated on the ppt is an artefact. The logo of your company and your brand content are artefacts. And Context, well it’s nothing but a collection of Artefacts.'
    ].join('\n')
  },

  {
    id: 'ai-will-destroy-the-world',
    title: 'AI Will Destroy the World',
    tag: 'Op-Ed',
    date: '2026-09-24',
    author: 'Sai Krishna V',
    readMin: 3,
    audioSec: 178,
    excerpt: 'Not for reasons based on technology. Because we are rushing it, without adequate knowledge, and with the wrong attitude.',
    tldr: [
      'The argument is not that AI is technically dangerous, but that we are handling it badly on three counts.',
      'First, speed: Earth’s resources are finite, and 645 million people struggle with hunger while we fund the future.',
      'Second, knowledge: we do not actually understand how this works — and half knowledge is dangerous.',
      'Third, attitude: Big Tech’s stated aim is replacing humans to protect its own margins.',
      'The warning is social media. We cannot hand that same responsibility to the same hands again.'
    ],
    md: [
      'AI will destroy the world. It doesn’t need to but it will. And it will for reasons not based on technology. AI will destroy the world because:',
      '',
      '- We are rushing into it too fast.',
      '- We are rushing into it without adequate knowledge.',
      '- And lastly we are rushing it with the wrong attitude.',
      '',
      'I will go through each of these reasons one by one. Starting with the issue of developing this technology too fast. Earth is abundant, yes with a lot of resources. But unfortunately it doesn’t have unlimited resources. So when you are dealing with a situation of constrained resources, prioritised allocation becomes critical. We can’t squander our resource wealth on meaningless fantasies. Not when 645 million people struggle with hunger daily, while up to 2 billion experience moderate to severe food insecurity. Humans built a civilization to solve hunger first of all, to invest in agriculture, to build villages, towns and cities. But in our pursuit of the future we’ve forgotten our present.',
      '',
      'Secondly, we don’t know how AI works. Yes, it’s a prediction machine which learns from massive amounts of data. But do we know how to understand grammar? Do we even know how humans understand grammar? As far as my basic linguistic research suggests, humans don’t even know we learn to speak so easily from a young age. It’s amazing that it works, yes, but don’t they say half knowledge is dangerous? There’s a reason we don’t have nuclear power plants in every town and city despite understanding it so well. I am not saying to treat AI with the same kind of doomerism, but we do have to acknowledge its dangers. And we have to use AI within hard contexts and constraints, until we learn to understand how to control it better.',
      '',
      'And lastly, I believe we are approaching AI with the wrong attitude. The attitude that Big Tech has made clear is that they want to replace humans with AI. They want to optimise their bottom lines, make their workforces more lean and drive faster growth. That’s pretty much all they care about. But if we must take a warning from how Big Tech spread social media across the world, and the disastrous impacts of social media on society and culture, we must be extremely wary of handing the mantle of such great responsibility onto big tech again. We can’t let the social media disaster occur again. For our kids, for ourselves, for all the sanity of the world, we must pursue AI but for a nobler purpose.',
      '',
      'Thanks for your attention to this matter.'
    ].join('\n')
  },

  {
    id: 'ai-is-expensive',
    title: 'AI is Expensive',
    tag: 'Analysis',
    date: '2026-09-29',
    author: 'Sai Krishna V',
    readMin: 1,
    audioSec: 54,
    draft: true,
    excerpt: 'AI may be smarter than humans. Nobody said it was cheaper. An unfinished look at what it actually costs.',
    tldr: [
      'AI being smarter than humans is a separate question from AI being cheaper than humans.',
      'It runs on energy — oil, gas, nuclear, hydro — and none of that is cheap.',
      'It runs on data, which is what the consent checkbox at every signup is quietly collecting.',
      'This piece is still in draft; the rest of the cost list is not written yet.'
    ],
    md: [
      'AI may be smarter than humans and all that but who says it’s *cheaper*.',
      '',
      'If you are not aware of the costs of AI please let me educate you:',
      '',
      '- AI needs energy. You know, like Oil, Gas, Nuclear, Hydro and all that jazz? That shit ain’t cheap.',
      '- AI needs data. Well you know that little checkbox you tick before you sign up EVERYWHERE. Yeah babe that app ain’t free'
    ].join('\n')
  }
];

function articleById(id) {
  return POSTS.filter(function (a) { return a.id === id; })[0];
}
var postById = articleById;

/* Curated for the featured block. Edit this list to change it. */
var FEATURED_HITS = ['ai-will-destroy-the-world', 'tech-company-first', 'humans-are-software'];

/* 'grid' is the design: one lead card with two beside it.
   'rotate' brings back the single auto-cycling slot with indicator dots. */
/* 'stack'  — the featured cards pile up as you scroll (the design review's call)
   'grid'   — the 35/65 split: one lead card with two beside it
   'rotate' — a single auto-cycling slot with indicator dots */
var FEATURED_MODE = 'stack';
/* three or four reads well as a pile; more than that is a scroll tax */
var FEATURED_MAX = 4;

/* each article is its own route */
POSTS.forEach(function (p) { p.route = p.id; });

var FEED_BATCH = 5;

/* Topics are the tags the published articles actually carry, newest tag first,
   so the row can never advertise a section with nothing behind it. */
var TOPICS = (function () {
  var seen = {}, out = [];
  POSTS.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; })
    .forEach(function (p) {
      if (seen[p.tag]) return;
      seen[p.tag] = 1;
      out.push({ n: (out.length + 1 < 10 ? '0' : '') + (out.length + 1), label: p.tag });
    });
  return out;
})();

/* ============================================================
   Masthead + tab bar
   ============================================================ */
function Masthead(props) {
  var theme = props.theme, go = props.go, route = props.route;
  var searchOpen = props.searchOpen, setSearchOpen = props.setSearchOpen;
  var inputRef = useRef(null);
  var headRef = useRef(null);

  useEffect(function () { if (searchOpen && inputRef.current) inputRef.current.focus(); }, [searchOpen]);

  /* The bar compacts on scroll. This toggles a class on the node rather than
     holding the scroll position in state: nothing below re-renders, which is
     what keeps the imperatively-inserted margin-note spans alive. */
  useEffect(function () {
    var on = false;
    function tick() {
      var el = headRef.current;
      if (!el) return;
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;
      /* hysteresis, so a bar that sits near the threshold doesn't flicker */
      var next = on ? y > 22 : y > 56;
      if (next !== on) { on = next; el.classList.toggle('is-compact', on); }
    }
    var queued = false;
    function onScroll() {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(function () { queued = false; tick(); });
    }
    tick();
    window.addEventListener('scroll', onScroll, { passive: true });
    return function () { window.removeEventListener('scroll', onScroll); };
  }, []);

  function nav(to, e) { e.preventDefault(); go(to); }

  return h('header', { className: 'sitehead', ref: headRef },
    h('div', { className: 'sitehead__in' },
      h('nav', { className: 'tabs', 'aria-label': 'Main' },
        /* About lives on the homepage now, so the nav is Archive + Subscribe */
        h('a', { href: '#archive', className: cx('tab', route === 'archive' && 'is-on'), onClick: function (e) { nav('archive', e); } }, 'Archive'),
        h('a', { href: '#newsletter', className: 'tab', onClick: function (e) { e.preventDefault(); scrollToNewsletter(); } }, 'Subscribe')
      ),
      h('div', { className: 'brand' },
        h('a', { className: 'brandlink', href: '#', onClick: function (e) { nav('home', e); },
                 'aria-label': BRAND + ' \u2014 home' },
          h('span', { className: 'brandmark__logo', 'aria-hidden': 'true' }),
          h(Wordmark, { text: BRAND })),
        h(Typewriter, { tag: 'span', className: 'tagline', text: TAGLINE, delay: 480 })
      ),
      h('div', { className: 'tools' },
        h('button', {
          className: 'iconbtn', 'aria-label': theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode',
          onClick: props.toggleTheme
        }, h(Icon, { name: theme === 'dark' ? 'sun' : 'moon' })),
        h('button', {
          className: cx('iconbtn', searchOpen && 'is-on'),
          'aria-label': searchOpen ? 'Close search' : 'Search articles',
          'aria-expanded': searchOpen ? 'true' : 'false',
          onClick: function () { if (searchOpen) props.setQuery(''); setSearchOpen(!searchOpen); }
        }, h(Icon, { name: searchOpen ? 'close' : 'search' }))
      )
    ),
    searchOpen ? h('div', { className: 'searchbar' },
      h('div', { className: 'searchbar__in' },
        h(Icon, { name: 'search', size: 18 }),
        h('input', {
          ref: inputRef, value: props.query, placeholder: 'Search headlines and topics', 'aria-label': 'Search headlines and topics',
          onChange: function (e) { props.setQuery(e.target.value); if (route !== 'home') go('home', null, true); }
        })
      )
    ) : null
  );
}

/* ============================================================
   Footer — one block: newsletter first, then contact, social, sitemap
   ============================================================ */
/* The signup, v2: name (optional), then e-mail and the arrow in one row.
   Submission is a placeholder — swap submitSubscribe for the real tool. */
function submitSubscribe(email, name) {
  return new Promise(function (resolve) { window.setTimeout(function () { resolve({ ok: true }); }, 900); });
}

function NewsletterForm() {
  var n = useState(''), name = n[0], setName = n[1];
  var s = useState(''), email = s[0], setEmail = s[1];
  var b = useState(false), busy = b[0], setBusy = b[1];
  var d = useState(false), done = d[0], setDone = d[1];
  var e2 = useState(''), err = e2[0], setErr = e2[1];

  function submit(ev) {
    if (ev) ev.preventDefault();
    setErr('');
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setErr('Enter a valid email, like you@company.com.'); return; }
    setBusy(true);
    submitSubscribe(email.trim(), name.trim()).then(function (r) {
      if (!r || !r.ok) throw 0;
      setDone(true);
    }).catch(function () {
      setErr('That didn’t go through. Try again?');
    }).then(function () { setBusy(false); });
  }

  return h('section', { className: 'ft-left', id: 'newsletter', 'aria-labelledby': 'nl-h' },
    h('h2', { className: 'ft-h2', id: 'nl-h' }, 'One issue a week, on what actually changed'),
    done
      ? h('p', { className: 'ft-done', role: 'status' }, 'You’re in. First issue lands Thursday.')
      : h('form', { noValidate: true, onSubmit: submit },
          h('label', { className: 'sr', htmlFor: 'nl-name' }, 'Name (optional)'),
          h('input', {
            className: 'ft-fld', id: 'nl-name', type: 'text', placeholder: 'Name (optional)', autoComplete: 'name',
            value: name, onChange: function (ev) { setName(ev.target.value); }
          }),
          h('div', { className: 'ft-row' },
            h('label', { className: 'sr', htmlFor: 'nl-email' }, 'Email'),
            h('input', {
              className: 'ft-fld', id: 'nl-email', type: 'email', placeholder: 'E-mail', autoComplete: 'email', required: true,
              value: email, onChange: function (ev) { setEmail(ev.target.value); if (err) setErr(''); }
            }),
            h('button', { className: 'ft-go', type: 'submit', 'aria-label': 'Subscribe', disabled: busy }, busy ? '…' : '→')),
          h('p', { className: 'ft-micro' }, 'Unsubscribe in one click. We don’t share the list.'),
          h('p', { className: 'ft-st', 'aria-live': 'polite' }, err))
  );
}

/* ------------------------------------------------------------------
   ASCII hand — a glyph of a raised hand rasterised to a character grid
   on a canvas behind the footer. Cells flicker slowly; the pointer
   brightens and scrambles what it passes over. Honors reduced motion.
   ------------------------------------------------------------------ */
var FT_CH = '#&%{}[]§"/*|()01', FT_CW = 10, FT_CHT = 17;

function ftHand(g, S) {
  g.lineCap = g.lineJoin = 'round'; g.fillStyle = g.strokeStyle = '#fff';
  g.beginPath();
  if (g.roundRect) g.roundRect(-.52 * S, -.95 * S, 1.04 * S, 1.0 * S, .22 * S); else g.rect(-.52 * S, -.95 * S, 1.04 * S, 1.0 * S);
  g.fill();
  g.fillRect(-.34 * S, 0, .68 * S, .9 * S);
  [[-.39, -.78, -.52, -1.62, .17], [-.13, -.85, -.14, -1.86, .18], [.13, -.82, .21, -1.73, .18], [.39, -.74, .56, -1.42, .16], [-.42, -.28, -1.02, -.8, .2]]
    .forEach(function (f) { g.lineWidth = f[4] * S; g.beginPath(); g.moveTo(f[0] * S, f[1] * S); g.lineTo(f[2] * S, f[3] * S); g.stroke(); });
}
function ftHash(a, b) { var s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return s - Math.floor(s); }

function useAsciiHand(footRef, cvRef) {
  useEffect(function () {
    var foot = footRef.current, cv = cvRef.current;
    if (!foot || !cv || !cv.getContext) return;
    var ctx = cv.getContext('2d');
    var reduce = prefersReducedMotion();
    var cells = [], W = 0, H = 0, px = -999, py = -999, run = false, last = 0, raf = null;

    function build() {
      W = foot.clientWidth; H = foot.clientHeight;
      if (!W || !H) return;
      var d = Math.min(window.devicePixelRatio || 1, 2);
      cv.width = W * d; cv.height = H * d; ctx.setTransform(d, 0, 0, d, 0, 0);
      var cols = Math.ceil(W / FT_CW), rows = Math.ceil(H / FT_CHT);
      /* No figure any more: a random scatter of characters across the whole
         band, seeded per cell so it is stable between frames and resizes.
         Slightly denser toward the right, where there is less text to fight. */
      cells = [];
      for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
        var nn = ftHash(c, r);
        var bias = .80 - (c / cols) * .10;           /* 0.80 at the left edge, 0.70 at the right */
        if (nn < bias) continue;
        var cov = .12 + ((nn - bias) / (1 - bias)) * .7;
        cells.push({ x: c * FT_CW, y: r * FT_CHT + FT_CHT - 4, cov: cov, ch: FT_CH[(nn * 997 | 0) % FT_CH.length], ph: nn * 6.28 });
      }
      draw(0);
    }
    function draw(t) {
      ctx.clearRect(0, 0, W, H); ctx.font = '12px "JetBrains Mono", monospace'; ctx.fillStyle = '#BF8938';
      for (var i = 0; i < cells.length; i++) {
        var k = cells[i];
        /* kept faint: texture behind the type, not competing with it */
        var al = .03 + k.cov * .12;
        if (!reduce) al *= .8 + .2 * Math.sin(t * .0009 + k.ph);
        var dist = Math.hypot(k.x - px, k.y - py);
        if (dist < 120) { var bb = 1 - dist / 120; al = Math.max(al, bb * .5); if (!reduce && Math.random() < .25 * bb) k.ch = FT_CH[Math.random() * FT_CH.length | 0]; }
        ctx.globalAlpha = al; ctx.fillText(k.ch, k.x, k.y);
      }
      ctx.globalAlpha = 1;
    }
    function loop(t) {
      if (!run) return;
      if (t - last > 80) {
        last = t;
        for (var i = 0; i < 24; i++) { var k = cells[Math.random() * cells.length | 0]; if (k) k.ch = FT_CH[Math.random() * FT_CH.length | 0]; }
        draw(t);
      }
      raf = window.requestAnimationFrame(loop);
    }
    build();
    var rt = null;
    function onResize() { window.clearTimeout(rt); rt = window.setTimeout(build, 150); }
    window.addEventListener('resize', onResize);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(build);
    function onMove(e) { var r = foot.getBoundingClientRect(); px = e.clientX - r.left; py = e.clientY - r.top; }
    function onLeave() { px = py = -999; }
    if (!reduce) { foot.addEventListener('pointermove', onMove); foot.addEventListener('pointerleave', onLeave); }
    var io = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(function (es) {
        var on = es.some(function (e) { return e.isIntersecting; });
        if (on) cv.classList.add('is-on');
        run = on && !reduce;
        if (run) raf = window.requestAnimationFrame(loop);
      }, { threshold: .2 });
      io.observe(foot);
    } else { cv.classList.add('is-on'); }
    return function () {
      run = false;
      if (raf) window.cancelAnimationFrame(raf);
      window.clearTimeout(rt);
      window.removeEventListener('resize', onResize);
      foot.removeEventListener('pointermove', onMove); foot.removeEventListener('pointerleave', onLeave);
      if (io) io.disconnect();
    };
  }, []);
}

/* "> end of log0" types itself in once the footer is on screen */
function useEof(footRef, eofRef) {
  useEffect(function () {
    var foot = footRef.current, el = eofRef.current;
    if (!foot || !el) return;
    var line = '> end of ' + BRAND, started = false, t = null;
    function type() {
      if (started) return; started = true;
      if (prefersReducedMotion()) { el.textContent = line; return; }
      var i = 0;
      t = window.setInterval(function () { el.textContent = line.slice(0, ++i); if (i >= line.length) window.clearInterval(t); }, 45);
    }
    var io = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(function (es) { if (es.some(function (e) { return e.isIntersecting; })) type(); }, { threshold: .2 });
      io.observe(foot);
    } else type();
    return function () { window.clearInterval(t); if (io) io.disconnect(); };
  }, []);
}

function Footer(props) {
  var goTopic = props.goTopic, go = props.go;
  var footRef = useRef(null), cvRef = useRef(null), eofRef = useRef(null);
  useAsciiHand(footRef, cvRef);
  useEof(footRef, eofRef);
  var head = BRAND.slice(0, -1), tail = BRAND.slice(-1);

  return h('footer', { className: 'site-footer', ref: footRef },
    h('canvas', { className: 'ft-ascii', ref: cvRef, 'aria-hidden': 'true' }),
    h('div', { className: 'ft-in ft-grid' },
      h(NewsletterForm, null),
      h('section', { className: 'ft-right' },
        h('div', { className: 'ft-logo', 'aria-label': BRAND },
          head, h('span', { className: 'ft-zero', 'aria-hidden': 'true' }, tail)),
        /* the real topics, each opening the archive filtered to it */
        TOPICS.length ? h('nav', { 'aria-label': 'Footer topics', id: 'topics' },
          h('ul', { className: 'ft-topics' }, TOPICS.map(function (t) {
            return h('li', { key: t.label },
              h('button', { type: 'button', onClick: function () { if (goTopic) goTopic(t.label); else go('archive'); } }, t.label));
          }))) : null,
        h('hr', { className: 'ft-dot' }),
        h('p', { className: 'ft-pitch' }, 'Tips, corrections, or a pitch:'),
        h('a', { className: 'ft-mail', href: 'mailto:' + BRAND_MAIL }, BRAND_MAIL),
        h('ul', { className: 'ft-icons' },
          h('li', null, h('a', { href: '#', 'aria-label': BRAND + ' on X', onClick: function (e) { e.preventDefault(); } }, h(Icon, { name: 'x', size: 20 }))),
          h('li', null, h('a', { href: '#', 'aria-label': BRAND + ' on LinkedIn', onClick: function (e) { e.preventDefault(); } }, h(Icon, { name: 'linkedin', size: 20 }))),
          h('li', null, h('a', { href: '#', 'aria-label': 'RSS feed', onClick: function (e) { e.preventDefault(); } }, h(Icon, { name: 'rss', size: 20 }))),
          h('li', null, h('a', { href: 'mailto:' + BRAND_MAIL, 'aria-label': 'Email ' + BRAND }, h(Icon, { name: 'mail', size: 20 }))))
      )
    ),
    h('div', { className: 'ft-bar' },
      h('p', { className: 'ft-copy' },
        h('span', null, '© 2026 ', h('b', null, ' ' + BRAND)),
        h('i', { 'aria-hidden': 'true' }),
        h('span', null, h('span', { className: 'brandmark__logo', 'aria-hidden': 'true' }), 'smallTech')),
      h('p', { className: 'ft-eof', 'aria-hidden': 'true' },
        h('span', { ref: eofRef }), h('span', { className: 'ft-us' }, '_'))
    )
  );
}

/* ============================================================
   Post rows
   ============================================================ */
function PostCard(props) {
  var p = props.post, go = props.go, onSummary = props.onSummary;
  /* the card assembles: tag row, then the headline word by word, then the
     excerpt. Capped shorter than an article H1 so a scrolling feed keeps up. */
  var excerptDelay = Math.min(dekDelay(p.title), 700);
  function summary(mode, e) {
    e.preventDefault(); e.stopPropagation();
    if (onSummary) onSummary(p, mode);
  }
  var v = props.variant;
  var cls = v === 'hit' ? 'hit' : v === 'card' ? 'fcard' : v === 'card-lead' ? 'fcard fcard--lead' : 'post';
  var onCard = v === 'card' || v === 'card-lead';
  return h('div', { className: cls, style: props.i != null ? { '--i': String(props.i) } : null },
    h('a', { className: 'post__link', href: '#' + p.id,
             onClick: function (e) { e.preventDefault(); go(p.route); } },
      h(Thumb, { v: p.v }),
      h(Dek, { tag: 'div', className: 'post__top', delay: 0 },
        h('span', { className: 'tag' }, p.tag),
        p.draft ? h('span', { className: 'tag tag--draft' }, 'Draft') : null,
        /* A featured card may be evergreen and carry no date, but the row is
           reserved either way so featured and regular cards line up. */
        h('span', { className: cx('meta', !p.date && 'meta--empty') },
          p.date ? fmtDate(p.date) : '\u00A0')),
      h(SplitHeadline, { tag: 'h3', text: p.title }),
      h(Dek, { tag: 'p', delay: excerptDelay }, p.excerpt)
    ),
    /* skim it without leaving the list — held back on the same beat as the
       excerpt, so the card assembles as one thing instead of the buttons
       sitting there before the text arrives */
    h(Dek, { tag: 'div', className: 'quick', delay: excerptDelay },
      h('button', { className: 'quick__btn', onClick: function (e) { summary('tldr', e); },
                    'aria-label': 'Summary of ' + p.title + ' \u2014 ' + tldrMinutes(p) + ' min' },
        h(Icon, { name: 'bolt', size: 14 }), h('span', null, 'TLDR'),
        h('span', { className: 'quick__d' }, tldrMinutes(p) + ' min')),
      h('button', { className: 'quick__btn', onClick: function (e) { summary('listen', e); },
                    'aria-label': 'Listen to ' + p.title + ' \u2014 ' + audioMinutes(p) + ' min' },
        h(Icon, { name: 'headphones', size: 14 }), h('span', null, 'Listen'),
        h('span', { className: 'quick__d' }, audioMinutes(p) + ' min'))
    )
  );
}

/* ============================================================
   Home
   ============================================================ */
function Home(props) {
  var go = props.go, query = props.query;

  /* Featured is capped at four: past that the pile needs more scrolling to
     get through than the section is worth. */
  var hits = FEATURED_HITS.map(postById).filter(Boolean).slice(0, FEATURED_MAX);
  /* The feed is every post newest-first, minus the curated hits already shown above. */
  var feedAll = useMemo(function () {
    return POSTS.filter(function (p) { return FEATURED_HITS.indexOf(p.id) === -1; })
                .slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; });
  }, []);

  var c = useState(FEED_BATCH), count = c[0], setCount = c[1];
  var l = useState(false), loading = l[0], setLoading = l[1];
  var more = count < feedAll.length;

  /* Cards settle onto the pile as they come into view. The class goes on the
     container first, so a browser without IntersectionObserver never hides
     the cards it then can't reveal. */
  var stackRef = useRef(null);
  useEffect(function () {
    var el = stackRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    el.classList.add('stack--on');
    /* Two-way: a card settles onto the pile coming down and lifts back off
       going up, so reversing the scroll reverses the animation instead of
       leaving every card stuck in its landed state. */
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        en.target.classList.toggle('is-settled', en.isIntersecting);
      });
    }, { threshold: 0.04, rootMargin: '0px 0px -4% 0px' });
    var cards = el.children;
    for (var i = 0; i < cards.length; i++) io.observe(cards[i]);
    return function () { io.disconnect(); };
  }, [count, hits.length]);

  /* The pinned Featured head is the way out of the pile: one click puts the
     section back at its resting position under the site header, and the
     cards unstack as the page settles there. */
  var featRef = useRef(null);
  function unstack() {
    var el = featRef.current;
    if (!el) return;
    var head = document.querySelector('.sitehead');
    var hh = head ? head.getBoundingClientRect().height : 0;
    var y = el.getBoundingClientRect().top + (window.pageYOffset || document.documentElement.scrollTop || 0) - hh - 8;
    try { window.scrollTo({ top: Math.max(0, y), behavior: prefersReducedMotion() ? 'auto' : 'smooth' }); }
    catch (e) { window.scrollTo(0, Math.max(0, y)); }
  }

  /* Explicit paging: the reader asks for the next batch. No scroll listener. */
  function loadMore() {
    if (loading || !more) return;
    setLoading(true);
    window.setTimeout(function () {
      setCount(function (n) { return Math.min(n + FEED_BATCH, feedAll.length); });
      setLoading(false);
    }, 280);
  }

  var results = useMemo(function () {
    var q = query.trim().toLowerCase();
    if (!q) return null;
    return POSTS.filter(function (p) {
      return (p.title + ' ' + p.tag + ' ' + p.excerpt).toLowerCase().indexOf(q) !== -1;
    });
  }, [query]);

  if (results) {
    return h('main', { className: 'col' },
      h('section', { className: 'home-sec' },
        h('div', { className: 'sechead' },
          h('h2', null, results.length ? results.length + (results.length === 1 ? ' article matches' : ' articles match') : 'Nothing matches yet')),
        results.length
          ? results.map(function (p) { return h(PostCard, { key: p.id, post: p, go: go, onSummary: props.onSummary }); })
          : h('p', { style: { textAlign: 'center', color: 'var(--muted)' } }, 'Try a topic instead \u2014 benchmarks, evaluation, agents, cost, or creativity.')
      )
    );
  }

  return h('main', { className: 'col' },
    /* About opens the homepage, which is why it left the nav */
    h('section', { className: 'home-sec', id: 'about', 'aria-labelledby': 'about-h' },
      h('div', { className: 'sechead' },
        h(Typewriter, { tag: 'h2', id: 'about-h', text: 'About Us', delay: 700 })),
      h(AboutBody, { lead: true })
    ),
    hits.length ? h('section', { className: 'home-sec home-sec--pinned', 'aria-labelledby': 'feat-h', ref: featRef },
      h('div', {
        className: 'sechead sechead--pin', role: 'button', tabIndex: 0,
        title: 'Back to the top of Featured',
        onClick: unstack,
        onKeyDown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); unstack(); } }
      },
        h('h2', { id: 'feat-h' }, 'Featured Editorial'),
        h('span', { className: 'sechead__hint', 'aria-hidden': 'true' }, '\u2191 top')),
      FEATURED_MODE === 'rotate'
        ? h(FeaturedRotator, { hits: hits, go: go, onSummary: props.onSummary })
        : FEATURED_MODE === 'stack'
          /* The scroll stack lives here now: each featured card settles on
             top of the one before it. All three are lead-size, so the pile
             is even rather than one big card and two small. */
          ? h('div', { className: 'stack', ref: stackRef },
              hits.map(function (p, i) {
                return h(PostCard, {
                  key: p.id, post: p, go: go, variant: 'card-lead',
                  onSummary: props.onSummary, i: i
                });
              }))
          : h('div', { className: 'feat' },
              h(PostCard, { key: hits[0].id, post: hits[0], go: go, variant: 'card-lead', onSummary: props.onSummary }),
              hits.length > 1
                ? h('div', { className: 'feat__side' },
                    hits.slice(1, 3).map(function (p) {
                      return h(PostCard, { key: p.id, post: p, go: go, variant: 'card', onSummary: props.onSummary });
                    }))
                : null)
    ) : null,
    feedAll.length ? h('section', { className: 'home-sec', 'aria-labelledby': 'feed-h' },
      h('div', { className: 'sechead' }, h('h2', { id: 'feed-h' }, 'Latest')),
      /* Latest is a plain list — the scroll stack is the Featured section's
         job now, and two stacking treatments on one page fight each other. */
      feedAll.slice(0, count).map(function (p) {
        return h(PostCard, { key: p.id, post: p, go: go, onSummary: props.onSummary });
      }),
      h('div', { className: 'feed__cta' },
        more
          ? h('button', {
              type: 'button', className: 'btn-outline', onClick: loadMore, disabled: loading,
              'aria-label': 'See more articles'
            }, loading ? 'Loading\u2026' : 'See More')
          : h('p', { className: 'feed__status', 'aria-live': 'polite' }, 'That\u2019s everything in the feed.'),
        h('a', { className: 'btn-outline', href: '#archive', onClick: function (e) { e.preventDefault(); go('archive'); } }, 'View all articles'))
    ) : null,
    null
  );
}

/* ============================================================
   About + Archive
   ============================================================ */
/* One copy of the About text, laid out two ways: as the homepage section
   (heading and standfirst on the left, body on the right) and as the
   standalone /about page. */
var ABOUT_STAND = 'A publication from smallTech on the parts of applied AI that are hard to measure and easy to oversell.';
var ABOUT_STRAP = 'Less noise. More signal.';

/* Short placeholder until Sai's copy lands. The fuller version written on
   30 Sep is kept below so it can be dropped straight back in. */
var ABOUT_BODY = [
  'Placeholder \u2014 a short paragraph on who we write for and what we publish goes here.'
];
var ABOUT_BODY_FULL = [
  'We write about ideas, technologies, and the systems behind them. Some pieces explain how something works. Others take a position and show the reasoning behind it. Others follow what has changed and ask whether the change actually matters.',
  'Our work is built to be read beyond the news cycle, referenced in the middle of a decision, and revisited when the question comes up again.'
];

/* The load sequence runs through here too, carrying on from the masthead.
   It is the typewriter and nothing else: every character holds its place
   from the first frame and only its opacity changes, so the block takes
   its full height immediately and the featured card below it never gets
   pushed under the fold — which is what a fade-in reveal used to do. */
function AboutBody(props) {
  if (!props.lead) {
    return h('div', { className: 'aboutbody' },
      h('div', { className: 'abt__body' },
        ABOUT_BODY.map(function (t, i) { return h('p', { key: i }, t); })));
  }
  return h('div', { className: 'abt' },
    h('div', { className: 'abt__lead' },
      h(Typewriter, { tag: 'p', className: 'abt__strap', text: ABOUT_STRAP, delay: 900 }),
      h(Typewriter, { tag: 'p', className: 'abt__stand', text: ABOUT_STAND, delay: 1180 })),
    h('div', { className: 'abt__body' },
      ABOUT_BODY.map(function (t, i) {
        return h(Typewriter, { key: i, tag: 'p', text: t, delay: 1460 + i * 240 });
      }))
  );
}

function About() {
  return h('main', { className: 'col' },
    h('header', { className: 'pagehead' },
      h('h1', null, 'About ' + BRAND),
      h('p', null, ABOUT_STAND),
      h('p', { className: 'abt__strap' }, ABOUT_STRAP)),
    h(AboutBody, null)
  );
}

function Archive(props) {
  var go = props.go;
  /* The topic is held by the app, so a pill in the footer can land here with
     the list already filtered, and the pill row below shows what is applied. */
  var topic = props.topic || null, setTopic = props.setTopic;
  var sorted = POSTS.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; })
    .filter(function (p) { return !topic || p.tag === topic; });
  var groups = [];
  sorted.forEach(function (p) {
    var key = p.date.slice(0, 7);
    var last = groups[groups.length - 1];
    if (!last || last.key !== key) groups.push({ key: key, items: [p] }); else last.items.push(p);
  });
  var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return h('main', { className: 'col' },
    h('header', { className: 'pagehead' },
      h('h1', null, 'Archive'),
      h('p', null, sorted.length + (sorted.length === 1 ? ' article' : ' articles')
        + (topic ? ' in ' + topic : '') + ', newest first.')),
    TOPICS.length ? h('div', { className: 'archfilter', role: 'group', 'aria-label': 'Filter by topic' },
      [{ label: 'All topics', v: null }].concat(TOPICS.map(function (t) { return { label: t.label, v: t.label }; }))
        .map(function (o) {
          var on = topic === o.v;
          return h('button', {
            key: o.label, type: 'button', className: cx('topicpill', on && 'is-on'),
            'aria-pressed': on ? 'true' : 'false',
            onClick: function () { if (setTopic) setTopic(o.v); }
          }, o.label);
        })
    ) : null,
    !sorted.length ? h('p', { className: 'archive-none' }, 'Nothing filed under that topic yet.') : null,
    groups.map(function (g) {
      var p = g.key.split('-');
      return h('section', { key: g.key },
        h('h2', { className: 'archive-month' }, months[Number(p[1]) - 1] + ' ' + p[0]),
        g.items.map(function (it) {
          return h('div', { key: it.id, className: 'archive-row' },
            h('a', { className: 'archive-row__link', href: '#' + it.id,
                     onClick: function (e) { e.preventDefault(); go(it.route); } },
              h('span', { className: 'meta' }, fmtDate(it.date).split(' ').slice(0, 2).join(' ')),
              h('span', { className: 't' }, it.title)),
            h('div', { className: 'quick quick--row' },
              h('button', { className: 'quick__btn',
                            'aria-label': 'Summary of ' + it.title + ' \u2014 ' + tldrMinutes(it) + ' min',
                            onClick: function () { if (props.onSummary) props.onSummary(it, 'tldr'); } },
                h(Icon, { name: 'bolt', size: 14 }), h('span', null, 'TLDR'),
                h('span', { className: 'quick__d' }, tldrMinutes(it) + ' min')),
              h('button', { className: 'quick__btn',
                            'aria-label': 'Listen to ' + it.title + ' \u2014 ' + audioMinutes(it) + ' min',
                            onClick: function () { if (props.onSummary) props.onSummary(it, 'listen'); } },
                h(Icon, { name: 'headphones', size: 14 }), h('span', null, 'Listen'),
                h('span', { className: 'quick__d' }, audioMinutes(it) + ' min'))));
        }));
    })
  );
}

/* ============================================================
   Sentence highlighting — v1 (highlight + copy + share, no comments)
   Separate from the benchmark article's margin-note system.
   ============================================================ */
var HLContext = React.createContext(null);

function splitSentences(text) {
  var parts = text.match(/[^.!?]+(?:[.!?]+[\u201D\u2019"')]*)\s*|[^.!?]+$/g);
  return parts && parts.length ? parts : [text];
}

function copyToClipboard(text) {
  return new Promise(function (resolve) {
    function fallback() {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        resolve(!!ok);
      } catch (e) { resolve(false); }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { resolve(true); }, fallback);
      } else { fallback(); }
    } catch (e) { fallback(); }
  });
}

function sentenceLink(sid) {
  var base = String(window.location.href).split('#')[0];
  return sid ? base + '#hl=' + sid : base;
}

/* No accounts in this build, so every comment the reader leaves is theirs.
   Swap READER for the signed-in name once there is one. */
var READER = 'You';

function fmtAgo(ts) {
  var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

/* A paragraph whose sentences can each be highlighted.
   Memoized on its own props, and reading a context object whose identity never
   changes, so this subtree renders exactly ONCE. That is what lets the margin
   note layer wrap text in <span class="ann"> and drop inline note markers into
   these paragraphs without React reconciling them away on the next state change. */
var HLP = React.memo(function (props) {
  var ctx = React.useContext(HLContext);
  var sents = useMemo(function () { return splitSentences(props.text); }, [props.text]);
  return h('p', { className: 'hlp', style: props.style || undefined, 'data-pid': props.id, 'data-ann-safe': '' },
    sents.map(function (s, i) {
      var sid = props.id + '-s' + i;
      var trail = s.match(/\s+$/);
      var core = trail ? s.slice(0, s.length - trail[0].length) : s;
      /* no handler here: HLProvider delegates, so React-rendered and
         Markdown-injected sentences behave the same way */
      return h(React.Fragment, { key: sid },
        h('span', {
          id: sid, className: 'sent', role: 'button', tabIndex: 0, 'aria-pressed': 'false'
        }, core),
        /* ------------------------------------------------------------------
           v2 COMMENTS \u2014 deliberately NOT built yet.
           A comment icon will render right here, as an absolutely positioned
           sibling of this sentence span (inline, zero-width, anchored to the
           sentence's last line). Tapping it will open the thread in the same
           bottom sheet the margin notes now use \u2014 keyed by `sid` \u2014 so the
           paragraph's text flow never has to be split to make room.
           Suggested shape: h(CommentAnchor, { sid: sid, count: threads[sid] })
           ------------------------------------------------------------------ */
        trail ? trail[0] : null
      );
    })
  );
}, function (a, b) { return a.id === b.id && a.text === b.text; });

function HLProvider(props) {
  var s = useState(null), sel = s[0], setSel = s[1];
  var menuRef = useRef(null);
  var activeRef = useRef(null);
  var openRef = useRef(false);
  var pickRef = useRef(null);

  /* The highlight class is toggled straight on the DOM rather than through
     state, so the memoized paragraphs above never have to re-render. */
  function setActive(sid) {
    var prev = activeRef.current;
    if (prev && prev !== sid) {
      var pe = document.getElementById(prev);
      if (pe) { pe.classList.remove('is-hl'); pe.setAttribute('aria-pressed', 'false'); }
    }
    activeRef.current = sid || null;
    if (sid) {
      var el = document.getElementById(sid);
      if (el) { el.classList.add('is-hl'); el.setAttribute('aria-pressed', 'true'); }
    }
  }

  function close() {
    openRef.current = false;
    setSel(function (cur) { return cur ? Object.assign({}, cur, { open: false }) : cur; });
  }

  /* Places the menu against a client rect (a sentence, or a selection). */
  function placeFor(rects, r) {
    var w = 272, pad = 12;
    var x = Math.max(pad, Math.min(r.left, window.innerWidth - w - pad));
    var below = r.bottom + 10;
    var y = below + 230 > window.innerHeight ? Math.max(pad, (rects[0] || r).top - 236) : below;
    return { x: x, y: y };
  }

  function pick(sid, text, el) {
    if (activeRef.current === sid && openRef.current) {
      setActive(null); openRef.current = false; setSel(null); return;
    }
    var rects = el.getClientRects();
    var r = rects.length ? rects[rects.length - 1] : el.getBoundingClientRect();
    var at = placeFor(rects, r);
    var link = sentenceLink(sid);
    var payload = '\u201C' + text + '\u201D \u2014 ' + BRAND + '\n' + link;
    setActive(sid);
    openRef.current = true;
    setSel({ id: sid, text: text, link: link, x: at.x, y: at.y, open: true, copied: null, kind: 'sentence' });
    copyToClipboard(payload).then(function (ok) {
      setSel(function (cur) { return cur && cur.id === sid ? Object.assign({}, cur, { copied: ok }) : cur; });
    });
    try { window.history.replaceState(null, '', '#hl=' + sid); } catch (e) {}
  }
  pickRef.current = pick;

  /* Opened by the annotation layer when the reader drags a selection, so a
     selection and a sentence tap both land on this one menu. */
  function openForSelection(o) {
    setActive(null);
    openRef.current = true;
    var at = placeFor(o.rects, o.rect);
    var link = o.link || sentenceLink('');
    setSel({ id: null, text: o.text, link: link, x: at.x, y: at.y, open: true, copied: null, kind: 'selection' });
    copyToClipboard('\u201C' + o.text + '\u201D \u2014 ' + BRAND + '\n' + link).then(function (ok) {
      setSel(function (cur) { return cur && cur.kind === 'selection' ? Object.assign({}, cur, { copied: ok }) : cur; });
    });
  }

  /* a context value created once: changing it would re-render every paragraph */
  var noteHookRef = useRef(null);
  var openSelRef = useRef(null);
  openSelRef.current = openForSelection;
  var apiRef = useRef(null);
  if (!apiRef.current) {
    apiRef.current = {
      pick: function (a, b, c) { return pickRef.current(a, b, c); },
      openForSelection: function (o) { return openSelRef.current(o); },
      registerNote: function (fn) { noteHookRef.current = fn; }
    };
  }

  /* one delegated listener covers every .sent span on the page, however it
     got there \u2014 React component or injected Markdown */
  useEffect(function () {
    function hit(e) {
      var el = e.target.closest && e.target.closest('.sent');
      if (!el || !el.id) return null;
      return el;
    }
    function onClick(e) {
      var el = hit(e);
      if (!el) return;
      var g = window.getSelection();
      /* a drag that left a selection is a margin-note gesture, not a tap */
      if (g && !g.isCollapsed && String(g).trim().length > 2) return;
      pickRef.current(el.id, el.textContent, el);
    }
    function onKey(e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var el = hit(e);
      if (!el) return;
      e.preventDefault();
      pickRef.current(el.id, el.textContent, el);
    }
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return function () {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  /* close on outside click, Escape, or scroll \u2014 the highlight itself stays */
  useEffect(function () {
    if (!sel || !sel.open) return;
    function onDown(e) {
      if (menuRef.current && menuRef.current.contains(e.target)) return;
      if (e.target.closest && e.target.closest('.sent')) return;
      close();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown, { passive: true });
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, { passive: true });
    return function () {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close);
    };
  }, [sel && sel.open]);

  /* deep link: #hl=<sentence id> scrolls to and highlights that sentence */
  useEffect(function () {
    if (!props.initial) return;
    var t = window.setTimeout(function () {
      var el = document.getElementById(props.initial);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setActive(props.initial);
      setSel({ id: props.initial, text: el.textContent, link: sentenceLink(props.initial), open: false, copied: null });
    }, 180);
    return function () { window.clearTimeout(t); };
  }, []);

  var menu = null;
  if (sel && sel.open) {
    var quoted = '\u201C' + sel.text + '\u201D';
    var enc = encodeURIComponent;
    var opts = [
      { k: 'notes', label: 'Notes', icon: 'note',
        href: 'mailto:?subject=' + enc('Saved from ' + BRAND) + '&body=' + enc(quoted + '\n\n' + sel.link) },
      /* Notion has no public prefill URL; the text is already on the clipboard, so this opens Notion to paste into. */
      { k: 'notion', label: 'Notion', icon: 'notion', href: 'https://www.notion.so/', blank: true },
      { k: 'wa', label: 'WhatsApp', icon: 'chat', href: 'https://wa.me/?text=' + enc(quoted + ' ' + sel.link), blank: true },
      { k: 'x', label: 'X', icon: 'x', href: 'https://x.com/intent/tweet?text=' + enc(quoted) + '&url=' + enc(sel.link), blank: true }
    ];
    menu = h('div', { ref: menuRef, className: 'hlmenu', role: 'dialog', 'aria-label': 'Share this passage',
                      style: { left: sel.x + 'px', top: sel.y + 'px' } },
      h('div', { className: 'hlmenu__status', 'aria-live': 'polite' },
        sel.copied === false ? null : h(Icon, { name: sel.copied ? 'check' : 'copy', size: 14 }),
        sel.copied === null ? 'Copying\u2026'
          : sel.copied ? 'Copied, with a link to this passage'
          : 'Clipboard unavailable here \u2014 share below instead'),
      /* margin notes are gone; the menu is share-only now */
      h('div', { className: 'hlmenu__grid' }, opts.map(function (o) {
        return h('a', { key: o.k, className: 'hlmenu__opt', href: o.href,
                        target: o.blank ? '_blank' : undefined, rel: o.blank ? 'noopener noreferrer' : undefined },
          h(Icon, { name: o.icon, size: 18 }), o.label);
      })),
      h('div', { className: 'hlmenu__foot' }, 'No sign-in needed. For Notion, paste into any page.')
    );
  }

  return h(HLContext.Provider, { value: apiRef.current }, props.children, menu);
}


/* ============================================================
   Margin notes — one shared layer, used by every article
   ------------------------------------------------------------
   Desktop (>=768px): unchanged from the original benchmark-article
   behaviour — a right-margin column, each note parked at the vertical
   offset of the passage it came from, stacked so they never overlap.

   Mobile (<768px): there is no room for a margin column, and the brief
   is that a note must never split a paragraph or push it down. So the
   highlighted span gets a small numbered marker inserted immediately
   after it (inline, a few characters wide), and tapping that marker
   opens the note in a bottom sheet that overlays the page. The sheet
   reuses the surface/border/shadow tokens and the status+foot type
   scale of the existing .hlmenu share popover rather than introducing
   a second overlay language.

   Only prose inside [data-ann-safe] can be annotated. Those subtrees
   are memoized so React never re-renders them, which is what keeps the
   <span class="ann"> wrappers this code inserts into the DOM from
   being wiped out on the next state change.
   ============================================================ */

function annSafe(node) {
  var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
  return !!(el && el.closest && el.closest('[data-ann-safe]'));
}

/* First-visit tip: shown once per reader across every article. If storage is
   unavailable it still shows only once per page load. */
var NOTE_TIP_KEY = 'logzero.noteTipSeen';
var noteTipShown = false;
function noteTipSeen() {
  if (noteTipShown) return true;
  try { return window.localStorage.getItem(NOTE_TIP_KEY) === '1'; } catch (e) { return false; }
}
function markNoteTipSeen() {
  noteTipShown = true;
  try { window.localStorage.setItem(NOTE_TIP_KEY, '1'); } catch (e) {}
}

/* Retired: margin notes were removed from the reading view. Kept so the
   component library still parses; nothing renders it. */
function AnnotationLayerLegacy(props) {
  var variant = props.variant || 'column';
  var wrapRef = useRef(null), proseRef = useRef(null), colRef = useRef(null);

  var tp = useState(false), tip = tp[0], setTip = tp[1];
  /* narrow screens: where the tip points — the top of the first passage */
  var ta = useState(null), tipTop = ta[0], setTipTop = ta[1];

  /* The tip counts as seen only once the reader dismisses it, starts a
     selection, or (wide screens only) it times out — so a reader who never got
     a proper look at it sees it again next time. Phones never time out. */
  function dismissTip() { markNoteTipSeen(); setTip(false); }

  useEffect(function () {
    if (noteTipSeen()) return;
    var hideT = null;
    var showT = window.setTimeout(function () {
      /* a reader who already selected something has answered the question */
      if (noteTipSeen()) return;
      setTip(true);
      if (window.innerWidth >= 1240) hideT = window.setTimeout(dismissTip, 12000);
    }, 1200);
    return function () { window.clearTimeout(showT); window.clearTimeout(hideT); };
  }, []);

  /* keep the inline tip parked just above the first passage it describes */
  useEffect(function () {
    if (!tip) return;
    function place() {
      var prose = proseRef.current;
      var first = prose && prose.querySelector('[data-ann-safe]');
      if (!prose || !first) return;
      var t = first.getBoundingClientRect().top - prose.getBoundingClientRect().top;
      setTipTop(Math.max(0, Math.round(t)));
    }
    place();
    var t2 = window.setTimeout(place, 600);
    window.addEventListener('resize', place);
    return function () { window.clearTimeout(t2); window.removeEventListener('resize', place); };
  }, [tip]);

  var rangeRef = useRef(null), idRef = useRef(0), cidRef = useRef(0);
  /* note id -> the paragraph element it hangs off. A note marks the whole
     block now, so there is no wrapper span to look up by id, and a second
     note on the same paragraph would collide on a shared element id. */
  var hostsRef = useRef({});
  var ctx = React.useContext(HLContext);

  var n = useState([]), notes = n[0], setNotes = n[1];
  var p = useState(null), pop = p[0], setPop = p[1];
  var s2 = useState(null), sheet = s2[0], setSheet = s2[1];
  var d = useState(''), draft = d[0], setDraft = d[1];
  /* which comment a reply box is open under, and what is in it */
  var rt = useState(null), replyTo = rt[0], setReplyTo = rt[1];
  var rd = useState(''), reply = rd[0], setReply = rd[1];
  var sh = useState(null), shared = sh[0], setShared = sh[1];

  function isWide() { return window.innerWidth >= 768; }
  function noteById(id) { return notes.filter(function (x) { return x.id === id; })[0]; }

  /* --- selection -> the shared note/share menu -------------------------- */
  useEffect(function () {
    var prose = proseRef.current;
    if (!prose) return;

    function inUi(t) {
      return t && t.closest && (t.closest('.popover') || t.closest('.hlmenu') || t.closest('.notetip') ||
                                t.closest('.notesheet') || t.closest('.notemark') || t.closest('.note'));
    }

    function onUp(e) {
      if (inUi(e.target)) return;
      window.setTimeout(function () {
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        var range = sel.getRangeAt(0);
        if (!prose.contains(range.commonAncestorContainer)) return;
        if (!annSafe(range.commonAncestorContainer)) return;
        var text = sel.toString().trim();
        if (text.length < 3) return;
        var rect = range.getBoundingClientRect();
        if (!rect || !rect.width) return;
        rangeRef.current = range.cloneRange();
        dismissTip();
        /* The menu is the single entry point: it carries the note action and
           the share row, so a drag no longer raises a second popup of its own. */
        if (ctx && ctx.openForSelection) {
          ctx.openForSelection({ rects: range.getClientRects(), rect: rect, text: text });
        }
      }, 0);
    }

    function onDown(e) { if (inUi(e.target)) return; setPop(null); }

    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
    document.addEventListener('mousedown', onDown);
    return function () {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchend', onUp);
      document.removeEventListener('mousedown', onDown);
    };
  }, []);

  /* --- the menu hands the note action back here ------------------------- */
  useEffect(function () {
    if (!ctx || !ctx.registerNote) return;
    ctx.registerNote(function (o) {
      dismissTip();
      if (o.kind === 'sentence' && o.sid) {
        var el = document.getElementById(o.sid);
        if (!el) return;
        var r = document.createRange();
        r.selectNodeContents(el);
        rangeRef.current = r;
      }
      if (!rangeRef.current) return;
      setDraft('');
      var quote = o.text || '';
      if (isWide()) setPop({ x: o.x, y: o.y, quote: quote });
      else setSheet({ mode: 'compose', quote: quote });
    });
    return function () { if (ctx.registerNote) ctx.registerNote(null); };
  }, []);

  /* --- tapping an inline marker opens that note (mobile) --------------- */
  useEffect(function () {
    var prose = proseRef.current;
    if (!prose) return;
    function onClick(e) {
      var m = e.target.closest && e.target.closest('.notemark');
      if (!m) return;
      e.preventDefault();
      e.stopPropagation();
      setPop(null);
      setSheet({ mode: 'view', id: m.getAttribute('data-note') });
    }
    prose.addEventListener('click', onClick);
    return function () { prose.removeEventListener('click', onClick); };
  }, []);

  function anchorTop(el) {
    var wrap = wrapRef.current;
    if (!wrap || !el) return 0;
    return el.getBoundingClientRect().top - wrap.getBoundingClientRect().top;
  }

  /* The unit a note attaches to is the whole paragraph, not the words the
     reader happened to drag across. Whatever the selection was, this walks
     up to the block that contains it. */
  function blockFor(range) {
    if (!range) return null;
    var node = range.commonAncestorContainer;
    var el = node && (node.nodeType === 1 ? node : node.parentNode);
    if (!el || !el.closest) return null;
    var host = el.closest('p.hlp, .prose p, .prose li, .prose blockquote');
    if (!host) return null;
    return annSafe(host) ? host : null;
  }

  /* --- commit a note --------------------------------------------------- */
  function saveNote() {
    var text = draft.trim();
    var range = rangeRef.current;
    if (!text || !range) { setPop(null); setSheet(null); return; }
    var host = blockFor(range);
    if (!host) { setPop(null); setSheet(null); return; }

    var id = 'ann-' + (++idRef.current);
    /* A class on the paragraph, not a wrapper span around part of it. This
       is also what keeps the React invariant safe: the paragraph's children
       are never restructured, so nothing inside it can be reconciled away. */
    host.classList.add('ann-p');
    hostsRef.current[id] = host;

    /* The marker is always inserted; CSS shows it only on small screens.
       It goes at the end of the paragraph, since the paragraph is the unit. */
    var mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'notemark';
    mark.setAttribute('data-note', id);
    mark.setAttribute('aria-label', 'Open margin note');
    mark.textContent = String(notes.length + 1);
    host.appendChild(mark);

    /* the opening of the paragraph identifies it in the margin card */
    var quote = (host.textContent || '').replace(/\s+/g, ' ').trim();
    if (quote.length > 64) quote = quote.slice(0, 64).trim() + '…';
    var firstSent = host.querySelector('.sent');
    setNotes(function (list) {
      return list.concat([{
        id: id, quote: quote, top: anchorTop(host),
        /* the passage the thread hangs off, so Share can link back to it */
        sid: firstSent ? firstSent.id : null,
        /* a note is the first comment in a thread */
        who: READER, text: text, ts: Date.now(), likes: 0, liked: false, replies: []
      }]);
    });
    var sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    rangeRef.current = null;
    setPop(null);
    setSheet(null);
    setDraft('');
  }

  /* --- thread actions: reply, like, share ------------------------------- */
  function editNote(noteId, fn) {
    setNotes(function (list) {
      return list.map(function (nt) { return nt.id === noteId ? fn(nt) : nt; });
    });
  }

  function toggleLike(noteId, cid) {
    editNote(noteId, function (nt) {
      if (!cid) {
        return Object.assign({}, nt, { liked: !nt.liked, likes: nt.likes + (nt.liked ? -1 : 1) });
      }
      return Object.assign({}, nt, {
        replies: nt.replies.map(function (rp) {
          return rp.id === cid
            ? Object.assign({}, rp, { liked: !rp.liked, likes: rp.likes + (rp.liked ? -1 : 1) })
            : rp;
        })
      });
    });
  }

  function sendReply(noteId) {
    var text = reply.trim();
    if (!text) { setReplyTo(null); return; }
    var cid = 'c-' + (++cidRef.current);
    editNote(noteId, function (nt) {
      return Object.assign({}, nt, {
        replies: nt.replies.concat([{ id: cid, who: READER, text: text, ts: Date.now(), likes: 0, liked: false }])
      });
    });
    setReply('');
    setReplyTo(null);
  }

  /* Shares the comment itself, with a link back to the passage it hangs off. */
  function shareComment(noteId, cid, body, quote) {
    var key = noteId + ':' + (cid || 'root');
    var nt = noteById(noteId);
    var link = sentenceLink(nt && nt.sid);
    copyToClipboard('“' + quote + '”\n\n' + body + '\n\n' + link).then(function () {
      setShared(key);
      window.setTimeout(function () {
        setShared(function (cur) { return cur === key ? null : cur; });
      }, 1800);
    });
  }

  function removeNote(id) {
    var host = hostsRef.current[id];
    var prose = proseRef.current;
    var mark = prose && prose.querySelector('.notemark[data-note="' + id + '"]');
    if (mark && mark.parentNode) mark.parentNode.removeChild(mark);
    delete hostsRef.current[id];
    /* the paragraph keeps its tint while any other note still points at it */
    if (host && !host.querySelector('.notemark')) host.classList.remove('ann-p');
    setNotes(function (list) { return list.filter(function (x) { return x.id !== id; }); });
    setSheet(null);
  }

  /* --- renumber markers, then stack notes so they never overlap -------- */
  useLayoutEffect(function () {
    var prose = proseRef.current;
    if (prose) {
      var marks = Array.prototype.slice.call(prose.querySelectorAll('.notemark'));
      marks.forEach(function (m, i) { m.textContent = String(i + 1); });
    }
    var col = colRef.current;
    if (!col) return;
    var els = Array.prototype.slice.call(col.querySelectorAll('.note'));
    els.sort(function (a, b) { return Number(a.dataset.anchor) - Number(b.dataset.anchor); });
    var cursor = -1e9;
    els.forEach(function (el) {
      var want = Number(el.dataset.anchor) || 0;
      var top = Math.max(want, cursor);
      el.style.top = top + 'px';
      cursor = top + el.offsetHeight + 12;
    });
  });

  /* --- reflow anchors on resize ---------------------------------------- */
  useEffect(function () {
    var t = null;
    function onResize() {
      window.clearTimeout(t);
      t = window.setTimeout(function () {
        setNotes(function (list) {
          return list.map(function (nt) {
            var el = hostsRef.current[nt.id];
            return el ? Object.assign({}, nt, { top: anchorTop(el) }) : nt;
          });
        });
      }, 140);
    }
    window.addEventListener('resize', onResize);
    return function () { window.removeEventListener('resize', onResize); window.clearTimeout(t); };
  }, []);

  /* --- compose, opened from the menu at the menu's own position --------- */
  var composeQuote = pop && pop.quote ? (pop.quote.length > 90 ? pop.quote.slice(0, 90).trim() + '…' : pop.quote) : '';
  var popover = pop ? h('div', {
    className: 'popover', role: 'dialog', 'aria-label': 'Start a margin note',
    style: { left: pop.x + 'px', top: pop.y + 'px' }
  },
    composeQuote ? h('p', { className: 'popover__src' }, '“' + composeQuote + '”') : null,
    h('textarea', {
      autoFocus: true, value: draft, placeholder: 'What do you make of this?',
      'aria-label': 'Margin note',
      onChange: function (e) { setDraft(e.target.value); },
      onKeyDown: function (e) {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveNote();
        if (e.key === 'Escape') setPop(null);
      }
    }),
    h('div', { className: 'popover__row' },
      h('button', { className: 'btn-sm', onClick: function () { setPop(null); } }, 'Cancel'),
      h('button', { className: 'btn-sm btn-sm--go', onClick: saveNote }, 'Start thread'))
  ) : null;

  /* --- one comment, used for the note itself and for every reply -------- */
  function renderComment(nt, c, isRoot) {
    var cid = isRoot ? null : c.id;
    var key = nt.id + ':' + (cid || 'root');
    var open = replyTo === key;
    return h('div', { key: key, className: 'cmt' },
      h('div', { className: 'cmt__head' },
        h('span', { className: 'cmt__who' }, c.who),
        h('span', { className: 'cmt__when' }, fmtAgo(c.ts))),
      h('p', { className: 'cmt__body' }, c.text),
      h('div', { className: 'cmt__acts' },
        h('button', {
          className: 'cmtbtn', type: 'button',
          onClick: function () { setReply(''); setReplyTo(open ? null : key); }
        }, h(Icon, { name: 'chat', size: 13 }), 'Reply'),
        h('button', {
          className: cx('cmtbtn', c.liked && 'is-on'), type: 'button',
          'aria-pressed': c.liked ? 'true' : 'false',
          onClick: function () { toggleLike(nt.id, cid); }
        }, h(Icon, { name: c.liked ? 'heart-on' : 'heart', size: 13 }), 'Like',
           c.likes ? h('span', { className: 'cmtbtn__n' }, c.likes) : null),
        h('button', {
          className: cx('cmtbtn', shared === key && 'is-on'), type: 'button',
          onClick: function () { shareComment(nt.id, cid, c.text, nt.quote); }
        }, h(Icon, { name: shared === key ? 'check' : 'share', size: 13 }),
           shared === key ? 'Copied' : 'Share')
      ),
      open ? h('div', { className: 'replybox' },
        h('textarea', {
          autoFocus: true, value: reply, placeholder: 'Reply to ' + c.who + '…',
          'aria-label': 'Reply',
          onChange: function (e) { setReply(e.target.value); },
          onKeyDown: function (e) {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendReply(nt.id);
            if (e.key === 'Escape') setReplyTo(null);
          }
        }),
        h('div', { className: 'replybox__row' },
          h('button', { className: 'btn-sm', onClick: function () { setReplyTo(null); } }, 'Cancel'),
          h('button', { className: 'btn-sm btn-sm--go', onClick: function () { sendReply(nt.id); } }, 'Reply'))
      ) : null
    );
  }

  function renderThread(nt) {
    return h(React.Fragment, null,
      h('span', { className: 'note__src' }, '“' + nt.quote + '”'),
      renderComment(nt, nt, true),
      nt.replies.length
        ? h('div', { className: 'thread__replies' },
            nt.replies.map(function (c) { return renderComment(nt, c, false); }))
        : null
    );
  }

  /* --- the mobile bottom sheet ----------------------------------------- */
  var viewed = sheet && sheet.mode === 'view' ? noteById(sheet.id) : null;
  var sheetEl = null;
  if (sheet && (sheet.mode === 'compose' || viewed)) {
    var quote = sheet.mode === 'compose' ? sheet.quote : viewed.quote;
    if (quote && quote.length > 120) quote = quote.slice(0, 120).trim() + '…';
    sheetEl = h(React.Fragment, null,
      h('div', { className: 'notesheet__scrim', onClick: function () { setSheet(null); } }),
      h('div', { className: 'notesheet', role: 'dialog', 'aria-modal': 'true',
                 'aria-label': sheet.mode === 'compose' ? 'Start a margin note' : 'Margin note thread' },
        h('div', { className: 'notesheet__grip', 'aria-hidden': 'true' }),
        h('div', { className: 'notesheet__head' },
          sheet.mode === 'compose'
            ? 'Start a margin note'
            : 'Thread' + (viewed.replies.length ? ' · ' + (viewed.replies.length + 1) + ' comments' : '')),
        sheet.mode === 'compose'
          ? h('div', null,
              h('p', { className: 'notesheet__src' }, '“' + quote + '”'),
              h('textarea', {
                autoFocus: true, value: draft, placeholder: 'What do you make of this?',
                'aria-label': 'Margin note',
                onChange: function (e) { setDraft(e.target.value); },
                onKeyDown: function (e) { if (e.key === 'Escape') setSheet(null); }
              }),
              h('div', { className: 'notesheet__row' },
                h('button', { className: 'btn-sm', onClick: function () { setSheet(null); } }, 'Cancel'),
                h('button', { className: 'btn-sm btn-sm--go', onClick: saveNote }, 'Start thread')))
          : h('div', null,
              renderThread(viewed),
              h('div', { className: 'notesheet__row' },
                h('button', { className: 'btn-sm', onClick: function () { removeNote(viewed.id); } }, 'Delete thread'),
                h('button', { className: 'btn-sm btn-sm--go', onClick: function () { setSheet(null); } }, 'Close'))),
        h('div', { className: 'notesheet__foot' }, 'Threads stay on this device, in this session.')
      )
    );
  }

  var tipBody = [
    h(Icon, { key: 'i', name: 'note', size: 18 }),
    h('p', { key: 't', className: 'notetip__txt', style: { margin: 0 } },
      h('b', null, 'Margin notes'),
      h('span', null, 'Select any passage to leave a note beside the line it came from.')),
    h('button', { key: 'b', type: 'button', className: 'btn-sm', onClick: dismissTip }, 'Got it')
  ];

  return h(React.Fragment, null,
    h('div', { className: cx('notegrid', variant === 'overlay' && 'notegrid--overlay'), ref: wrapRef },
      h('div', { className: 'notebody', ref: proseRef },
        props.children,
        /* narrow screens: the tip pops up over the page, pointing at the first
           passage, and scrolls with it instead of being pinned to the window */
        (tip && !pop && !sheet && tipTop !== null)
          ? h('div', { key: 'tipanchor', className: 'notetip-anchor', style: { top: tipTop + 'px' } },
              h('div', { className: 'notetip notetip--inline', role: 'status', 'aria-live': 'polite' }, tipBody))
          : null),
      h('div', { className: cx('notecol', variant === 'overlay' && 'notecol--overlay'), ref: colRef },
        notes.map(function (nt) {
          return h('div', { key: nt.id, className: 'note', 'data-anchor': nt.top, style: { top: nt.top + 'px' } },
            h('button', { className: 'note__x', 'aria-label': 'Remove thread', onClick: function () { removeNote(nt.id); } }, '×'),
            renderThread(nt)
          );
        })
      )
    ),
    popover,
    sheetEl,
    /* wide screens: floating card, bottom-right of the window */
    (tip && !pop && !sheet) ? h('div', { className: 'notetip notetip--float', role: 'status', 'aria-live': 'polite' }, tipBody) : null
  );
}

/* The reading column, without margin notes. All that survives of the old
   layer is the drag-to-share gesture: selecting a passage still opens the
   share menu, since that is a sharing feature rather than a note one. */
function AnnotationLayer(props) {
  var proseRef = useRef(null);
  var ctx = React.useContext(HLContext);

  useEffect(function () {
    var prose = proseRef.current;
    if (!prose) return;
    function inUi(t) { return t && t.closest && t.closest('.hlmenu'); }
    function onUp(e) {
      if (inUi(e.target)) return;
      window.setTimeout(function () {
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
        var range = sel.getRangeAt(0);
        if (!prose.contains(range.commonAncestorContainer)) return;
        if (!annSafe(range.commonAncestorContainer)) return;
        var text = sel.toString().trim();
        if (text.length < 3) return;
        var rect = range.getBoundingClientRect();
        if (!rect || !rect.width) return;
        if (ctx && ctx.openForSelection) {
          ctx.openForSelection({ rects: range.getClientRects(), rect: rect, text: text });
        }
      }, 0);
    }
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchend', onUp);
    return function () {
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('touchend', onUp);
    };
  }, []);

  return h('div', { className: 'notegrid' },
    h('div', { className: 'notebody', ref: proseRef }, props.children));
}

/* ============================================================
   COMPONENT LIBRARY — set pieces built for the retired sample
   articles. Nothing renders these right now: the Drive articles are
   plain prose. They are kept intact so they can be attached to a
   future article that needs them, rather than rebuilt from scratch.
   (Scroll reveal, Go Deeper aside, pull quote, word cloud, sticky
   tier diagram, expandable card.)
   ============================================================ */

/* Scroll-driven reveal is the primary mechanism (CSS animation-timeline: view()).
   Browsers without it get an IntersectionObserver + CSS transition instead. */
function supportsScrollTimeline() {
  try { return !!(window.CSS && CSS.supports && CSS.supports('animation-timeline: view()')); }
  catch (e) { return false; }
}

function useRevealFallback(ref, delayMs) {
  useEffect(function () {
    var el = ref.current;
    if (!el || supportsScrollTimeline()) return;
    if (delayMs) el.style.transitionDelay = delayMs + 'ms';
    if (!('IntersectionObserver' in window)) { el.classList.add('is-in'); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { el.classList.add('is-in'); io.disconnect(); }
      });
    }, { threshold: 0.2 });
    io.observe(el);
    return function () { io.disconnect(); };
  }, []);
}

function GoDeeper(props) {
  var ref = useRef(null);
  useRevealFallback(ref, 0);
  return h('aside', { className: 'godeeper reveal', ref: ref },
    h('h4', null, props.title || 'Go deeper'),
    h('p', null, props.children)
  );
}

function PullQuote(props) {
  var quote = props.quote;
  var c = useState(false), copied = c[0], setCopied = c[1];

  function copy() {
    var text = '“' + quote + '” — ' + BRAND;
    copyToClipboard(text).then(function (ok) {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(function () { setCopied(false); }, 1800);
    });
  }

  var tweet = 'https://x.com/intent/tweet?text=' + encodeURIComponent('“' + quote + '” — ' + BRAND);

  return h('figure', { className: 'pullquote' },
    h('p', null, quote),
    h('div', { className: 'pullquote__tools' },
      h('a', { className: 'qbtn', href: tweet, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'Share this quote on X' },
        h(Icon, { name: 'x', size: 13 })),
      h('button', { className: cx('qbtn', copied && 'is-done'), onClick: copy, 'aria-label': copied ? 'Quote copied' : 'Copy this quote' },
        h(Icon, { name: copied ? 'check' : 'copy', size: 13 }))
    )
  );
}

/* --- word-cloud filter (one-off, deliberately not generalised) --------- */
var TEAMS = [
  { name: 'Platform Guild', values: ['clarity', 'precision', 'honesty'] },
  { name: 'Atlas Data', values: ['precision', 'brevity', 'clarity', 'structure'] },
  { name: 'Harbor Design', values: ['empathy', 'clarity', 'curiosity'] },
  { name: 'Kestrel Infra', values: ['brevity', 'structure', 'precision'] },
  { name: 'Meridian Research', values: ['curiosity', 'honesty', 'structure', 'empathy'] }
];
var VALUES = ['clarity', 'precision', 'structure', 'brevity', 'honesty', 'empathy', 'curiosity'];
function teamsClaiming(v) {
  return TEAMS.filter(function (t) { return t.values.indexOf(v) !== -1; }).map(function (t) { return t.name; });
}

function ValueChip(props) {
  var ref = useRef(null);
  useRevealFallback(ref, props.i * 70);
  var count = teamsClaiming(props.value).length;
  var style = { fontSize: (16 + count * 4) + 'px' };
  if (supportsScrollTimeline()) {
    style.animationRange = 'cover ' + (4 + props.i * 3) + '% cover ' + (24 + props.i * 3) + '%';
  }
  return h('button', {
    ref: ref,
    className: cx('chip', 'reveal', props.dim && 'is-dim', props.hit && 'is-hit'),
    style: style,
    onMouseEnter: function () { props.onPeek(props.value); },
    onMouseLeave: function () { props.onPeek(null); },
    onFocus: function () { props.onPeek(props.value); },
    onBlur: function () { props.onPeek(null); },
    onClick: function () { props.onPeek(props.value, true); }
  }, props.value);
}

function WordCloud() {
  var a = useState(null), team = a[0], setTeam = a[1];
  var b = useState(null), peek = b[0], setPeek = b[1];
  var active = team ? TEAMS.filter(function (t) { return t.name === team; })[0] : null;
  function onPeek(v) { setPeek(v); }

  var readout;
  if (peek) {
    var who = teamsClaiming(peek);
    readout = h('span', null, h('b', null, peek), ' is claimed by ' + who.length + (who.length === 1 ? ' team: ' : ' teams: ') + who.join(', ') + '.');
  } else if (active) {
    readout = h('span', null, h('b', null, active.name), ' lists ' + active.values.join(', ') + '. Tap a team again to see all five.');
  } else {
    readout = h('span', null, 'Tap a team to isolate its values, or hover a value to see who claims it.');
  }

  return h('div', { className: 'cloud' },
    h('div', { className: 'cloud__teams' }, TEAMS.map(function (t) {
      return h('button', {
        key: t.name, className: cx('teambtn', team === t.name && 'is-on'),
        'aria-pressed': team === t.name ? 'true' : 'false',
        onClick: function () { setTeam(team === t.name ? null : t.name); setPeek(null); }
      }, t.name);
    })),
    h('div', { className: 'cloud__values' }, VALUES.map(function (v, i) {
      return h(ValueChip, {
        key: v, value: v, i: i, onPeek: onPeek,
        dim: !!(active && active.values.indexOf(v) === -1),
        hit: peek === v || !!(active && active.values.indexOf(v) !== -1)
      });
    })),
    h('div', { className: 'cloud__readout', 'aria-live': 'polite' }, readout)
  );
}

/* --- sticky hierarchy diagram ----------------------------------------- */
var TIERS = [
  { name: 'Document', note: 'Reader sets the pace' },
  { name: 'Infodeck', note: 'Slides built to be read, not shown' },
  { name: 'Interactive web app', note: 'Reader drives the data' },
  { name: 'Recorded audio or video', note: 'Your pace, their schedule' },
  { name: 'Live presentation', note: 'Your pace, their schedule, one shot' }
];

function Tiers(props) {
  var rows = props.rows || TIERS;
  var prose = props.prose || [];
  var s = useState(0), active = s[0], setActive = s[1];
  var refs = useRef([]);

  useEffect(function () {
    if (!('IntersectionObserver' in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) {
          var idx = refs.current.indexOf(en.target);
          if (idx !== -1) setActive(idx);
        }
      });
    }, { rootMargin: '-42% 0px -42% 0px', threshold: 0 });
    refs.current.forEach(function (el) { if (el) io.observe(el); });
    return function () { io.disconnect(); };
  }, []);

  return h('div', { className: 'tiers' },
    h('div', { className: 'tiers__diagram' },
      h('div', { className: 'tierbox' },
        h('div', { className: 'tierbox__cap' }, props.caption || ''),
        rows.map(function (t, i) {
          return h('div', { key: t.name, className: cx('tier', i === active && 'is-on') },
            h('span', { className: 'tier__bar' }),
            h('span', null,
              h('span', { className: 'tier__name' }, t.name),
              h('span', { className: 'tier__note' }, t.note))
          );
        })
      )
    ),
    h('div', { className: 'tiers__prose' }, prose.map(function (t, i) {
      return h('div', { key: t.h, ref: function (el) { refs.current[i] = el; } },
        h('h3', null, t.h),
        h('p', null, t.p));
    }))
  );
}

function ExpandCard(props) {
  var id = 'xc-' + props.id;
  return h('div', { className: cx('xcard', props.open && 'is-open') },
    h('button', { className: 'xcard__head', 'aria-expanded': props.open ? 'true' : 'false', 'aria-controls': id, onClick: props.onToggle },
      h('span', { className: 'xcard__title' }, props.title),
      h('span', { className: 'xcard__plus', 'aria-hidden': 'true' }, '+')),
    props.open ? h('div', { className: 'xcard__body', id: id }, h('p', null, props.body)) : null
  );
}

function useToggleSet() {
  var s = useState({}), open = s[0], setOpen = s[1];
  return [open, function (k) { setOpen(function (o) { var n = Object.assign({}, o); n[k] = !n[k]; return n; }); }];
}

/* ============================================================
   Markdown → HTML
   V1 renders article bodies from plain Markdown: headings, bold,
   italic, ordered and unordered lists, links, blockquotes,
   horizontal rules and paragraphs. Code blocks and interactive
   blocks are deliberately out of scope for this version.

   Paragraph text is split into .sent spans so the existing
   highlight-to-share behaviour works on real article copy.
   ============================================================ */
function mdEscape(t) {
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Bold, italics, links and images. Deliberately no highlight or colour
   syntax — out of scope, and it would collide with the margin-note spans. */
function mdInline(t) {
  t = mdEscape(t);
  /* images first, or the link rule eats the one inside ![…](…) */
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g,
    function (_m, alt, src, cap) {
      return '<img class="mdimg" src="' + src + '" alt="' + alt + '" loading="lazy">'
        + (cap ? '<span class="mdimg__cap">' + cap + '</span>' : '');
    });
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
    '<a class="inline" href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return t;
}

/* Links are parked behind a sentinel before the sentence split, so a URL
   containing a full stop cannot be mistaken for the end of a sentence. */
function mdParagraph(raw, pid) {
  /* An emphasis run that closes on a full stop — "**...convenience.**" — would
     otherwise be cut in half by the sentence split, stranding the closing
     asterisks at the head of the next sentence where they render literally.
     Moving the stop outside the run keeps both the emphasis and the split. */
  raw = String(raw).replace(/([.!?])(\*{1,2})(\s|$)/g, '$2$1$3');

  /* Links AND images are parked whole before the sentence split: a URL
     carries full stops, and an image's leading "!" is itself a sentence
     terminator, so either would be cut in two. */
  var links = [];
  var parked = raw.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (m) {
    links.push(m); return '\u0001' + (links.length - 1) + '\u0001';
  });
  var restore = function (x) {
    return x.replace(/\u0001(\d+)\u0001/g, function (m, n) { return links[Number(n)]; });
  };
  var sents = splitSentences(parked);
  var body = sents.map(function (sent, i) {
    var trail = sent.match(/\s+$/);
    var core = trail ? sent.slice(0, sent.length - trail[0].length) : sent;
    if (!core) return '';
    return '<span class="sent" id="' + pid + '-s' + i + '" role="button" tabindex="0">' +
      mdInline(restore(core)) + '</span>' + (trail ? trail[0] : '');
  }).join('');
  return '<p class="hlp" data-ann-safe>' + body + '</p>';
}

function mdToHtml(md, idPrefix) {
  var lines = String(md).replace(/\r\n/g, '\n').split('\n');
  var out = [], para = [], quote = [], list = null, listType = null, pid = 0;

  /* The article title is the h1, so the shallowest heading the author used —
     whether they wrote "#" or "##" for their sections — becomes h2 and the
     rest nest under it. */
  var top = 0;
  lines.forEach(function (l) {
    var m = l.trim().match(/^(#{1,6})\s+\S/);
    if (m && (!top || m[1].length < top)) top = m[1].length;
  });
  var shift = 2 - (top || 1);

  function flushPara() {
    if (!para.length) return;
    out.push(mdParagraph(para.join(' ').trim(), idPrefix + '-p' + (++pid)));
    para = [];
  }
  function flushQuote() {
    if (!quote.length) return;
    out.push('<blockquote>' + quote.map(function (q) { return mdInline(q); }).join('<br>') + '</blockquote>');
    quote = [];
  }
  function flushList() {
    if (!list) return;
    out.push('<' + listType + '>' + list.map(function (li) {
      return '<li>' + mdInline(li) + '</li>';
    }).join('') + '</' + listType + '>');
    list = null; listType = null;
  }
  function flushAll() { flushPara(); flushQuote(); flushList(); }

  for (var i = 0; i < lines.length; i++) {
    var raw = lines[i], line = raw.trim();

    if (!line) { flushAll(); continue; }

    var hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      flushAll();
      var lvl = Math.min(Math.max(hm[1].length + shift, 2), 4);
      out.push('<h' + lvl + ' id="' + idPrefix + '-h' + i + '">' + mdInline(hm[2]) + '</h' + lvl + '>');
      continue;
    }
    if (/^(---|\*\*\*|___)$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

    /* an image on its own line is a figure, not a paragraph */
    var im = line.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
    if (im) {
      flushAll();
      out.push('<figure class="mdfig"><img src="' + mdEscape(im[2]) + '" alt="' + mdEscape(im[1]) + '" loading="lazy">'
        + (im[3] ? '<figcaption>' + mdEscape(im[3]) + '</figcaption>' : '') + '</figure>');
      continue;
    }
    if (/^>\s?/.test(line)) { flushPara(); flushList(); quote.push(line.replace(/^>\s?/, '')); continue; }

    var ul = line.match(/^[-*+]\s+(.*)$/);
    var ol = line.match(/^\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flushPara(); flushQuote();
      var want = ul ? 'ul' : 'ol';
      if (list && listType !== want) flushList();
      if (!list) { list = []; listType = want; }
      list.push((ul ? ul[1] : ol[1]));
      continue;
    }

    flushQuote(); flushList();
    para.push(line);
  }
  flushAll();
  return out.join('\n');
}

/* ============================================================
   In-article figures
   ------------------------------------------------------------
   Both come from this article's source doc, where they were flat
   images. The words are the author's; only the presentation is new.
   Each owns its own state, so opening one never re-renders the prose
   around it — which is what keeps the reader's margin notes alive.
   ============================================================ */

/* --- Figure 1: the setup is shown, the punchline is asked for --------- */
var FIG_SLIDE47 = {
  deck: 'Slide 47 of your AI strategy deck',
  claim: 'We are now an AI company.',
  sub: '(We told ChatGPT to write our roadmap.)',
  told: ['10x productivity', 'Zero tech overhead'],
  happened: ['3 prod outages', '1 very quiet engineer'],
  kick: 'AI strategy without tech foundation = expensive theatre.',
  cap: 'Your AI strategy needs a tech strategy first.'
};

function FigSlide47() {
  var s = useState(false), open = s[0], setOpen = s[1];
  var f = FIG_SLIDE47;
  return h('figure', { className: 'fig' },
    h('div', { className: 'fig__head' },
      h('span', { className: 'fig__k' }, 'The pitch'),
      h('span', { className: 'tag' }, 'Satire')),
    h('div', { className: 'deck47' },
      h('div', { className: 'deck47__bar' }, f.deck),
      h('div', { className: 'deck47__body' },
        h('p', { className: 'deck47__claim' }, f.claim),
        h('p', { className: 'deck47__sub' }, f.sub),
        h('div', { className: 'cr' },
          h('div', { className: 'cr__col' },
            h('p', { className: 'cr__h' }, 'What we told investors'),
            f.told.map(function (t, i) { return h('p', { key: i, className: 'cr__l' }, t); })),
          h('div', { className: 'cr__col cr__col--real' },
            h('div', { className: open ? 'cr__reveal' : '', style: open ? null : { visibility: 'hidden' } },
              h('p', { className: 'cr__h' }, 'What actually happened'),
              f.happened.map(function (t, i) { return h('p', { key: i, className: 'cr__l' }, t); })),
            open ? null : h('div', { className: 'cr__veil' },
              h('button', {
                type: 'button', className: 'cr__veilbtn', onClick: function () { setOpen(true); },
                'aria-label': 'Reveal what actually happened'
              }, 'Reveal what happened')))
        ),
        h('p', { className: 'deck47__kick' }, f.kick))
    ),
    h('figcaption', { className: 'fig__cap' }, f.cap)
  );
}

/* --- Figure 2: two companies, and a question worth answering ---------- */
var FIG_AB = {
  q: 'Which one are you building?',
  s: 'AI strategy starts with knowing what AI can’t do.',
  cols: [
    { key: 'a', name: 'Company A', quote: '“We’re AI-first!”', title: 'Bought 12 AI tools',
      lines: ['Has a prompt engineer.', 'No one understands the infra.', 'Ships demos, not products.'],
      pill: 'Looks great on LinkedIn' },
    { key: 'b', name: 'Company B', quote: '“We’re boring about tech.”', title: 'Built the foundation',
      lines: ['Knows what breaks and why.', 'AI makes them 10x faster.', 'Ships for every user.'],
      pill: 'Wins the market quietly' }
  ]
};

function FigAB() {
  var t = useState('a'), tab = t[0], setTab = t[1];   /* narrow screens only */
  var p = useState(null), said = p[0], setSaid = p[1];
  var f = FIG_AB;
  var picked = said ? f.cols.filter(function (c) { return c.key === said; })[0] : null;

  return h('figure', { className: 'fig' },
    h('div', { className: 'fig__head' },
      h('span', { className: 'fig__k' }, 'Two companies, same market'),
      h('span', { className: 'tag' }, 'Op-Ed')),

    /* the tab pair only renders on a phone, where two columns would stack */
    h('div', { className: 'abtabs', role: 'tablist', 'aria-label': 'Compare the two companies' },
      f.cols.map(function (c) {
        return h('button', {
          key: c.key, type: 'button', role: 'tab',
          className: cx('abtab', tab === c.key && 'is-on'),
          'aria-selected': tab === c.key ? 'true' : 'false',
          onClick: function () { setTab(c.key); }
        }, c.name);
      })),

    h('div', { className: 'ab' },
      f.cols.map(function (c) {
        return h('div', {
          key: c.key,
          className: cx('abc', 'abc--' + c.key, tab === c.key && 'is-shown',
                        said && said !== c.key && 'is-dim')
        },
          h('div', { className: 'abc__h' }, c.name),
          h('div', { className: 'abc__b' },
            h('p', { className: 'abc__q' }, c.quote),
            h('p', { className: 'abc__t' }, c.title),
            c.lines.map(function (l, i) { return h('p', { key: i, className: 'abc__l' }, l); }),
            h('div', { className: 'abc__foot' }, h('span', { className: 'abc__pill' }, c.pill)))
        );
      })),

    h('div', { className: 'poll' },
      picked
        /* no invented crowd: the reader's own answer, reflected back */
        ? h('div', { className: 'poll__said', role: 'status' },
            h('b', null, 'You’re building ' + picked.name + '.'),
            h('p', null, picked.pill + '. ' + f.s),
            h('button', { type: 'button', className: 'poll__again', onClick: function () { setSaid(null); } },
              'Change answer'))
        : h('div', null,
            h('p', { className: 'poll__q' }, f.q),
            h('p', { className: 'poll__s' }, f.s),
            h('div', { className: 'poll__row' },
              f.cols.map(function (c) {
                return h('button', {
                  key: c.key, type: 'button', className: 'btn-outline',
                  onClick: function () { setSaid(c.key); setTab(c.key); }
                }, 'I’m ' + c.name);
              })))
    )
  );
}

/* Referenced from an article's Markdown as a line reading @@fig:<id>@@ */
var FIGURES = {
  'slide47': FigSlide47,
  'ab-companies': FigAB
};

/* The same questions, reachable from a TL;DR slide by id. One source of
   truth: the deck poll and the in-article figure read the same object. */
var POLLS = { 'ab-companies': FIG_AB };

/* A poll sized for a deck slide — the question and the two answers, then
   the answer reflected back. The cards themselves stay in the article. */
function DeckPoll(props) {
  var f = props.data;
  var p = useState(null), said = p[0], setSaid = p[1];
  var picked = said ? f.cols.filter(function (c) { return c.key === said; })[0] : null;
  return h('div', { className: 'tdpoll' },
    picked
      /* the pick, with what it stands for — the deck may be the only place
         the reader meets these two, so the answer restates the case */
      ? h('div', { className: 'tdpoll__said', role: 'status' },
          h('b', null, 'You’re building ' + picked.name + '.'),
          h('span', null, picked.title + '. ' + picked.pill + '.'),
          h('div', { className: 'tdpoll__lines' },
            picked.lines.map(function (l, i) { return h('p', { key: i }, l); })),
          h('button', { type: 'button', className: 'poll__again', onClick: function () { setSaid(null); } },
            'Change answer'))
      : h('div', null,
          h('p', { className: 'tdpoll__q' }, f.q),
          /* each answer carries its own description: a reader who opened the
             deck from a list card has never seen the cards in the article */
          h('div', { className: 'tdpoll__choices' },
            f.cols.map(function (c) {
              return h('button', {
                key: c.key, type: 'button', className: cx('tdchoice', 'tdchoice--' + c.key),
                onClick: function () { setSaid(c.key); },
                'aria-label': 'I’m ' + c.name + ' — ' + c.title
              },
                h('span', { className: 'tdchoice__n' }, c.name),
                h('span', { className: 'tdchoice__q' }, c.quote),
                h('span', { className: 'tdchoice__t' }, c.title),
                h('span', { className: 'tdchoice__ls' },
                  c.lines.map(function (l, i) { return h('span', { key: i, className: 'tdchoice__l' }, l); }))
              );
            })))
  );
}

/* ============================================================
   TL;DR deck — the summary as a full-viewport horizontal story
   ------------------------------------------------------------
   Same data as before (post.tldr); only the presentation changed.
   A wheel or trackpad gesture drives horizontal progression: deltas
   accumulate until they clear a threshold, then one eased step fires
   and a short lock keeps a single flick from skipping three slides.
   Touch drags the track directly and snaps on release. Both ends
   rubber-band instead of dead-stopping.
   ============================================================ */
var TDECK_STEP_MS = 720;
var TDECK_WHEEL = 90;   /* accumulated delta that commits a step */
var TDECK_SWIPE = 56;   /* px of drag that commits a step */

/* ------------------------------------------------------------------
   Where the slides come from.

   A slide is a sentence the article already contains, shown in the
   order the article puts it in. Nothing is rewritten or condensed into
   new wording. The only judgement is WHICH sentences, and that sits
   behind one function — TLDR_SELECT(post, n) — so a model can take the
   job over later without the deck changing at all.

   Contract: (post, n) -> array of up to n strings, each lifted verbatim
   from post.md, in document order.
   ------------------------------------------------------------------ */
var TLDR_COUNT = 6;

/* Markdown reduced to the prose a person would read aloud: no headings,
   no link syntax, no figure markers, no list bullets. */
function tldrPlainText(md) {
  var t = String(md || '');
  t = t.replace(/```[\s\S]*?```/g, ' ');
  t = t.replace(/^[ \t]*@@fig:[a-z0-9-]+@@[ \t]*$/gmi, ' ');
  t = t.replace(/^\s{0,3}#{1,6}\s+.*$/gm, ' ');
  t = t.replace(/^\s{0,3}>\s?/gm, '');
  t = t.replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gm, '');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  t = t.replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
  t = t.replace(/^\s{0,3}(?:[-*_]\s*){3,}$/gm, ' ');
  return t;
}

function tldrSentences(md) {
  var out = [];
  tldrPlainText(md).split(/\n{2,}/).forEach(function (para) {
    var p = para.replace(/\s+/g, ' ').trim();
    if (!p) return;
    var parts = p.match(/[^.!?]+(?:[.!?]+["'’”)\]]*|$)/g) || [p];
    parts.forEach(function (s) {
      s = s.trim();
      if (s.split(/\s+/).length >= 5) out.push(s);
    });
  });
  return out;
}

var TLDR_STOP = (' a an and are as at be but by for from has have how i if in into is it its of on or '
  + 'our so than that the their then there these they this to was we were what when which who will with you your ').split(/\s+/);

function tldrKeyWords(s) {
  var out = [];
  String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).forEach(function (w) {
    if (w.length > 3 && TLDR_STOP.indexOf(w) === -1 && out.indexOf(w) === -1) out.push(w);
  });
  return out;
}

/* The default selector: a plain extractive heuristic, no model involved.
   The article is cut into n bands and the strongest sentence in each band
   is taken, so the run covers the piece start to finish instead of
   clustering in the opening. */
function tldrPickRepresentative(post, n) {
  var sents = tldrSentences(post.md);
  if (!sents.length) return [];
  if (sents.length <= n) return sents;
  var title = tldrKeyWords(post.title);

  function score(s, i) {
    var w = s.split(/\s+/).length;
    var len = w <= 7 ? 0.45 : w <= 12 ? 0.8 : w <= 30 ? 1 : w <= 42 ? 0.72 : 0.4;
    var lead = 1 - (i / sents.length) * 0.3;          /* earlier carries the claim */
    var kw = tldrKeyWords(s), hit = 0;
    title.forEach(function (t) { if (kw.indexOf(t) !== -1) hit++; });
    var echo = title.length ? hit / title.length : 0;  /* does it echo the headline */
    return len * lead + echo * 0.7;
  }

  var out = [];
  for (var band = 0; band < n; band++) {
    var from = Math.floor(band * sents.length / n);
    var to = Math.max(from + 1, Math.floor((band + 1) * sents.length / n));
    var best = -1, top = -Infinity;
    for (var i = from; i < to && i < sents.length; i++) {
      var sc = score(sents[i], i);
      if (sc > top) { top = sc; best = i; }
    }
    if (best >= 0) out.push(sents[best]);
  }
  return out;
}

/* Swap this one binding for a model-backed call when the backend lands. */
var TLDR_SELECT = tldrPickRepresentative;

/* What the deck renders: a title slide, then one extracted sentence each.
   Memoised per article so selection runs once, not on every open. */
var TLDR_CACHE = {};
function tldrSlides(post, n) {
  if (!post) return [];
  var key = post.id + ':' + (n || TLDR_COUNT);
  if (TLDR_CACHE[key]) return TLDR_CACHE[key];
  var picked = TLDR_SELECT(post, n || TLDR_COUNT) || [];
  var out = [{ kind: 'intro', text: post.title, sub: post.excerpt }];
  picked.forEach(function (s) { out.push({ kind: 'line', text: s }); });
  TLDR_CACHE[key] = out;
  return out;
}

/* How long a slide holds before the deck moves on: roughly the time it
   takes to read it, floored so a short line isn't a flash and capped so a
   long one doesn't stall. */
function tldrWords(s) { return String(s && s.text || '').trim().split(/\s+/).length; }
function tldrDwell(sl) {
  /* the title card is a beat, not a read */
  if (sl && sl.kind === 'intro') return 3800;
  var w = tldrWords(sl);
  return Math.round(Math.max(2800, Math.min(9000, 1100 + (w / 3.1) * 1000)));
}

/* Type scales with the sentence: six words fill the screen, forty don't. */
function tldrType(sl) {
  var w = tldrWords(sl);
  var px = Math.round(Math.max(23, Math.min(58, 60 - (w - 6) * 0.85)));
  /* the floor scales too, or every slide bottoms out at the same size on a
     phone and the difference between a short line and a long one is lost */
  var min = Math.round(Math.max(17, Math.min(30, px * 0.44)));
  return 'clamp(' + min + 'px, ' + (px / 7.2).toFixed(2) + 'vw, ' + px + 'px)';
}

/* Audio runs off the recording length; the figure is a placeholder until
   one exists. Read time is the article's own. */
function audioMinutes(p) { return Math.max(1, Math.round(((p && p.audioSec) || 0) / 60)); }
function readMinutes(p) { return Math.max(1, (p && p.readMin) || 1); }

/* ~200 words a minute, rounded up, for the "TLDR 1 min" badge */
function tldrMinutes(post) {
  var slides = tldrSlides(post);
  var w = 0;
  slides.forEach(function (s) { w += tldrWords(s); });
  return Math.max(1, Math.round(w / 180));
}

/* How a slide lays out when it has no image. A slide that DOES carry one
   always uses 'split', so this only governs the image-less case.
     'column' — ordinal over a centred measure, rule, sentence ranged left
     'hero'   — the sentence is the composition, ordinal as a kicker
     'split'  — the two-column figure layout, with the ordinal as the figure */
var TDECK_LAYOUT = 'column';

/* A TL;DR entry is a plain string, or an object once it has art:
   { text: '…', img: '…', alt: '…' } */
function tdeckSlide(s) {
  return (s && typeof s === 'object') ? s : { text: String(s) };
}

/* Copies a link and says so for a moment; falls back to the native share
   sheet where one exists and the clipboard does not. */
function ShareLinkButton(props) {
  var c = useState(false), copied = c[0], setCopied = c[1];
  var link = props.link || String(window.location.href);
  function share() {
    copyToClipboard(link).then(function (ok) {
      if (ok) {
        setCopied(true);
        window.setTimeout(function () { setCopied(false); }, 1800);
      } else if (navigator.share) {
        navigator.share({ title: props.title || BRAND, url: link }).catch(function () {});
      }
    });
  }
  return h('button', { className: cx('btn-outline', copied && 'is-done'), type: 'button', onClick: share,
                       'aria-label': copied ? 'Link copied' : (props.label || 'Share this summary') },
    h(Icon, { name: copied ? 'check' : 'share', size: 15 }), copied ? 'Link copied' : (props.label || 'Share'));
}

function TldrDeck(props) {
  var slides = props.slides || [];
  var n = slides.length;
  var s = useState(0), idx = s[0], setIdx = s[1];
  /* auto-advance runs until the reader takes over or the deck ends */
  var pl = useState(true), playing = pl[0], setPlaying = pl[1];
  var dg = useState(0), drag = dg[0], setDrag = dg[1];   /* live drag, in % of a slide */
  var an = useState(true), animating = an[0], setAnimating = an[1];

  var idxRef = useRef(0); idxRef.current = idx;
  var lockRef = useRef(false);
  var accRef = useRef(0);
  var touchRef = useRef(null);
  var rootRef = useRef(null);
  var reduce = prefersReducedMotion();

  /* The deck starts where the site header ends, so the header stays in view.
     Measured rather than assumed: the header is taller before it compacts. */
  var ht = useState(0), headTop = ht[0], setHeadTop = ht[1];
  useLayoutEffect(function () {
    function measure() {
      var el = document.querySelector('.sitehead');
      setHeadTop(el ? Math.max(0, Math.round(el.getBoundingClientRect().bottom)) : 0);
    }
    measure();
    window.addEventListener('resize', measure);
    return function () { window.removeEventListener('resize', measure); };
  }, []);

  function goTo(next) {
    var clamped = Math.max(0, Math.min(n - 1, next));
    if (clamped === idxRef.current) return false;
    setAnimating(true);
    setIdx(clamped);
    return true;
  }

  /* One step per gesture: the lock clears after the transition, so a long
     trackpad flick advances one slide rather than running to the end. */
  function step(d) {
    if (lockRef.current) return false;
    var moved = goTo(idxRef.current + d);
    if (moved) {
      lockRef.current = true;
      window.setTimeout(function () { lockRef.current = false; }, reduce ? 60 : TDECK_STEP_MS * 0.72);
    }
    return moved;
  }

  /* --- auto-advance ---------------------------------------------------
     Each slide holds for about as long as it takes to read, and the bar
     across the top fills over the same span. It stops at the last slide
     rather than looping, and any manual move hands control back. */
  useEffect(function () {
    if (!playing || idx >= n - 1) return;
    var t = window.setTimeout(function () {
      lockRef.current = false;
      step(1);
    }, tldrDwell(tdeckSlide(slides[idx])));
    return function () { window.clearTimeout(t); };
  }, [idx, playing, n]);

  /* --- wheel: vertical scroll drives horizontal progression ----------- */
  useEffect(function () {
    var el = rootRef.current;
    if (!el) return;
    var settle = null;

    function onWheel(e) {
      e.preventDefault();           /* the page underneath never scrolls */
      if (lockRef.current) return;
      /* trackpads send horizontal deltas too; take whichever is dominant */
      var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      accRef.current += d;
      if (Math.abs(accRef.current) < TDECK_WHEEL) {
        /* rubber-band at the ends so the gesture still reads as received */
        var at = idxRef.current;
        var over = (at === 0 && accRef.current < 0) || (at === n - 1 && accRef.current > 0);
        if (over && !reduce) {
          setAnimating(false);
          setDrag(Math.max(-6, Math.min(6, -accRef.current / 26)));
          window.clearTimeout(settle);
          settle = window.setTimeout(function () {
            setAnimating(true); setDrag(0); accRef.current = 0;
          }, 140);
        }
        return;
      }
      var dir = accRef.current > 0 ? 1 : -1;
      accRef.current = 0;
      setDrag(0);
      step(dir);
    }

    el.addEventListener('wheel', onWheel, { passive: false });
    return function () { el.removeEventListener('wheel', onWheel); window.clearTimeout(settle); };
  }, [n]);

  /* --- touch: drag the track, snap on release ------------------------- */
  useEffect(function () {
    var el = rootRef.current;
    if (!el) return;

    function onStart(e) {
      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      touchRef.current = { x: t.clientX, y: t.clientY, axis: null, w: el.offsetWidth || 1 };
    }
    function onMove(e) {
      var st = touchRef.current;
      if (!st) return;
      var t = e.touches[0];
      var dx = t.clientX - st.x, dy = t.clientY - st.y;
      if (!st.axis) {
        if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return;
        /* a horizontal swipe is the natural gesture here; a vertical one
           still works, so the desktop metaphor is not lost on touch */
        st.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      }
      e.preventDefault();
      var raw = st.axis === 'x' ? dx : dy;
      var pct = (raw / st.w) * 100;
      var at = idxRef.current;
      if ((at === 0 && pct > 0) || (at === n - 1 && pct < 0)) pct *= 0.28;  /* resist at the ends */
      st.last = raw;
      setAnimating(false);
      setDrag(Math.max(-100, Math.min(100, pct)));
    }
    function onEnd() {
      var st = touchRef.current;
      touchRef.current = null;
      setAnimating(true);
      setDrag(0);
      if (!st || !st.axis) return;
      var moved = st.last || 0;
      if (Math.abs(moved) > TDECK_SWIPE) { lockRef.current = false; step(moved < 0 ? 1 : -1); }
    }

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return function () {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [n]);

  /* --- keys, and the page lock underneath ----------------------------- */
  useEffect(function () {
    function onKey(e) {
      if (e.key === 'Escape') { props.onClose(); return; }
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); lockRef.current = false; step(1); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); lockRef.current = false; step(-1); }
      else if (e.key === 'Home') { e.preventDefault(); goTo(0); }
      else if (e.key === 'End') { e.preventDefault(); goTo(n - 1); }
    }
    document.addEventListener('keydown', onKey);

    var at = window.pageYOffset || document.documentElement.scrollTop || 0;
    var prevO = document.body.style.overflow;
    var prevR = document.documentElement.style.overscrollBehavior;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overscrollBehavior = 'none';
    if (rootRef.current) rootRef.current.focus({ preventScroll: true });

    return function () {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevO;
      document.documentElement.style.overscrollBehavior = prevR;
      /* land the reader back exactly where they were */
      window.requestAnimationFrame(function () {
        var now = window.pageYOffset || document.documentElement.scrollTop || 0;
        if (Math.abs(now - at) > 2) {
          try { window.scrollTo({ top: at, behavior: 'auto' }); } catch (e) { window.scrollTo(0, at); }
        }
      });
    };
  }, [n]);

  if (!n) return null;
  var last = idx === n - 1;
  var live = tdeckSlide(slides[idx]);
  var dwell = tldrDwell(live);
  var layout = props.layout || TDECK_LAYOUT;
  /* the head follows the slide: centred layouts put the whole deck on one
     axis, the split layout keeps the head flush left with the figure */
  var anyImg = slides.some(function (s) { return !!tdeckSlide(s).img; });
  var centred = layout !== 'split' && !anyImg;
  var ease = 'cubic-bezier(.76,0,.24,1)';
  var trackStyle = {
    transform: 'translate3d(' + (-idx * 100 + drag) + '%,0,0)',
    transition: (animating && !reduce) ? 'transform ' + TDECK_STEP_MS + 'ms ' + ease : 'none'
  };

  /* Progress, one segment per slide, the live one filling over the time
     that slide holds for. It is also the navigation — a segment can be
     clicked. It now sits at the base of the deck, above the capsule. */
  var bar = h('div', { className: 'tdeck__bar', role: 'tablist', 'aria-label': 'Summary progress' },
    slides.map(function (_, i) {
      return h('button', {
        key: i, type: 'button',
        className: cx('tdeck__seg', i < idx && 'is-done', i === idx && 'is-live'),
        role: 'tab', 'aria-selected': i === idx ? 'true' : 'false',
        'aria-label': 'Slide ' + (i + 1) + ' of ' + n,
        onClick: function () { goTo(i); }
      }, h('span', {
        key: 'f' + idx, className: 'tdeck__segfill',
        style: i === idx
          ? { animationDuration: dwell + 'ms', animationPlayState: playing ? 'running' : 'paused' }
          : null
      }));
    }));

  return h('div', {
    className: 'tdeck', ref: rootRef, tabIndex: -1,
    role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Summary of ' + props.title,
    style: { top: headTop + 'px' }
  },
    h('div', { className: 'tdeck__scrim' }),

    /* The strip: "TL;DR | title", pause, and the X — the same strip the Read
       and Listen views carry, so the three modes read as one frame. */
    h('div', { className: 'tdeck__head' },
      h('p', { className: 'tdeck__runhead' },
        h('span', { className: 'tdeck__kick' }, 'TL;DR'), props.title),
      h('button', {
        className: 'tdeck__pp', type: 'button',
        'aria-label': playing ? 'Pause the summary' : 'Play the summary',
        onClick: function () { setPlaying(!playing); }
      }, playing ? '❙❙' : '▶'),
      h('button', { className: 'tdeck__x', onClick: props.onClose, 'aria-label': 'Close summary' },
        h(Icon, { name: 'close', size: 14 }))
    ),

    h('div', { className: cx('tdeck__next', last && 'is-off'), 'aria-hidden': 'true' },
      h('span', null, 'Next'), h('i', null)),

    h('div', { className: 'tdeck__track', style: trackStyle },
      slides.map(function (raw, i) {
        var sl = tdeckSlide(raw);
        var ord = (i + 1 < 10 ? '0' : '') + (i + 1);
        /* an image, when there is one, always gets the split figure layout */
        var lay = sl.img ? 'split' : layout;
        var d = i - idx;
        /* the card drifts against the track and fades off-centre */
        var cardStyle = {
          transform: reduce ? 'none' : 'translate3d(' + (d * 13) + '%,0,0)',
          opacity: d === 0 ? 1 : 0.08,
          transition: reduce ? 'none'
            : 'transform ' + TDECK_STEP_MS + 'ms ' + ease + ', opacity ' + (TDECK_STEP_MS * 0.8) + 'ms ease'
        };

        /* the last slide ends on Read + Share: the summary's own link goes
           to the clipboard, so the deck can be passed on as it stands */
        var tail = i === n - 1
          ? h('div', { key: 'end', className: 'tdeck__end' },
              props.onRead
                ? h('button', { className: 'btn-outline', onClick: props.onRead }, 'Read the full article')
                : null,
              h(ShareLinkButton, { link: props.shareLink, title: props.title }))
          : null;

        /* V1 is full text or full image. The first slide is the title card. */
        var inner;
        if (sl.kind === 'intro') {
          inner = [
            h('div', { key: 'i', className: 'tdeck__intro' },
              h('p', { className: 'tdeck__eyebrow' },
                [props.tag, props.meta].filter(Boolean).join(' · ')),
              h('h2', { className: 'tdeck__big' }, sl.text),
              sl.sub ? h('p', { className: 'tdeck__stand' }, sl.sub) : null),
            tail
          ];
        } else if (lay === 'split' && sl.img) {
          inner = [
            h('div', { key: 'f', className: 'tdeck__figbox' },
              h('img', { className: 'tdeck__figimg', src: sl.img, alt: sl.alt || '' })),
            h('div', { key: 'g', className: 'tdeck__fig' },
              h('p', { className: 'tdeck__body', style: { fontSize: tldrType(sl) } }, sl.text), tail)
          ];
        } else {
          /* type scales with the sentence, so a short line lands large */
          inner = [
            h('p', { key: 'b', className: 'tdeck__body', style: { fontSize: tldrType(sl) } }, sl.text),
            tail
          ];
        }

        return h('section', {
          key: i, className: 'tdeck__slide',
          'aria-hidden': d === 0 ? 'false' : 'true'
        },
          h('div', { className: cx('tdeck__card', 'tdeck__card--' + (sl.kind === 'intro' ? 'intro' : lay)), style: cardStyle }, inner)
        );
      })
    ),

    bar,

    /* The mode switcher stays reachable from inside the deck, so Read and
       Audio are one tap away without closing it first. */
    h('div', { className: 'tdeck__foot' },
      h('div', { className: 'modes modes--deck modes--timed', role: 'tablist', 'aria-label': 'How to take this in' },
        h('button', {
          className: 'mode', role: 'tab', 'aria-selected': 'false',
          'aria-label': 'Read \u2014 ' + (props.times && props.times.read) + ' min',
          disabled: !props.onRead, onClick: function () { if (props.onRead) props.onRead(); }
        }, h(Icon, { name: 'text', size: 14 }), h('span', { className: 'mode__t' }, 'Read'),
           h('span', { className: 'mode__d' }, (props.times && props.times.read) + ' min')),
        h('button', { className: 'mode is-on', role: 'tab', 'aria-selected': 'true',
          'aria-label': 'TLDR \u2014 ' + (props.times && props.times.tldr) + ' min' },
          h(Icon, { name: 'bolt', size: 14 }), h('span', { className: 'mode__t' }, 'TLDR'),
          h('span', { className: 'mode__d' }, (props.times && props.times.tldr) + ' min')),
        h('button', {
          className: 'mode', role: 'tab', 'aria-selected': 'false',
          'aria-label': 'Listen \u2014 ' + (props.times && props.times.audio) + ' min',
          disabled: !props.onListen, title: props.onListen ? null : 'Audio is not recorded yet',
          onClick: function () { if (props.onListen) props.onListen(); }
        }, h(Icon, { name: 'headphones', size: 14 }), h('span', { className: 'mode__t' }, 'Listen'),
           h('span', { className: 'mode__d' }, (props.times && props.times.audio) + ' min'))),
      h('span', { className: 'sr', 'aria-live': 'polite' }, 'Slide ' + (idx + 1) + ' of ' + n)
    )
  );
}

/* ============================================================
   Article template — one component, every article
   ============================================================ */

/* Injected once and never re-rendered, so margin-note spans the reader
   adds inside it are never reconciled away. */
var ArticleProse = React.memo(function (props) {
  return h('div', {
    className: 'prose', 'data-ann-safe': '',
    dangerouslySetInnerHTML: { __html: props.html }
  });
}, function (a, b) { return a.html === b.html; });

/* An article's body is split on its @@fig:<id>@@ lines into alternating
   prose and figure blocks. Each prose block is memoized on its own html,
   so a figure changing state never reconciles the text around it. */
function articleBlocks(md, id) {
  var parts = String(md).split(/^[ \t]*@@fig:([a-z0-9-]+)@@[ \t]*$/mi);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      if (FIGURES[parts[i]]) out.push({ t: 'fig', id: parts[i] });
      continue;
    }
    if (parts[i] && parts[i].trim()) {
      out.push({ t: 'md', html: mdToHtml(parts[i], id + '-b' + i) });
    }
  }
  return out;
}

function fmtClock(sec) {
  var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

/* --- TLDR: auto-advancing summary slides ------------------------------ */
var TLDR_MS = 2600;

function TldrPanel(props) {
  var slides = props.slides;
  var i = useState(0), idx = i[0], setIdx = i[1];
  var p = useState(false), paused = p[0], setPaused = p[1];

  useEffect(function () {
    if (paused || prefersReducedMotion() || slides.length < 2) return;
    var t = window.setTimeout(function () {
      setIdx(function (n) { return (n + 1) % slides.length; });
    }, TLDR_MS);
    return function () { window.clearTimeout(t); };
  }, [idx, paused, slides.length]);

  function step(d) {
    setIdx(function (n) { return (n + d + slides.length) % slides.length; });
  }

  return h('div', {
    className: 'tldr', role: 'group', 'aria-label': 'Summary slides',
    onMouseEnter: function () { setPaused(true); },
    onMouseLeave: function () { setPaused(false); },
    onFocus: function () { setPaused(true); },
    onBlur: function () { setPaused(false); }
  },
    h('div', { className: 'tldr__bar', 'aria-hidden': 'true' }, slides.map(function (_, n) {
      return h('span', { key: n, className: cx('tldr__seg', n === idx && 'is-on', n < idx && 'is-done') });
    })),
    h('p', { className: 'tldr__slide', key: idx, 'aria-live': 'polite' }, slides[idx]),
    h('div', { className: 'tldr__foot' },
      h('span', { className: 'tldr__count' }, (idx + 1) + ' / ' + slides.length),
      h('div', { className: 'tldr__nav' },
        h('button', { className: 'tldr__btn', onClick: function () { step(-1); }, 'aria-label': 'Previous point' }, '←'),
        h('button', { className: 'tldr__btn', onClick: function () { step(1); }, 'aria-label': 'Next point' }, '→')
      )
    ),
    h('p', { className: 'tldr__note' }, 'Placeholder summary — generated summaries will replace these.')
  );
}

/* --- Listen: mock player, no audio asset yet -------------------------- */
function AudioPanel(props) {
  var dur = props.duration || 150;
  var p = useState(false), playing = p[0], setPlaying = p[1];
  var t = useState(0), pos = t[0], setPos = t[1];

  useEffect(function () {
    if (!playing) return;
    var iv = window.setInterval(function () {
      setPos(function (n) {
        if (n + 0.25 >= dur) { setPlaying(false); return dur; }
        return n + 0.25;
      });
    }, 250);
    return function () { window.clearInterval(iv); };
  }, [playing, dur]);

  return h('div', { className: 'audio' },
    h('button', {
      className: 'audio__play', onClick: function () { setPlaying(!playing); },
      'aria-label': playing ? 'Pause' : 'Play'
    }, playing ? '⏸' : '▶'),
    h('div', { className: 'audio__main' },
      h('input', {
        className: 'audio__range', type: 'range', min: 0, max: dur, step: 0.25, value: pos,
        'aria-label': 'Seek',
        onChange: function (e) { setPos(Number(e.target.value)); }
      }),
      h('div', { className: 'audio__times' },
        h('span', null, fmtClock(pos)),
        h('span', null, fmtClock(dur)))
    ),
    h('p', { className: 'audio__note' }, 'Placeholder — the author’s recorded summary is not wired up yet.')
  );
}

/* ------------------------------------------------------------------
   Reactions — one per reader per article.

   No comments and no threads here: that is a later step. The limit is
   kept in localStorage, which is all a prototype needs; the real thing
   would key it to a session or an address server-side. Counts start
   from nothing rather than from invented numbers.
   ------------------------------------------------------------------ */
var REACTIONS = [
  ['useful', '💡', 'Useful'],
  ['agree', '👍', 'Agree'],
  ['disagree', '🤔', 'Not convinced'],
  ['sharp', '🔥', 'Sharp'],
  ['more', '📚', 'Want more on this']
];
var RX_KEY = 'logzero.reaction.';

function readReaction(id) {
  try { return window.localStorage.getItem(RX_KEY + id) || null; } catch (e) { return null; }
}

function Reactions(props) {
  var id = props.id;
  var m = useState(function () { return readReaction(id); }), mine = m[0], setMine = m[1];
  var c = useState({}), counts = c[0], setCounts = c[1];

  useEffect(function () { setMine(readReaction(id)); setCounts({}); }, [id]);

  function pick(k) {
    if (mine) return;                       /* one per reader, no take-backs */
    setMine(k);
    setCounts(function (prev) {
      var next = {}; for (var p in prev) next[p] = prev[p];
      next[k] = (next[k] || 0) + 1; return next;
    });
    try { window.localStorage.setItem(RX_KEY + id, k); } catch (e) {}
  }

  return h('section', { className: 'rx', 'aria-label': 'React to this article' },
    h('p', { className: 'rx__lbl' }, mine ? 'Thanks — your reaction is in.' : 'What did you make of it?'),
    h('div', { className: 'rx__row' },
      REACTIONS.map(function (r) {
        var on = mine === r[0];
        return h('button', {
          key: r[0], type: 'button',
          className: cx('rxbtn', on && 'is-mine', mine && !on && 'is-spent'),
          disabled: !!mine && !on,
          'aria-pressed': on ? 'true' : 'false',
          'aria-label': r[2],
          onClick: function () { pick(r[0]); }
        },
          h('span', { className: 'rxbtn__e', 'aria-hidden': 'true' }, r[1]),
          h('span', { className: 'rxbtn__t' }, r[2]),
          counts[r[0]] ? h('span', { className: 'rxbtn__n' }, counts[r[0]]) : null);
      })),
    /* the one-per-reader limit is enforced, not announced; the row ends on
       a share for the article itself */
    h('div', { className: 'rx__share' },
      h(ShareLinkButton, { link: String(window.location.href).split('#')[0] + '#' + id, title: props.title, label: 'Share article' }))
  );
}

function ArticlePage(props) {
  var a = props.article, go = props.go;
  var m = useState('read'), mode = m[0], setMode = m[1];
  /* The deck is held by the app, not here. The hash carries it, so a shared
     #<id>/tldr link — or the back button landing on one — has to open it
     without this component having to remount. */
  var deck = !!props.deck, setDeck = props.setDeck;
  var blocks = useMemo(function () { return articleBlocks(a.md, a.id); }, [a.id]);

  useEffect(function () { setMode('read'); }, [a.id]);

  /* TLDR opens the deck over the article; the tab underneath stays on Read,
     so closing the deck puts the reader back exactly where they were. */
  function pickMode(k) {
    if (k === 'tldr') { setDeck(true); return; }
    setMode(k);
  }

  /* same icon per mode as the TLDR / Listen buttons on the list cards */
  /* Each way in carries its own duration, so the capsule is the one place
     that answers "how long will this take me". The meta line beside it keeps
     only the date — the times used to be repeated in both. */
  var audioMin = audioMinutes(a);
  var modes = [
    ['read', 'Read', 'text', a.readMin],
    ['tldr', 'TLDR', 'bolt', tldrMinutes(a)],
    ['listen', 'Listen', 'headphones', audioMin]
  ];

  /* The capsule floats at the base of the viewport in every mode. The deck
     carries its own copy, so this one steps aside while the deck is open. */
  var capsule = h('div', { className: 'modes modes--timed', role: 'tablist', 'aria-label': 'How to take this in' },
    modes.map(function (mm) {
      var on = mm[0] === 'tldr' ? deck : mode === mm[0];
      return h('button', {
        key: mm[0], className: cx('mode', on && 'is-on'), role: 'tab',
        'aria-selected': on ? 'true' : 'false',
        'aria-label': mm[1] + ' — ' + mm[3] + ' min',
        onClick: function () { pickMode(mm[0]); }
      },
        h(Icon, { name: mm[2], size: 14 }),
        h('span', { className: 'mode__t' }, mm[1]),
        h('span', { className: 'mode__d' }, mm[3] + ' min'));
    }));

  /* The strip above the content: which mode this is, the title, and an X.
     In Read the X is the way back to all articles (it replaces the old back
     link); in Listen it returns to Read, the way the deck's X does. */
  var listening = mode === 'listen';
  var strip = h('div', { className: 'modebar' },
    h('div', { className: 'modebar__crumb' },
      h('span', { className: 'modebar__mode' }, listening ? 'Listen' : 'Read'),
      h('span', { className: 'modebar__sep', 'aria-hidden': 'true' }),
      h('span', { className: 'modebar__title' }, a.title)),
    h('button', {
      className: 'modebar__x', type: 'button',
      'aria-label': listening ? 'Close the player' : 'Back to all articles',
      onClick: function () { if (listening) setMode('read'); else go('home'); }
    }, h(Icon, { name: 'close', size: 14 })));

  return h('main', { className: 'modeframe' },
    h('div', { className: 'artwrap' },
      strip,

      /* Listen: the title and the player, nothing else on screen. Read comes
         back with the capsule or the X. */
      listening ? h('section', { className: 'listenview', 'aria-label': 'Listen to this article' },
        h('span', { className: 'tag' }, a.tag),
        h('h1', null, a.title),
        h(AudioPanel, { key: a.id + '-audio', duration: a.audioSec })
      ) : null,

      /* Read: tag and author/date across the top, then title, dek, body */
      !listening ? h('header', { className: 'readhead' },
        h('div', { className: 'readhead__top' },
          h('div', { className: 'arthead__tags', style: { margin: 0 } },
            h('span', { className: 'tag' }, a.tag),
            a.draft ? h('span', { className: 'tag tag--draft' }, 'Draft — in progress') : null),
          h('div', { className: 'readhead__by' },
            h('b', null, a.author),
            h('i', { 'aria-hidden': 'true' }),
            h('span', null, fmtDate(a.date)))),
        h(SplitHeadline, { key: a.id, text: a.title }),
        h(Dek, { key: a.id + '-dek', className: 'dek', delay: dekDelay(a.title) }, a.excerpt),
        h('div', { className: 'readhead__rule', 'aria-hidden': 'true' })
      ) : null,

      /* TL;DR is no longer an in-page section — it takes over the viewport */
      deck ? h(TldrDeck, {
        key: a.id + '-deck', slides: tldrSlides(a), title: a.title, tag: a.tag,
        meta: fmtDate(a.date) + ' · ' + a.readMin + ' min read',
        shareLink: String(window.location.href).split('#')[0] + '#' + a.id + '/tldr',
        times: { read: readMinutes(a), tldr: tldrMinutes(a), audio: audioMinutes(a) },
        onClose: function () { setDeck(false); },
        onRead: function () { setDeck(false); setMode('read'); },
        onListen: function () { setDeck(false); setMode('listen'); }
      }) : null,

      !listening ? h('div', { className: 'readbody' },
        h(AnnotationLayer, { variant: 'column' },
          blocks.map(function (b, i) {
            return b.t === 'fig'
              ? h(FIGURES[b.id], { key: 'f' + i })
              : h(ArticleProse, { key: 'm' + i, html: b.html });
          })),
        h(Reactions, { id: a.id, title: a.title }),
        h('div', { className: 'artfoot' },
          a.draft
            ? h('p', null, 'This piece is still being written. It is published here in draft so the team can read along.')
            : null,
          props.next
            ? h('p', { style: { margin: 0 } },
                h('a', { href: '#', onClick: function (e) { e.preventDefault(); go(props.next.id); } },
                  'Next: ' + props.next.title + ' →'))
            : null
        )
      ) : null
    ),
    deck ? null : h('div', { className: 'modedock' }, capsule)
  );
}
/* ============================================================
   App
   ============================================================ */

/* ============================================================
   Summary overlay — TLDR / Listen straight from a list page
   Full screen, X to dismiss, and the page is exactly where the
   reader left it when it closes.
   ============================================================ */
function SummaryOverlay(props) {
  var p = props.post, mode = props.mode;

  /* Locking the page can clamp its scroll, so the offset is recorded on open
     and put back on close — the reader lands exactly where they left off. */
  useEffect(function () {
    function onKey(e) { if (e.key === 'Escape') props.onClose(); }
    document.addEventListener('keydown', onKey);
    var at = window.pageYOffset || document.documentElement.scrollTop || 0;
    var prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return function () {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      window.requestAnimationFrame(function () {
        var now = window.pageYOffset || document.documentElement.scrollTop || 0;
        if (Math.abs(now - at) > 2) {
          try { window.scrollTo({ top: at, behavior: 'auto' }); } catch (e) { window.scrollTo(0, at); }
        }
      });
    };
  }, []);

  /* Sits under the site header, like the deck, so the frame reads the same
     whether Listen was opened from a card or from inside the article. */
  var ht = useState(0), headTop = ht[0], setHeadTop = ht[1];
  useLayoutEffect(function () {
    function measure() {
      var el = document.querySelector('.sitehead');
      setHeadTop(el ? Math.max(0, Math.round(el.getBoundingClientRect().bottom)) : 0);
    }
    measure();
    window.addEventListener('resize', measure);
    return function () { window.removeEventListener('resize', measure); };
  }, []);

  /* The same three-way capsule as the article page. Read opens the article;
     TLDR hands over to the deck; Listen is where we are. */
  var times = { read: readMinutes(p), tldr: tldrMinutes(p), audio: audioMinutes(p) };
  var modes = [
    ['read', 'Read', 'text', times.read, props.onOpen],
    ['tldr', 'TLDR', 'bolt', times.tldr, function () { props.onMode('tldr'); }],
    ['listen', 'Listen', 'headphones', times.audio, null]
  ];
  var label = mode === 'listen' ? 'Listen' : 'TL;DR';

  return h('div', { className: 'sheetfull', role: 'dialog', 'aria-modal': 'true', 'aria-label': p.title,
                    style: { top: headTop + 'px' } },
    h('div', { className: 'sheetfull__scrim' }),
    h('div', { className: 'sheetfull__panel' },
      h('div', { className: 'modebar' },
        h('div', { className: 'modebar__crumb' },
          h('span', { className: 'modebar__mode' }, label),
          h('span', { className: 'modebar__sep', 'aria-hidden': 'true' }),
          h('span', { className: 'modebar__title' }, p.title)),
        h('button', { className: 'modebar__x', type: 'button', onClick: props.onClose, 'aria-label': 'Close' },
          h(Icon, { name: 'close', size: 14 }))),
      h('section', { className: 'listenview', 'aria-label': 'Listen to this article' },
        h('span', { className: 'tag' }, p.tag),
        h('h1', null, p.title),
        mode === 'listen'
          ? h(AudioPanel, { key: p.id + '-a', duration: p.audioSec })
          : h(TldrPanel, { key: p.id + '-t', slides: p.tldr })
      ),
      h('div', { className: 'modedock' },
        h('div', { className: 'modes modes--timed', role: 'tablist', 'aria-label': 'How to take this in' },
          modes.map(function (mm) {
            var on = mode === mm[0];
            return h('button', {
              key: mm[0], className: cx('mode', on && 'is-on'), role: 'tab',
              'aria-selected': on ? 'true' : 'false',
              'aria-label': mm[1] + ' \u2014 ' + mm[3] + ' min',
              onClick: function () { if (mm[4]) mm[4](); }
            }, h(Icon, { name: mm[2], size: 14 }), h('span', { className: 'mode__t' }, mm[1]),
               h('span', { className: 'mode__d' }, mm[3] + ' min'));
          })))
    )
  );
}

/* ============================================================
   Featured — one rotating slot instead of three stacked cards
   ============================================================ */
var ROTATE_MS = 6500;

function FeaturedRotator(props) {
  var hits = props.hits;
  var i = useState(0), idx = i[0], setIdx = i[1];
  var p = useState(false), paused = p[0], setPaused = p[1];

  useEffect(function () {
    if (paused || hits.length < 2 || prefersReducedMotion()) return;
    var t = window.setTimeout(function () {
      setIdx(function (n) { return (n + 1) % hits.length; });
    }, ROTATE_MS);
    return function () { window.clearTimeout(t); };
  }, [idx, paused, hits.length]);

  if (!hits.length) return null;
  var active = hits[idx];

  return h('div', {
    className: 'rotator',
    onMouseEnter: function () { setPaused(true); },
    onMouseLeave: function () { setPaused(false); },
    onFocus: function () { setPaused(true); },
    onBlur: function () { setPaused(false); }
  },
    h('div', { className: 'rotator__slot', 'aria-live': 'polite' },
      h(PostCard, { key: active.id, post: active, go: props.go, variant: 'hit', onSummary: props.onSummary })),
    hits.length > 1
      ? h('div', { className: 'rotator__dots', role: 'tablist', 'aria-label': 'Featured articles' },
          hits.map(function (hit, n) {
            return h('button', {
              key: hit.id, className: cx('rdot', n === idx && 'is-on'), role: 'tab',
              'aria-selected': n === idx ? 'true' : 'false',
              'aria-label': hit.title,
              onClick: function () { setIdx(n); }
            });
          }))
      : null
  );
}

/* ============================================================
   Small helpers used by the shell
   ============================================================ */
/* up to two initials from whatever name the author field carries */
function initialsOf(name) {
  var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '·';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function nextArticle(a) {
  var i = POSTS.indexOf(a);
  if (i === -1) return null;
  return POSTS[(i + 1) % POSTS.length];
}

function scrollToNewsletter() {
  var el = document.getElementById('newsletter');
  if (!el) return;
  el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
  var input = el.querySelector('input[type="email"]');
  if (input) window.setTimeout(function () { try { input.focus({ preventScroll: true }); } catch (e) {} }, 500);
}

var BRAND_SUFFIX = ' \u2014 ' + BRAND;
function titleFor(route) {
  if (route === 'home') return BRAND;
  if (route === 'about') return 'About' + BRAND_SUFFIX;
  if (route === 'archive') return 'Archive' + BRAND_SUFFIX;
  var a = articleById(route);
  return a ? a.title + BRAND_SUFFIX : BRAND;
}

/* a deep-linked sentence id is prefixed with its article id */
function routeForHl(hl) {
  for (var i = 0; i < POSTS.length; i++) {
    if (hl.indexOf(POSTS[i].id + '-') === 0) return POSTS[i].id;
  }
  return null;
}

/* The hash is the address: #<article-id>, #about, #archive, or #hl=<sentence>.
   Anything else (#newsletter, #topics) is an in-page anchor, so the route is
   left where it is. */
function parseHash() {
  var raw;
  try { raw = String(window.location.hash || '').replace(/^#/, ''); } catch (e) { return null; }
  if (!raw) return { route: 'home', hl: null };
  var m = /^hl=([\w-]+)$/.exec(raw);
  if (m) {
    var rt = routeForHl(m[1]);
    return rt ? { route: rt, hl: m[1] } : null;
  }
  if (raw === 'home' || raw === 'about' || raw === 'archive') return { route: raw, hl: null, tldr: false };
  /* #<article-id>/tldr drops the recipient straight into the summary */
  var t = /^([\w-]+)\/tldr$/.exec(raw);
  if (t && articleById(t[1])) return { route: t[1], hl: null, tldr: true };
  if (articleById(raw)) return { route: raw, hl: null, tldr: false };
  return null;
}

/* ------------------------------------------------------------------
   Boot: "> start of log0" types in at the top of every page, and the
   page's blocks then print in one after another, top to bottom.
   ------------------------------------------------------------------ */
var BOOT_TYPE_MS = 45;      /* per character of the boot line */
var BOOT_LINE_MS = 70;      /* gap between one block landing and the next */
var BOOT_HOLD_MS = 420;     /* how long the typed line has the screen to itself */

/* The strip is a one-line terminal pinned above the header. The first
   thing it ever prints is "> start of log0"; after that every move to a
   new page is typed as a command before the page itself prints. */
var bootFirst = true;
function bootCommand(route) {
  if (bootFirst) return '> start of ' + BRAND;
  if (route === 'home') return '> cd ~';
  if (route === 'archive') return '> ls archive';
  if (route === 'about') return '> cat about';
  return '> open ' + route;
}

function Boot(props) {
  var ref = useRef(null);
  useEffect(function () {
    var el = ref.current;
    if (!el) return;
    var line = bootCommand(props.route);
    bootFirst = false;
    if (prefersReducedMotion()) { el.textContent = line; return; }
    /* a new command replaces the old one from the prompt onward */
    el.textContent = '>';
    var i = 1;
    var t = window.setInterval(function () {
      el.textContent = line.slice(0, ++i);
      if (i >= line.length) window.clearInterval(t);
    }, BOOT_TYPE_MS);
    return function () { window.clearInterval(t); };
  }, [props.route]);
  return h('div', { className: 'boot', 'aria-hidden': 'true' },
    h('div', { className: 'boot__in' },
      h('span', { ref: ref }), h('span', { className: 'boot__us' }, '_')));
}

/* Every block on the page, in document order, gets a staggered delay. The
   candidates include containers and their children; only the innermost of
   each nesting prints on its own, so a paragraph is a line but the column
   that holds it is not. The classes come off again once the run is over,
   so nothing stays bound to the animation. */
function usePrintIn(route) {
  useLayoutEffect(function () {
    if (prefersReducedMotion()) return;
    var root = document.getElementById('root');
    if (!root) return;
    var sel = '.sitehead, main .home-sec > *, main .col > .pagehead, main .col > .archfilter, main .col > section > *, ' +
              'main .col > .aboutbody, .artwrap > *, .readhead, .listenview, .readbody > *, .prose > *, .rx, .artfoot, .modedock, .site-footer';
    var all = Array.prototype.slice.call(root.querySelectorAll(sel));
    var leaves = all.filter(function (el) {
      return !all.some(function (other) { return other !== el && el.contains(other); });
    });
    /* a short beat, then the page prints top to bottom */
    var lead = 160;
    leaves.forEach(function (el, i) {
      el.classList.add('ln');
      el.style.animationDelay = (lead + i * BOOT_LINE_MS) + 'ms';
    });
    var total = lead + leaves.length * BOOT_LINE_MS + 200;
    var t = window.setTimeout(function () {
      leaves.forEach(function (el) { el.classList.remove('ln'); el.style.animationDelay = ''; });
    }, total);
    return function () {
      window.clearTimeout(t);
      leaves.forEach(function (el) { el.classList.remove('ln'); el.style.animationDelay = ''; });
    };
  }, [route]);
}

function App() {
  var initialHl = useRef(null);
  var initialTldr = useRef(false);
  var r = useState(function () {
    var p = parseHash();
    if (!p) return 'home';
    initialHl.current = p.hl;
    initialTldr.current = !!p.tldr;
    return p.route;
  }), route = r[0], setRoute = r[1];
  /* true while the article's TLDR deck is open; the hash carries it, so the
     view can be linked to and the back button can open or close it */
  var dk = useState(function () { return initialTldr.current; }), deckOn = dk[0], setDeckOn = dk[1];
  var t = useState(function () {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }), theme = t[0], setTheme = t[1];
  var so = useState(false), searchOpen = so[0], setSearchOpen = so[1];
  var q = useState(''), query = q[0], setQuery = q[1];
  var sm = useState(null), summary = sm[0], setSummary = sm[1];
  /* which topic the archive is filtered to, held here so a footer pill can
     navigate and filter in one move */
  var tp = useState(null), topic = tp[0], setTopic = tp[1];

  useEffect(function () { document.documentElement.setAttribute('data-theme', theme); }, [theme]);

  /* Any move off the archive drops the filter, so coming back — by nav, by
     hash, or by the back button — starts from everything. */
  useEffect(function () { if (route !== 'archive') setTopic(null); }, [route]);

  /* the address bar follows the route, so any page here can be linked to */
  var writing = useRef(false);
  useEffect(function () {
    document.title = titleFor(route);
    if (initialHl.current && routeForHl(initialHl.current) !== route) initialHl.current = null;
    try {
      /* an open deck is part of the address, so a shared link reopens it */
      var want = route === 'home' ? '' : '#' + route + (deckOn && articleById(route) ? '/tldr' : '');
      var have = String(window.location.hash || '');
      if (!(initialHl.current && /^#hl=/.test(have)) && have !== want) {
        writing.current = true;
        window.history.replaceState(null, '', want || String(window.location.href).split('#')[0]);
        window.setTimeout(function () { writing.current = false; }, 0);
      }
    } catch (e) {}
  }, [route, deckOn]);

  /* a new page starts at the top; opening the deck must not move the page
     underneath, which is why this is separate from the address effect */
  useEffect(function () { window.scrollTo(0, 0); }, [route]);

  /* back/forward, and a pasted link, both arrive as a hash change */
  useEffect(function () {
    function onHash() {
      if (writing.current) return;
      var p = parseHash();
      if (!p) return;
      initialHl.current = p.hl;
      setRoute(p.route);
      setDeckOn(!!p.tldr);
    }
    window.addEventListener('hashchange', onHash);
    return function () { window.removeEventListener('hashchange', onHash); };
  }, []);

  function go(next, anchor, keepSearch) {
    if (next === 'subscribe') { scrollToNewsletter(); return; }
    if (!keepSearch) { setSearchOpen(false); setQuery(''); }
    setSummary(null);
    setDeckOn(false);
    initialTldr.current = false;
    setRoute(next);
  }

  /* a topic pill in the footer opens the archive already filtered */
  function goTopic(tag) {
    setSearchOpen(false); setQuery(''); setSummary(null);
    setTopic(tag); setRoute('archive');
    /* already on the archive the route effect won't fire, so take the reader
       back to the filter row itself */
    try { window.scrollTo(0, 0); } catch (e) {}
  }

  /* open the TLDR / audio overlay from any list page */
  function openSummary(post, mode) { setSummary({ post: post, mode: mode }); }

  /* a topic pill is just a pre-filled search, so the bar opens with it and
     the reader can see the filter and clear it */
  function pickTopic(tag) { setQuery(tag); setSearchOpen(true); }

  var art = articleById(route);
  var page;
  if (art) {
    page = h(HLProvider, { key: art.id, initial: initialHl.current },
      h(ArticlePage, {
        article: art, go: go, next: nextArticle(art),
        deck: deckOn, setDeck: setDeckOn
      }));
  } else if (route === 'about') page = h(About, null);
  else if (route === 'archive') page = h(Archive, { go: go, onSummary: openSummary, topic: topic, setTopic: setTopic });
  else page = h(Home, { go: go, query: query, setQuery: pickTopic, onSummary: openSummary });

  usePrintIn(route);

  return h(React.Fragment, null,
    h(Masthead, {
      route: route, go: go, theme: theme,
      toggleTheme: function () { setTheme(theme === 'dark' ? 'light' : 'dark'); },
      searchOpen: searchOpen, setSearchOpen: setSearchOpen, query: query, setQuery: setQuery
    }),
    page,
    h(Footer, { go: go, goTopic: goTopic }),
    /* TLDR from a list card goes straight into the deck; Listen keeps the
       compact sheet, since a player has nothing to page through */
    summary && summary.mode === 'tldr' ? h(TldrDeck, {
      key: summary.post.id + '-deck', slides: tldrSlides(summary.post),
      title: summary.post.title, tag: summary.post.tag,
      meta: fmtDate(summary.post.date) + ' · ' + summary.post.readMin + ' min read',
      shareLink: String(window.location.href).split('#')[0] + '#' + summary.post.id + '/tldr',
      times: { read: readMinutes(summary.post), tldr: tldrMinutes(summary.post),
               audio: audioMinutes(summary.post) },
      onClose: function () { setSummary(null); },
      onRead: function () { var p = summary.post; setSummary(null); setRoute(p.id); },
      onListen: function () { setSummary({ post: summary.post, mode: 'listen' }); }
    }) : null,
    summary && summary.mode !== 'tldr' ? h(SummaryOverlay, {
      post: summary.post, mode: summary.mode,
      onMode: function (mm) { setSummary({ post: summary.post, mode: mm }); },
      onClose: function () { setSummary(null); },
      onOpen: function () { var p = summary.post; setSummary(null); setRoute(p.id); }
    }) : null
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(h(App, null));
