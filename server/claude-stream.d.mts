import type { AcpActivity, TranscriptBuilder } from "./acp-doc.mjs";

export declare class ClaudeStreamBuilder {
  cells: TranscriptBuilder["cells"];
  entryCount: number;
  plan: null;
  activity: AcpActivity | null;
  model: string | null;
  sessionId: string | null;
  costUsd: number;
  totalOutputTokens: number;
  feed(dir: "c2a" | "a2c", msg: unknown, at?: string): void;
}
