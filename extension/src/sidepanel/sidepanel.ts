import type { NextActionResponse, RedactionEntry, RiskTier } from "../types";
import type { ExtensionMessage } from "../messages";

const messagesEl = document.getElementById("messages") as HTMLDivElement;
const goalInput = document.getElementById("goal") as HTMLTextAreaElement;
const sendButton = document.getElementById("send") as HTMLButtonElement;

let activeRunId: string | null = null;
let activeThinkingEl: HTMLDivElement | null = null;

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

function setRunning(running: boolean): void {
  sendButton.innerHTML = running ? "&#9632;" : "&#8593;"; // square (stop) / up-arrow (send)
  sendButton.title = running ? "Stop task" : "Run task";
  if (!running) {
    activeRunId = null;
    activeThinkingEl?.remove();
    activeThinkingEl = null;
  }
}

function addConfirmPrompt(requestId: string, action: NextActionResponse, riskTier: RiskTier): void {
  const el = document.createElement("div");
  el.className = "msg agent";
  const label = document.createElement("div");
  label.textContent = `This looks like a ${riskTier.replace("_", " ")} action: ${action.action}${
    action.target.selector ? ` on ${action.target.selector}` : ""
  }. Go ahead?`;
  el.appendChild(label);

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "6px";
  row.style.marginTop = "6px";

  const respond = (approved: boolean) => {
    chrome.runtime.sendMessage({ type: "CONFIRM_RESPONSE", requestId, approved });
    yesBtn.disabled = true;
    noBtn.disabled = true;
    label.textContent += approved ? " (confirmed)" : " (stopped)";
    row.remove();
  };

  const yesBtn = document.createElement("button");
  yesBtn.textContent = "Yes, continue";
  yesBtn.style.cssText = "flex:1;padding:6px;border:none;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer;font-size:12px;";
  yesBtn.addEventListener("click", () => respond(true));

  const noBtn = document.createElement("button");
  noBtn.textContent = "No, stop";
  noBtn.style.cssText = "flex:1;padding:6px;border:1px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer;font-size:12px;";
  noBtn.addEventListener("click", () => respond(false));

  row.appendChild(yesBtn);
  row.appendChild(noBtn);
  el.appendChild(row);
  messagesEl.appendChild(el);
  scrollToBottom();
}

function autoGrow(): void {
  goalInput.style.height = "auto";
  goalInput.style.height = `${Math.min(goalInput.scrollHeight, 90)}px`;
}

function runTask(): void {
  const taskGoal = goalInput.value.trim();
  if (!taskGoal || activeRunId) return;

  addMessage("user", taskGoal);
  goalInput.value = "";
  autoGrow();
  setRunning(true);
  activeThinkingEl = addMessage("system", "Reading the page and redacting PII locally...");

  chrome.runtime.sendMessage({ type: "RUN_TASK", taskGoal }, (response) => {
    if (chrome.runtime.lastError) {
      setRunning(false);
      addMessage("error", "Error: " + chrome.runtime.lastError.message);
      return;
    }
    if (!response?.ok) {
      setRunning(false);
      addMessage("error", "Error: " + (response?.error ?? "unknown"));
      return;
    }
    activeRunId = response.runId as string;
  });
}

chrome.runtime.onMessage.addListener((message: ExtensionMessage) => {
  if (message.type === "TASK_STEP") {
    if (message.runId !== activeRunId) return;
    activeThinkingEl?.remove();
    const agentMsg = addMessage("agent", `Step ${message.step}: ${message.status}`);
    if (message.redactionManifest?.length) appendManifestChips(agentMsg, message.redactionManifest);
    if (message.action) appendActionDetail(agentMsg, message.action);
    activeThinkingEl = addMessage("system", "Working...");
    scrollToBottom();
    return;
  }

  if (message.type === "TASK_DONE") {
    if (message.runId !== activeRunId) return;
    setRunning(false);
    addMessage(message.reason === "error" ? "error" : "system", message.message);
    return;
  }

  if (message.type === "CONFIRM_REQUEST") {
    if (message.runId !== activeRunId) return;
    activeThinkingEl?.remove();
    activeThinkingEl = null;
    addConfirmPrompt(message.requestId, message.action, message.riskTier);
    return;
  }
});

sendButton.addEventListener("click", () => {
  if (activeRunId) {
    chrome.runtime.sendMessage({ type: "CANCEL_TASK", runId: activeRunId });
    return;
  }
  runTask();
});
goalInput.addEventListener("input", autoGrow);
goalInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    runTask();
  }
});

addMessage("system", "Open a page, then tell it what to do. PII never leaves your browser unredacted. It'll work step by step and ask before submit/payment-style actions.");
