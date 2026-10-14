/**
 * OS notifications for the moments that need the person.
 *
 * A session's change becomes a notification only on a transition worth
 * interrupting for: a new permission request (with Approve and Deny on
 * the notification itself), a finished turn with foolscap's own test
 * verdict, a queued prompt held back, or a session that stopped. Nothing
 * fires while it is merely working.
 *
 * Windows needs a Start-menu shortcut carrying the app's AppUserModelID
 * before notifications show their buttons. The installer makes one; a
 * development run makes its own (see ensureDevShortcut in index.mjs).
 */
import { Notification } from "electron";

export function createNotifier({ find, closeTask, getSettings, onOpen, log }) {
  const last = new Map(); // session id → key of what we last told the person
  const live = new Map(); // keep shown notifications referenced until clicked

  function show(id, { title, body, actions = [], onAction, onReply, replyPlaceholder }) {
    if (!getSettings().notify || !Notification.isSupported()) return;
    const n = new Notification({
      title,
      body,
      actions,
      silent: false,
      timeoutType: actions.length || onReply ? "never" : "default",
      ...(onReply ? { hasReply: true, replyPlaceholder: replyPlaceholder ?? "Reply…" } : {}),
    });
    n.on("click", () => onOpen(id));
    n.on("action", (details, legacyIndex) => onAction?.(details?.actionIndex ?? legacyIndex));
    n.on("reply", (details, legacyReply) => {
      const text = String(details?.reply ?? legacyReply ?? "").trim();
      if (text) onReply?.(text);
    });
    n.on("close", () => live.delete(n));
    n.on("failed", (_e, error) => log?.(`notification failed: ${error}`));
    live.set(n, id);
    n.show();
  }

  /** A reply typed into a notification: the next prompt, now if the agent
      is free, otherwise queued behind what it is doing. */
  function replyTo(id, text) {
    const current = find(id);
    if (!current) return;
    try {
      if (current.status === "idle" || current.status === "done") current.prompt(text);
      else current.enqueue(text);
      log?.(`replied from the notification`);
    } catch (err) {
      log?.(`reply from the notification failed: ${err.message}`);
      onOpen(id);
    }
  }

  function keyOf(s) {
    if (s.status === "blocked" && s.pendingPermission) return `ask:${s.pendingPermission.requestId}`;
    if (s.status === "done") return `done:${s.turns}:${s.held ? "held" : s.verified?.verdict ?? "-"}`;
    if (s.status === "error" || s.status === "exited") return `end:${s.status}`;
    return null;
  }

  return function onChange(session) {
    if (!session) return;
    const s = session.snapshot();
    const key = keyOf(s);
    if (!key || last.get(s.id) === key) return;
    last.set(s.id, key);
    const who = `${s.agentLabel} · ${s.name}`;

    if (key.startsWith("ask:") && s.pendingPermission.answer === "text") {
      const p = s.pendingPermission;
      show(s.id, {
        title: `${who} asks`,
        body: p.toolCall?.title ?? "A question for you",
        replyPlaceholder: "Your answer…",
        onReply: (text) => {
          const current = find(s.id);
          if (current?.pendingPermission?.requestId === p.requestId) current.answerPermission(undefined, text);
        },
      });
      return;
    }
    if (key.startsWith("ask:")) {
      const p = s.pendingPermission;
      const allow = p.options?.find((o) => /allow/i.test(o.kind ?? o.optionId))?.optionId ?? "allow_once";
      const reject = p.options?.find((o) => /reject/i.test(o.kind ?? o.optionId))?.optionId ?? "reject_once";
      show(s.id, {
        title: `${who} needs you`,
        body: p.toolCall?.title ?? "Permission requested",
        actions: [{ type: "button", text: "Approve" }, { type: "button", text: "Deny" }],
        onAction: (index) => {
          const current = find(s.id);
          if (current?.pendingPermission?.requestId !== p.requestId) return;
          current.answerPermission(index === 0 ? allow : reject);
          log?.(`answered ${index === 0 ? "approve" : "deny"} from the notification`);
        },
      });
      return;
    }
    if (key.startsWith("done:")) {
      if (s.held) {
        show(s.id, {
          title: `${who}: next prompt held`,
          body: s.held.reason,
          actions: [{ type: "button", text: "Send anyway" }, { type: "button", text: "Open" }],
          onAction: (index) => {
            if (index !== 0) return onOpen(s.id);
            try {
              find(s.id)?.sendNext();
            } catch (err) {
              log?.(err.message);
              onOpen(s.id);
            }
          },
          replyPlaceholder: `Tell ${s.name} what to do instead…`,
          onReply: (text) => replyTo(s.id, text),
        });
        return;
      }
      const v = s.verified;
      const counts = v?.counts ? `, ${v.counts.passed}/${v.counts.total}` : "";
      let body = "Turn finished. No test command found to check it with.";
      if (v?.verdict === "green") body = `Tests green${counts}, checked by foolscap.`;
      else if (v?.verdict === "red") body = `Tests failing${counts}, checked by foolscap.`;
      else if (v) body = `Tests unclear: ${v.reason}.`;
      if (s.assistant) body = "Replied. Open to read it.";
      if (s.worktree && v?.verdict === "green") {
        const size = s.changes?.files ? ` ${s.changes.files} file${s.changes.files === 1 ? "" : "s"}, +${s.changes.added} −${s.changes.removed}.` : "";
        show(s.id, {
          title: `${who} is ready to merge`,
          body: `${body}${size}`,
          actions: [{ type: "button", text: "Merge" }, { type: "button", text: "Open" }],
          replyPlaceholder: `Not yet? Tell ${s.name} what to change…`,
          onReply: (text) => replyTo(s.id, text),
          onAction: (index) => {
            if (index !== 0) return onOpen(s.id);
            find(s.id)?.merge()
              .then((sha) => {
                closeTask(s.id);
                log?.(`merged ${s.name} as ${sha} from the notification`);
              })
              .catch((err) => {
                log?.(`merge from the notification failed: ${err.message}`);
                onOpen(s.id);
              });
          },
        });
        return;
      }
      show(s.id, {
        title: `${who} finished`,
        body,
        replyPlaceholder: `Next, ${s.name} should…`,
        onReply: (text) => replyTo(s.id, text),
      });
      return;
    }
    show(s.id, { title: `${who} stopped`, body: s.error ?? "The agent exited." });
  };
}
