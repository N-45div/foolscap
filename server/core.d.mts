import type { IncomingMessage, ServerResponse } from "node:http";

export declare const MAX_SESSION_BYTES: number;

export declare function resolveRoots(fixtureRoot: string | undefined): {
  claudeRoot: string;
  codexRoot: string | null;
};

export declare function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  roots: { claudeRoot: string; codexRoot: string | null },
): Promise<boolean>;

export declare function scanAll(roots: {
  claudeRoot: string;
  codexRoot: string | null;
}): Promise<
  Array<{
    source: string;
    dir: string;
    sessions: Array<{ id: string; file: string; bytes: number; modified: number }>;
  }>
>;
