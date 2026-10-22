/**
 * A block of ports for each task, so tasks running side by side never
 * fight over one dev-server port.
 *
 * Task blocks start at 4100 and step by 10: 4100-4109, 4110-4119, and so
 * on. A task's agent gets `PORT` (the block's first port) and
 * `FOOLSCAP_PORTS` ("4110-4119"); Run starts the dev server on `PORT`.
 *
 * A block is skipped when another task holds it, or when something is
 * already listening on its first port. Listening is checked by
 * connecting, on 127.0.0.1 and ::1, because dev servers that listen on
 * "localhost" often bind ::1 alone. Blocks are reserved before that
 * check, so two tasks starting at once never get the same one.
 */
import { connect } from "node:net";

export const PORT_BASE = 4100;
export const BLOCK = 10;
const MAX_BLOCKS = 100;

/** Resolves true when something accepts a connection on `port` on this machine. */
export function portBusy(port, { timeoutMs = 300 } = {}) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = connect({ host, port });
      const done = (busy) => {
        socket.destroy();
        resolve(busy);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  return probe("127.0.0.1").then((busy) => busy || probe("::1"));
}

/** Hands out port blocks and takes them back. One per fleet. */
export class PortBlocks {
  constructor({ base = PORT_BASE, size = BLOCK, busy = portBusy } = {}) {
    this.base = base;
    this.size = size;
    this.busy = busy;
    this.held = new Set();
  }

  /** The next free block as `{ base, last }`, or null when none is left. */
  async take() {
    for (let i = 0; i < MAX_BLOCKS; i++) {
      const base = this.base + i * this.size;
      if (this.held.has(base)) continue;
      this.held.add(base);
      if (await this.busy(base)) {
        this.held.delete(base);
        continue;
      }
      return { base, last: base + this.size - 1 };
    }
    return null;
  }

  release(block) {
    if (block) this.held.delete(block.base);
  }
}

/** The variables a task's agent and its dev server get for `block`. */
export function portEnv(block) {
  return block ? { PORT: String(block.base), FOOLSCAP_PORTS: `${block.base}-${block.last}` } : {};
}
