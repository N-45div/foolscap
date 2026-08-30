import { parseSession } from "../model";
import { parseCodexSession } from "./codex";
import { parseDshSession } from "./dsh";
import { parseAcpSession } from "./acp";
import type { SessionDoc } from "../model";

/**
 * The harness registry. foolscap is harness-agnostic by design: every
 * source is one adapter that turns that harness's on-disk session format
 * into the neutral SessionDoc. Adding a harness = adding one file here.
 */
export type SourceId = "claude" | "codex" | "dsh" | "acp";

export const SOURCES: Record<
  SourceId,
  { label: string; parse: (raw: string) => SessionDoc }
> = {
  claude: { label: "claude code", parse: parseSession },
  codex: { label: "codex", parse: parseCodexSession },
  dsh: { label: "deepseek dsh", parse: parseDshSession },
  // Any harness, via the protocol: sessions run through the fleet/bridge.
  acp: { label: "fleet", parse: parseAcpSession },
};
