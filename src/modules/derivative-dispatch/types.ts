import type { DerivationKind } from "../../storage/local-store.js";

export interface DispatchPolicy {
  version: 1;
  id: string;
  enabled: boolean;
  host: "codex";
  enabledAt: string;
}

export type DispatchState = "queued" | "leased" | "dispatching" | "started" | "blocked" | "unknown" | "cancelled";
export interface DispatchSession { threadId: string; turnId?: string; submittedAt?: string }
export interface DispatchJob {
  id: string;
  sourceId: string;
  sourceTitle: string;
  round: number;
  sourceCutHash: string;
  kind: DerivationKind;
  targetPlatforms: string[];
  requiredZhPlatforms: string[];
  receiptRefs: Array<{ platform: string; slotId: string; factId?: string; evidence: string }>;
  policyId: string;
  host: "codex";
  state: DispatchState;
  createdAt: string;
  updatedAt: string;
  /** Explicit backfill authorizes only this job's source/round/cut/kind. */
  manualRequestedAt?: string;
  derivedContentId?: string;
  cwd?: string;
  lease?: { owner: string; epoch: number; expiresAt: string };
  attempt?: { id: string; at: string; promptHash: string };
  session?: DispatchSession;
  code?: string;
  reason?: string;
}
export interface DispatchOutbox { version: 1; revision: number; jobs: DispatchJob[] }

export interface EligibleSource {
  sourceId: string;
  sourceTitle: string;
  round: number;
  sourceCutHash: string;
  requiredZhPlatforms: string[];
  receiptRefs: DispatchJob["receiptRefs"];
  intents: Array<{ kind: DerivationKind; targetPlatforms: string[]; blockedReason?: string }>;
}
export type Eligibility = { ok: true; value: EligibleSource } | { ok: false; code: string; error: string };

export interface RemoteThread { id: string; cwd: string; name?: string; status?: string }
export interface ThreadInspection {
  threadId: string;
  status: string;
  turns: Array<{ id: string; status: string; items: Array<{ type: string; text?: string }> }>;
  nextCursor?: string | null;
  needsAttention?: string;
}
export type LaunchResult =
  | { status: "started"; session: DispatchSession }
  | { status: "unknown" | "blocked"; code: string; error: string; threadId?: string };

export interface CodexHostAdapter {
  capability(): Promise<{ ok: boolean; reason?: string; authMode?: string }>;
  lookup(cwd: string): Promise<RemoteThread[]>;
  start(input: { jobId: string; cwd: string; title: string; prompt: string }, onCreated: (threadId: string) => Promise<void>, beforeTurn?: () => Promise<void>): Promise<LaunchResult>;
  inspect(threadId: string, cursor?: string): Promise<ThreadInspection>;
  resume(threadId: string, prompt: string, beforeTurn?: () => Promise<void>): Promise<LaunchResult>;
  activeCount(): number;
  close(): Promise<void>;
}
