import type { NextActionRequest, NextActionResponse } from "../types";

const SERVER_URL = "http://localhost:8100/api/next-action";

export async function requestNextAction(payload: NextActionRequest): Promise<NextActionResponse> {
  const res = await fetch(SERVER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    throw new Error(`Server error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}
