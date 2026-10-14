export declare const TIER_LABEL: string[];

export type Attention = { tier: 0 | 1 | 2 | 3; reason: string; since?: string };

export declare function attention(snapshot: unknown, seen?: boolean): Attention;

export declare function rank<T>(
  snapshots: T[],
  seen?: Set<string>,
): Array<T & { attention: Attention }>;
