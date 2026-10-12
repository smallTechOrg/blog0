// Icon set, paths verbatim from spec/design/design-app.js `Icon`.
import type { ReactElement } from 'react';

export type IconName =
  | 'search'
  | 'sun'
  | 'moon'
  | 'close'
  | 'copy'
  | 'check'
  | 'x'
  | 'rss'
  | 'mail'
  | 'note'
  | 'notion'
  | 'chat'
  | 'heart'
  | 'heart-on'
  | 'share'
  | 'linkedin'
  | 'bolt'
  | 'text'
  | 'headphones';

const PATHS: Record<IconName, ReactElement> = {
  search: (
    <>
      <circle cx={11} cy={11} r={7} />
      <path d="M20 20l-3.6-3.6" />
    </>
  ),
  sun: (
    <>
      <circle cx={12} cy={12} r={4.2} />
      <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
    </>
  ),
  moon: <path d="M20 14.2A8.2 8.2 0 1 1 9.8 4a6.6 6.6 0 0 0 10.2 10.2z" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  copy: (
    <>
      <rect x={9} y={9} width={11} height={11} rx={2} />
      <path d="M5 15V6a2 2 0 0 1 2-2h8" />
    </>
  ),
  check: <path d="M4.5 12.5l5 5 10-11" />,
  x: <path d="M4 4l16 16M20 4L4 20" />,
  rss: <path d="M5 19a1 1 0 1 0 0-2 1 1 0 0 0 0 2M5 12a7 7 0 0 1 7 7M5 5a14 14 0 0 1 14 14" />,
  mail: (
    <>
      <rect x={3} y={5} width={18} height={14} rx={2} />
      <path d="M3.5 6.5l8.5 6 8.5-6" />
    </>
  ),
  note: (
    <>
      <rect x={5} y={3} width={14} height={18} rx={2} />
      <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
    </>
  ),
  notion: (
    <>
      <rect x={4} y={4} width={16} height={16} rx={2.5} />
      <path d="M9 16V8l6 8V8" />
    </>
  ),
  chat: <path d="M20 12a8 8 0 0 1-11.8 7L4 20l1.1-4A8 8 0 1 1 20 12z" />,
  heart: <path d="M12 20s-7.2-4.5-7.2-9.3A4.2 4.2 0 0 1 12 8.2a4.2 4.2 0 0 1 7.2 2.5C19.2 15.5 12 20 12 20z" />,
  'heart-on': (
    <path
      fill="currentColor"
      stroke="none"
      d="M12 20s-7.2-4.5-7.2-9.3A4.2 4.2 0 0 1 12 8.2a4.2 4.2 0 0 1 7.2 2.5C19.2 15.5 12 20 12 20z"
    />
  ),
  share: <path d="M12 15V4M8.5 7.2L12 3.7l3.5 3.5M5 13.5V19a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19v-5.5" />,
  linkedin: (
    <>
      <rect x={3.5} y={3.5} width={17} height={17} rx={2.5} />
      <path d="M8 10.5V16M8 7.8v.01M11.5 16v-3.2a2.2 2.2 0 0 1 4.4 0V16M11.5 10.5V16" />
    </>
  ),
  bolt: <path d="M13 3 5.5 13.5H11l-1 7.5L18.5 10H13z" />,
  text: <path d="M4.5 6.5h15M4.5 11h15M4.5 15.5h10" />,
  headphones: (
    <>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x={2.5} y={13.5} width={4.5} height={7} rx={2} />
      <rect x={17} y={13.5} width={4.5} height={7} rx={2} />
    </>
  ),
};

export interface IconProps {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 17 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
