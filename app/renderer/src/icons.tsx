/** Stroke icons on a 16 px grid, plus the status glyphs: each state is a shape. */
import type { Session } from "./api";

const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export const Sheet = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 18 18" aria-hidden="true" {...stroke}>
    <path d="M4 2.5h7l3 3v10H4z" />
    <path d="M11 2.5v3h3" />
    <path d="M6.5 9h5M6.5 12h3.5" stroke="var(--ink-3)" />
  </svg>
);

export const Mic = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
    <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
    <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
  </svg>
);

export const Gear = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
    <circle cx="8" cy="8" r="2.25" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </svg>
);

export const BellOff = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
    <path d="M4 11.5V7a4 4 0 0 1 6.9-2.8M12 7v4.5H4M6.5 13.5h3M2.5 2.5l11 11" />
  </svg>
);

export const Bell = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
    <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5H4zM6.5 13.5h3" />
  </svg>
);

export const Expand = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
  </svg>
);

export const Folder = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
    <path d="M2 4.5h4l1.5 1.5H14v7H2z" />
  </svg>
);

export const Next = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
    <path d="M3 8h9M9 4.5 12.5 8 9 11.5" />
  </svg>
);

export const Cross = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" {...stroke}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

/** The glyph for a session's state. Never colour alone. */
export function StatusMark({ s }: { s: Session }) {
  const red = s.verified?.verdict === "red" || s.status === "error" || Boolean(s.held) || s.evidence.testsFailed > 0;
  if (s.status === "blocked" || (s.attention.tier === 0 && !red)) {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
        <circle cx="10" cy="10" r="5" fill="var(--accent)" />
      </svg>
    );
  }
  if (s.attention.tier === 0 && red) {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="var(--failed)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
        <path d="M10 4l6.5 11.5h-13z" />
        <path d="M10 9v3" />
        <circle cx="10" cy="13.6" r="0.9" fill="var(--failed)" stroke="none" />
      </svg>
    );
  }
  if (s.status === "working" || s.status === "checking" || s.status === "starting") {
    return (
      <svg className="pulse" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="var(--ink-2)" strokeWidth="1.5" strokeLinecap="round">
        <path d="M15.5 10a5.5 5.5 0 1 1-5.5-5.5" />
      </svg>
    );
  }
  if (s.status === "done") {
    return (
      <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="var(--ink-2)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="6.25" />
        <path d="M7.4 10.2l1.8 1.8 3.4-3.6" />
      </svg>
    );
  }
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="var(--ink-3)" strokeWidth="1.5">
      <circle cx="10" cy="10" r="5.25" />
    </svg>
  );
}
