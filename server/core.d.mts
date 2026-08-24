import type { IncomingMessage, ServerResponse } from "node:http";

export declare const MAX_SESSION_BYTES: number;

export type ArchiveRoots = {
  claudeRoot: string;
  codexRoot: string | null;
  dshRoot: string | null;
};

export declare function resolveRoots(
  fixtureRoot: string | undefined,
): ArchiveRoots;

export declare function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  roots: ArchiveRoots,
): Promise<boolean>;

export declare function scanAll(roots: ArchiveRoots): Promise<
  Array<{
    source: string;
    dir: string;
    sessions: Array<{ id: string; file: string; bytes: number; modified: number }>;
  }>
>;
