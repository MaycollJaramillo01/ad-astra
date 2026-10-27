import type { ReactNode } from 'react';

const shapes = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  trend: (
    <>
      <path d="M4 19V5M4 19h17M8 14l4-5 4 3 5-7" />
    </>
  ),
  forecast: (
    <>
      <path d="M3 17l5-6 4 3 4-7M16 7h5v5" />
      <path d="M16 17h5M19 15v4" />
    </>
  ),
  action: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="M9 12l2 2 4-5" />
    </>
  ),
  monitor: (
    <>
      <path d="M2 12h5l3-7 4 14 3-7h5" />
    </>
  ),
  clients: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20v-2a6 6 0 0112 0v2M16 5a3 3 0 010 6M18 14a5 5 0 013 4v2" />
    </>
  ),
  accounts: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="M3 10h18M7 15h4" />
    </>
  ),
  connect: (
    <>
      <path d="M9 14l6-4M9 10l6 4" />
      <circle cx="5" cy="7" r="3" />
      <circle cx="19" cy="7" r="3" />
      <circle cx="5" cy="17" r="3" />
      <circle cx="19" cy="17" r="3" />
    </>
  ),
  assistant: (
    <>
      <path d="M12 3l2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3z" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M16 16l5 5" />
    </>
  ),
  arrow: <path d="M5 12h14m-6-6l6 6-6 6" />,
  chevron: <path d="M9 5l7 7-7 7" />,
  down: <path d="M6 9l6 6 6-6" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  logout: (
    <>
      <path d="M10 4H5v16h5M10 12h11m-4-4l4 4-4 4" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3z" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10" width="14" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 018 0v3M12 14v3" />
    </>
  ),
  check: <path d="M5 12l4 4L19 6" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="3" />
      <path d="M7 3v4M17 3v4M3 11h18M7 15h3M14 15h3" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.5 9a2.5 2.5 0 115 0c0 2-2.5 2-2.5 4M12 17h.01" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 4.2L2.5 18a2 2 0 001.7 3h15.6a2 2 0 001.7-3L13.7 4.2a2 2 0 00-3.4 0zM12 9v4M12 17h.01" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
} satisfies Record<string, ReactNode>;
export type IconName = keyof typeof shapes;
export function Icon({
  name,
  size = 20,
  className = '',
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {shapes[name]}
    </svg>
  );
}
export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 32 32" className={className} fill="none">
      <path d="M16 3L29 26H20L16 18L12 26H3L16 3Z" fill="currentColor" />
      <path d="M13.3 12.5L16 7.7L18.7 12.5H13.3Z" fill="var(--brand-cutout,#2c2330)" />
    </svg>
  );
}
