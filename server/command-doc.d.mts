import type { AcpActivity, TranscriptBuilder } from "./acp-doc.mjs";

export declare class CommandBuilder {
  cells: TranscriptBuilder["cells"];
  entryCount: number;
  plan: null;
  activity: AcpActivity | null;
  totalOutputTokens: number;
  feed(dir: "c2a" | "a2c", msg: unknown, at?: string): void;
}
