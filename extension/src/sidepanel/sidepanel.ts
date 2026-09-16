import type { NextActionResponse, RedactionEntry } from "../types";

const messagesEl = document.getElementById("messages") as HTMLDivElement;
const goalInput = document.getElementById("goal") as HTMLTextAreaElement;
const sendButton = document.getElementById("send") as HTMLButtonElement;

function scrollToBottom(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(kind: "user" | "agent" | "error" | "system", text: string): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `msg ${kind}`;
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
  return el;
}

function appendManifestChips(container: HTMLDivElement, manifest: RedactionEntry[]): void {
  if (manifest.length === 0) return;
  const row = document.createElement("div");
  row.className = "manifest-chip-row";
  for (const entry of manifest) {
    const chip = document.createElement("span");
    chip.className = "manifest-chip" + (entry.confidence < 0.5 ? " low-conf" : "");
    chip.textContent = `${entry.type} ${(entry.confidence * 100).toFixed(0)}%`;
    row.appendChild(chip);
  }
  container.appendChild(row);
}

function appendActionDetail(container: HTMLDivElement, action: NextActionResponse): void {
  const details = document.createElement("details");
  details.className = "action-detail";
  const summary = document.createElement("summary");
  summary.textContent = `${action.action}${action.target.selector ? ` → ${action.target.selector}` : ""}`;
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(action, null, 2);
  details.appendChild(summary);
  details.appendChild(pre);
  container.appendChild(details);
}

function autoGrow(): void {
  goalInput.style.height = "auto";
  goalInput.style.height = `${Math.min(goalInput.scrollHeight, 90)}px`;
}

async function runTask(): Promise<void> {
  const taskGoal = goalInput.value.trim();
  if (!taskGoal) return;

  addMessage("user", taskGoal);
  goalInput.value = "";
  autoGrow();
  sendButton.disabled = true;

  const thinking = addMessage("system", "Reading the page and redacting PII locally...");

  chrome.runtime.sendMessage({ type: "RUN_TASK", taskGoal }, (response) => {
    thinking.remove();
    sendButton.disabled = false;

    if (chrome.runtime.lastError) {
      addMessage("error", "Error: " + chrome.runtime.lastError.message);
      return;
    }
    if (!response?.ok) {
      addMessage("error", "Error: " + (response?.error ?? "unknown"));
      return;
    }

    const agentMsg = addMessage("agent", response.status as string);
    if (response.redactionManifest?.length) {
      appendManifestChips(agentMsg, response.redactionManifest as RedactionEntry[]);
    }
    if (response.action) {
      appendActionDetail(agentMsg, response.action as NextActionResponse);
    }
    scrollToBottom();
  });
}

sendButton.addEventListener("click", () => void runTask());
goalInput.addEventListener("input", autoGrow);
goalInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void runTask();
  }
});

addMessage("system", "Open a page, then tell it what to do. PII never leaves your browser unredacted.");
