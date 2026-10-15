/**
 * The orbit: you at the centre, every task a planet, urgency as distance.
 *
 *   inner ring   your move (asking, red, held, ready)
 *   middle ring  working (an arc shows how long it has been running)
 *   outer ring   done and quiet
 *
 * Positions are stable: every task has its own angle, in id order, so
 * when its state changes it moves straight in or out along its own ray
 * and never lands on another task. The top of the dial is left clear for
 * the ring names.
 */
import { ago, type Session } from "./api";

const SIZE = 400;
const C = SIZE / 2;
const RINGS = [70, 116, 162]; // your move, working, done

export function ringOf(s: Session): 0 | 1 | 2 {
  if (s.attention.tier <= 1) return 0;
  if (s.attention.tier === 2) return 1;
  return 2;
}

function glyph(s: Session) {
  if (s.agent === "codex" || /codex/i.test(s.agentLabel)) return "X";
  if (/claude/i.test(s.agentLabel)) return "C";
  return (s.agentLabel.trim()[0] ?? "?").toUpperCase();
}

/** Degrees either side of twelve o'clock kept free for the ring names. */
const TOP_GAP = 40;

/** One angle per task, in id order, spread over the dial below the names. */
function angles(items: Session[]): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
  const step = (360 - 2 * TOP_GAP) / Math.max(1, sorted.length);
  return new Map(sorted.map((s, i) => [s.id, ((-90 + TOP_GAP + (i + 0.5) * step) * Math.PI) / 180]));
}

function isRed(s: Session) {
  return s.verified?.verdict === "red" || s.status === "error" || Boolean(s.held) || s.evidence.testsFailed > 0;
}

function Planet({ s, x, y, angle, selected, onSelect }: { s: Session; x: number; y: number; angle: number; selected: boolean; onSelect: () => void }) {
  const ring = ringOf(s);
  const r = ring === 0 ? 22 : ring === 1 ? 18 : 14;
  const red = isRed(s);
  const asking = s.status === "blocked" || (ring === 0 && !red);
  const minutes = s.turnStartedAt ? (Date.now() - Date.parse(s.turnStartedAt)) / 60_000 : 0;
  const circumference = 2 * Math.PI * r;
  const run = Math.min(1, minutes / 30) * circumference; // a full ring at 30 minutes
  const label = s.name.length > 18 ? `${s.name.slice(0, 17)}…` : s.name;
  // Labels sit on the side away from the centre: above a planet in the top
  // half, below one elsewhere, so they never run under the core.
  const above = Math.sin(angle) < -0.2;
  const labelY = above ? y - r - (ring === 1 ? 20 : 7) : y + r + 15;
  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${s.name}, ${s.agentLabel}: ${s.attention.reason}`}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
      style={{ cursor: "pointer", outline: "none" }}
      className="planet"
    >
      {selected && <circle cx={x} cy={y} r={r + 7} fill="none" stroke="var(--accent)" strokeOpacity="0.5" strokeWidth="2" />}
      {asking && <circle cx={x} cy={y} r={r + 4} fill="none" stroke="var(--accent)" strokeOpacity="0.3" strokeWidth="2" className="halo" />}
      <circle cx={x} cy={y} r={r} fill={asking ? "var(--accent)" : "var(--raised)"} stroke={red ? "var(--failed)" : asking ? "none" : "var(--line)"} strokeWidth="2" />
      {ring === 1 && (
        <circle
          cx={x}
          cy={y}
          r={r}
          fill="none"
          stroke="var(--ink-2)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={`${Math.max(4, run)} ${circumference}`}
          transform={`rotate(-90 ${x} ${y})`}
          className="pulse"
        />
      )}
      {red ? (
        <path d={`M${x} ${y - 8}l8 13h-16z`} fill="var(--failed)" />
      ) : ring === 2 && s.status === "done" ? (
        <path d={`M${x - 6} ${y}l4 4 7-8`} fill="none" stroke={s.verified?.verdict === "green" ? "var(--pass)" : "var(--ink-2)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <text x={x} y={y + 5} textAnchor="middle" fontSize={ring === 0 ? 14 : 12} fontWeight="600" fill={asking ? "var(--on-accent)" : "var(--ink-2)"}>
          {glyph(s)}
        </text>
      )}
      <text x={x} y={labelY} textAnchor="middle" fontSize="11" fill={ring === 0 ? "var(--ink)" : "var(--ink-3)"}>
        {label}
      </text>
      {ring === 1 && (
        <text x={x} y={labelY + 13} textAnchor="middle" fontSize="10" fontFamily="var(--mono)" fill="var(--ink-3)">
          {ago(s.turnStartedAt)}
          {s.queue.length ? ` · ${s.queue.length}⏭` : ""}
        </text>
      )}
    </g>
  );
}

export function Orbit({ sessions, selected, onSelect, needs }: { sessions: Session[]; selected: string | null; onSelect: (id: string) => void; needs: number }) {
  const at = angles(sessions);
  return (
    <svg className="orbit" viewBox={`0 0 ${SIZE} ${SIZE}`} width="100%" role="group" aria-label="Your agents, closest are the ones that need you">
      <defs>
        <radialGradient id="foolscap-core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity={needs ? 0.22 : 0.06} />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx={C} cy={C} r={RINGS[2]} fill="none" stroke="var(--line)" />
      <circle cx={C} cy={C} r={RINGS[1]} fill="none" stroke="var(--line)" strokeDasharray="2 6" />
      <circle cx={C} cy={C} r={RINGS[0]} fill="none" stroke="var(--accent)" strokeOpacity={needs ? 0.4 : 0.15} />
      <circle cx={C} cy={C} r={RINGS[0] - 2} fill="url(#foolscap-core)" />
      {["YOUR MOVE", "WORKING", "DONE"].map((name, i) => (
        <text key={name} x={C} y={C - RINGS[i] - 6} textAnchor="middle" fontSize="9" letterSpacing="1.5" fontFamily="var(--mono)" fill={i === 0 ? "var(--accent)" : "var(--ink-3)"} fillOpacity={i === 0 ? 0.85 : 0.7}>
          {name}
        </text>
      ))}
      <circle cx={C} cy={C} r={34} fill="var(--raised)" stroke="var(--line)" />
      <text x={C} y={C + 8} textAnchor="middle" fontSize="26" fontWeight="600" fontFamily="var(--mono)" fill={needs ? "var(--accent)" : "var(--ink-3)"}>
        {needs}
      </text>
      <text x={C} y={C + 50} textAnchor="middle" fontSize="10" fill="var(--ink-3)">
        {needs ? (needs === 1 ? "needs you" : "need you") : "all quiet"}
      </text>
      {sessions.map((s) => {
        const a = at.get(s.id) ?? 0;
        const radius = RINGS[ringOf(s)];
        return (
          <Planet
            key={s.id}
            s={s}
            x={C + radius * Math.cos(a)}
            y={C + radius * Math.sin(a)}
            angle={a}
            selected={selected === s.id}
            onSelect={() => onSelect(s.id)}
          />
        );
      })}
    </svg>
  );
}
