import type { SVGProps } from "react";

/** A few stroke icons, drawn on a 16px grid. Decorative unless given a title. */
function Icon({ children, title, ...props }: SVGProps<SVGSVGElement> & { title?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      width="16"
      height="16"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

type P = SVGProps<SVGSVGElement> & { title?: string };

export const LockIcon = (p: P) => (
  <Icon {...p}>
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </Icon>
);
export const SearchIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.25 10.25 3.25 3.25" />
  </Icon>
);
export const FileIcon = (p: P) => (
  <Icon {...p}>
    <path d="M4 1.75h5l3 3v9.5H4z" />
    <path d="M9 1.75v3h3" />
  </Icon>
);
export const FolderIcon = (p: P) => (
  <Icon {...p}>
    <path d="M1.75 4.25v8.5h12.5v-7H8L6.5 4.25z" />
  </Icon>
);
export const ServerIcon = (p: P) => (
  <Icon {...p}>
    <rect x="2" y="2.5" width="12" height="4.5" rx="1" />
    <rect x="2" y="9" width="12" height="4.5" rx="1" />
    <path d="M4.5 4.75h.01M4.5 11.25h.01" />
  </Icon>
);
export const CloseIcon = (p: P) => (
  <Icon {...p}>
    <path d="m4.5 4.5 7 7m0-7-7 7" />
  </Icon>
);
export const CopyIcon = (p: P) => (
  <Icon {...p}>
    <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" />
    <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
  </Icon>
);
export const CheckIcon = (p: P) => (
  <Icon {...p}>
    <path d="m3.25 8.5 3 3 6.5-7" />
  </Icon>
);
export const ClockIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 4.75V8l2.25 1.5" />
  </Icon>
);
export const WarningIcon = (p: P) => (
  <Icon {...p}>
    <path d="M8 2.25 14.25 13H1.75z" />
    <path d="M8 6.5v3M8 11.25h.01" />
  </Icon>
);
export const ErrorIcon = (p: P) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 5v3.5M8 10.75h.01" />
  </Icon>
);
export const MenuIcon = (p: P) => (
  <Icon {...p}>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
  </Icon>
);
export const UndoIcon = (p: P) => (
  <Icon {...p}>
    <path d="M5.5 3 2.5 6l3 3" />
    <path d="M2.5 6h7a4 4 0 0 1 0 8H7" />
  </Icon>
);
export const ShieldIcon = (p: P) => (
  <Icon {...p}>
    <path d="M8 1.75 13.25 3.5v4.25c0 3.25-2.25 5.5-5.25 6.5-3-1-5.25-3.25-5.25-6.5V3.5z" />
    <path d="m5.75 8 1.5 1.5 3-3" />
  </Icon>
);
export const ArrowRightIcon = (p: P) => (
  <Icon {...p}>
    <path d="M2.5 8h11M9.5 4l4 4-4 4" />
  </Icon>
);
