import type { AcpActivity, TranscriptBuilder } from "./acp-doc.mjs";

export declare class DevinBuilder {
  cells: TranscriptBuilder["cells"];
  entryCount: number;
  plan: null;
  activity: AcpActivity | null;
  url: string | null;
  pullRequest: string | null;
  totalOutputTokens: number;
  feed(dir: "c2a" | "a2c", msg: unknown, at?: string): void;
}
