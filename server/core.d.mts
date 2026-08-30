import type { IncomingMessage, ServerResponse } from "node:http";

export declare const MAX_SESSION_BYTES: number;

export type ArchiveRoots = {
  claudeRoot: string;
  codexRoot: string | null;
  dshRoot: string | null;
  acpRoot: string | null;
  opencodeRoot: string | null;
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
    sessions: Array<{ id: string; title?: string; file: string; bytes: number; modified: number }>;
  }>
>;

export declare function readSessionText(file: string): Promise<string>;

export type ShelfPrompt = {
  key: string;
  text: string;
  at?: string;
  count: number;
  verified: number;
  corrected: number;
  source: string;
  dir: string;
  session: { id: string; title?: string; file: string; bytes: number; modified: number };
  starred: boolean;
};

export declare function collectPrompts(
  roots: ArchiveRoots,
): Promise<ShelfPrompt[]>;
