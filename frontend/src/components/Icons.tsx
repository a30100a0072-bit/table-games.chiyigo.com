// Curated inline SVG icons. We don't pull in lucide-react (would add a
// new dep + tree-shake risk for ~5 icons we actually need); these are
// hand-rolled approximations, sized via the className `w-4 h-4` etc.
//
// All icons inherit `currentColor` so any text-* utility colours them.

import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Base({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function Lock(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Base>
  );
}

export function RefreshCw(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <polyline points="21 4 21 10 15 10" />
    </Base>
  );
}

export function Share2(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="18" cy="5"  r="3" />
      <circle cx="6"  cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.6"  y1="13.5" x2="15.4" y2="17.5" />
      <line x1="15.4" y1="6.5"  x2="8.6"  y2="10.5" />
    </Base>
  );
}
