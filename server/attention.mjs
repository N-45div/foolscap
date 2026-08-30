/**
 * Attention — which agent needs you, and in what order.
 *
 * This is the policy that turns five running agents from five things
 * to watch into one queue to work. It is a pure function of a session
 * snapshot, shared by the cockpit UI and the CLI so both agree, and
 * tested on its own.
 *
 * Tiers, highest first:
 *   0  needs you  — blocked on a permission, crashed, or its turn ended
 *                   with tests red
 *   1  review     — turn ended; it is waiting for you to read it
 *   2  working    — leave it alone
 *   3  idle       — nothing happening (fresh, or a turn you already read)
 *
 * Within a tier, the one that has been waiting longest comes first.
 */

export const TIER_LABEL = ["needs you", "review", "working", "idle"];

/**
 * @param {object} s      a session snapshot from the fleet
 * @param {boolean} seen  the user has opened this session since its
 *                        turn ended
 */
export function attention(s, seen = false) {
  const ev = s.evidence ?? {};
  if (s.status === "blocked") {
    return { tier: 0, reason: "waiting for permission", since: s.blockedSince };
  }
  if (s.status === "exited" || s.status === "error") {
    return { tier: 0, reason: s.status === "error" ? "failed to start" : "exited", since: s.endedAt };
  }
  if (s.status === "done" && ev.testsFailed > 0) {
    return { tier: 0, reason: `tests failing (${ev.testsFailed})`, since: s.doneAt };
  }
  if (s.status === "done") {
    const parts = [];
    if (ev.errors > 0) parts.push(`${ev.errors} tool error${ev.errors === 1 ? "" : "s"}`);
    if (ev.testsPassed > 0) parts.push("tests passed");
    if (ev.edited > 0) parts.push(`edited ${ev.edited} file${ev.edited === 1 ? "" : "s"}`);
    const reason = parts.length ? parts.join(" · ") : "turn ended";
    return seen
      ? { tier: 3, reason: `done · ${reason}`, since: s.doneAt }
      : { tier: 1, reason, since: s.doneAt };
  }
  if (s.status === "working") {
    return { tier: 2, reason: s.activity?.text ?? "working", since: s.turnStartedAt };
  }
  return { tier: 3, reason: s.status === "starting" ? "starting" : "idle", since: s.startedAt };
}

/** Sort snapshots into the queue. `seen` holds "<id>:<turns>" keys. */
export function rank(snapshots, seen = new Set()) {
  return snapshots
    .map((s) => ({ ...s, attention: attention(s, seen.has(`${s.id}:${s.turns}`)) }))
    .sort(
      (a, b) =>
        a.attention.tier - b.attention.tier ||
        (a.attention.since ?? "").localeCompare(b.attention.since ?? ""),
    );
}
