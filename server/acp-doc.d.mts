export type AcpActivity = {
  kind: "tool" | "message" | "thinking" | "blocked";
  text: string;
};

export declare class TranscriptBuilder {
  cells: Array<{
    prompt: string;
    promptAt?: string;
    parts: Array<
      | { kind: "text"; text: string; at?: string }
      | { kind: "thinking"; text: string; at?: string }
      | {
          kind: "tool";
          at?: string;
          tool: {
            id: string;
            name: string;
            input: Record<string, unknown>;
            result?: string;
            isError: boolean;
            status?: string;
          };
        }
    >;
    outputTokens: number;
    stopReason?: string;
  }>;
  entryCount: number;
  plan: Array<{ content: string; priority?: string; status?: string }> | null;
  activity: AcpActivity | null;
  feed(dir: "c2a" | "a2c", msg: unknown, at?: string): void;
}
