import type { NextActionRequest, NextActionResponse } from "../types";

export const SERVER_BASE = "http://localhost:8100";

export interface TimedAction {
  action: NextActionResponse;
  roundTripMs: number;
  serverMs: number | null; // model time as measured by the server (X-Planner-Ms)
}

export async function requestNextAction(payload: NextActionRequest): Promise<TimedAction> {
  const started = performance.now();
  const res = await fetch(`${SERVER_BASE}/api/next-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    throw new Error(`Server error ${res.status}: ${await res.text()}`);
  }
  const action = (await res.json()) as NextActionResponse;
  const header = res.headers.get("X-Planner-Ms");
  return { action, roundTripMs: performance.now() - started, serverMs: header ? Number(header) : null };
}

// --- Jarvis bridge (server/app/hub.py) ---

export interface RemoteTask {
  id: string;
  goal: string;
  source: string;
}

export async function claimRemoteTask(): Promise<RemoteTask | null> {
  try {
    const res = await fetch(`${SERVER_BASE}/api/tasks/claim`, { signal: AbortSignal.timeout(3000) });
    if (res.status !== 200) return null;
    return (await res.json()) as RemoteTask;
  } catch {
    return null; // server down: nothing to claim, stay quiet
  }
}

export interface RemoteTaskEvent {
  kind: "step" | "confirm" | "ask" | "done" | "error";
  text: string;
  data?: Record<string, unknown>;
}

export function postTaskEvent(taskId: string, event: RemoteTaskEvent): void {
  fetch(`${SERVER_BASE}/api/tasks/${taskId}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event)
  }).catch(() => undefined);
}
