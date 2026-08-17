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
