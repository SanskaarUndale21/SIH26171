import type { NextActionResponse, RedactionEntry, RiskTier } from "../types";

// The always-available "pill" launcher (Aura's term for it) -- a small floating button
// injected into every page, distinct from the full side panel. Fades to near-invisible after
// idle, snaps back on hover or while a task is running, and expands into a compact popup for
// quick tasks without needing to open the side panel at all. Rendered inside a shadow root so
// the host page's CSS can never bleed in or be broken by it.
//
// Deliberately does NOT duplicate voice input here: SpeechRecognition running in a content
// script asks for microphone permission as the CURRENT WEBSITE, not as the extension -- a
// confusing, page-by-page permission prompt. Voice stays in the side panel, which has its own
// stable chrome-extension:// origin for that permission. The popup's "expand" button opens
// the full side panel for that (and for full step-by-step history).

const IDLE_FADE_MS = 8000;

let shadowHost: HTMLDivElement | null = null;
let root: ShadowRoot | null = null;
let popupEl: HTMLDivElement | null = null;
let pillEl: HTMLButtonElement | null = null;
let statusEl: HTMLDivElement | null = null;
let inputEl: HTMLTextAreaElement | null = null;
let sendBtn: HTMLButtonElement | null = null;
let confirmRow: HTMLDivElement | null = null;

let fadeTimer: number | null = null;
let activeRunId: string | null = null;
let pendingConfirmRequestId: string | null = null;

function scheduleFade(): void {
  if (fadeTimer !== null) window.clearTimeout(fadeTimer);
  if (activeRunId) return; // never fade while a task is actually running
  fadeTimer = window.setTimeout(() => {
    pillEl?.classList.add("idle");
  }, IDLE_FADE_MS);
}

function wake(): void {
  pillEl?.classList.remove("idle");
  scheduleFade();
}

function setPopupOpen(open: boolean): void {
  if (!popupEl) return;
  popupEl.style.display = open ? "flex" : "none";
  if (open) {
    wake();
    inputEl?.focus();
  }
}

function setStatus(text: string, isError = false): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#fca5a5" : "#9ca3af";
}

function setRunning(running: boolean): void {
  if (!sendBtn) return;
  sendBtn.disabled = running;
  pillEl?.classList.toggle("running", running);
  if (!running) {
    activeRunId = null;
    scheduleFade();
  }
}

function showConfirm(
  requestId: string,
  action: NextActionResponse,
  riskTier: RiskTier,
  unfilledSensitiveTypes: string[]
): void {
  if (!confirmRow || !root) return;
  pendingConfirmRequestId = requestId;
  confirmRow.innerHTML = "";
  confirmRow.style.display = "flex";

  const label = document.createElement("div");
  let text = `${riskTier.replace("_", " ")}: ${action.action}${
    action.target.selector ? ` on ${action.target.selector}` : ""
  }.`;
  if (unfilledSensitiveTypes.length > 0) {
    text += ` ${unfilledSensitiveTypes.join(", ")} still empty (agent never fills these).`;
  }
  text += " Go ahead?";
  label.textContent = text;
  label.style.cssText = "font-size:11px;color:#e5e7eb;margin-bottom:4px;";
  confirmRow.appendChild(label);

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;";
  const yesBtn = document.createElement("button");
  yesBtn.textContent = "Yes";
  yesBtn.style.cssText = "flex:1;padding:4px;border:none;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;font-size:11px;";
  const noBtn = document.createElement("button");
  noBtn.textContent = "No";
  noBtn.style.cssText = "flex:1;padding:4px;border:1px solid #4b5563;border-radius:6px;background:transparent;color:#e5e7eb;cursor:pointer;font-size:11px;";

  const respond = (approved: boolean) => {
    chrome.runtime.sendMessage({ type: "CONFIRM_RESPONSE", requestId, approved });
    confirmRow!.style.display = "none";
    pendingConfirmRequestId = null;
  };
  yesBtn.addEventListener("click", () => respond(true));
  noBtn.addEventListener("click", () => respond(false));
  row.appendChild(yesBtn);
  row.appendChild(noBtn);
  confirmRow.appendChild(row);
}

// A field the planner has no value for (e.g. a name or a free-text reason) -- asked directly
// here rather than guessed. The typed answer goes straight to background -> EXECUTE_ACTION;
// it is never sent to the server (see background/index.ts's ask_user branch).
function showAskUser(requestId: string, question: string): void {
  if (!confirmRow || !root) return;
  pendingConfirmRequestId = requestId;
  confirmRow.innerHTML = "";
  confirmRow.style.display = "flex";
  confirmRow.style.flexDirection = "column";

  const label = document.createElement("div");
  label.textContent = question;
  label.style.cssText = "font-size:11px;color:#e5e7eb;margin-bottom:4px;";
  confirmRow.appendChild(label);

  const answerInput = document.createElement("input");
  answerInput.type = "text";
  answerInput.placeholder = "Type your answer...";
  answerInput.style.cssText =
    "border-radius:8px;border:1px solid #374151;background:#1f2937;color:#f3f4f6;font-size:12px;padding:6px;margin-bottom:6px;font-family:inherit;";

  const row = document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;";
  const sendAnswerBtn = document.createElement("button");
  sendAnswerBtn.textContent = "Fill it in";
  sendAnswerBtn.style.cssText = "flex:1;padding:4px;border:none;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer;font-size:11px;";
  const skipBtn = document.createElement("button");
  skipBtn.textContent = "Skip";
  skipBtn.style.cssText = "flex:1;padding:4px;border:1px solid #4b5563;border-radius:6px;background:transparent;color:#e5e7eb;cursor:pointer;font-size:11px;";

  const respond = (answer: string | null) => {
    chrome.runtime.sendMessage({ type: "ASK_USER_RESPONSE", requestId, answer });
    confirmRow!.style.display = "none";
    confirmRow!.style.flexDirection = "";
    pendingConfirmRequestId = null;
  };
  sendAnswerBtn.addEventListener("click", () => respond(answerInput.value.trim() || null));
  answerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      respond(answerInput.value.trim() || null);
    }
  });
  skipBtn.addEventListener("click", () => respond(null));

  row.appendChild(sendAnswerBtn);
  row.appendChild(skipBtn);
  confirmRow.appendChild(answerInput);
  confirmRow.appendChild(row);
  answerInput.focus();
}

function runTask(): void {
  if (!inputEl || activeRunId) return;
  const taskGoal = inputEl.value.trim();
  if (!taskGoal) return;
  inputEl.value = "";
  setRunning(true);
  setStatus("Reading the page and redacting PII locally...");

  chrome.runtime.sendMessage({ type: "RUN_TASK", taskGoal }, (response) => {
    if (chrome.runtime.lastError) {
      setRunning(false);
      setStatus("Error: " + chrome.runtime.lastError.message, true);
      return;
    }
    if (!response?.ok) {
      setRunning(false);
      setStatus("Error: " + (response?.error ?? "unknown"), true);
      return;
    }
    activeRunId = response.runId as string;
  });
}

function openSidePanel(): void {
  chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" }).catch(() => undefined);
}

// Handles the same broadcast shape the side panel listens for -- background also targets
// this tab directly (chrome.tabs.sendMessage) for these three message types, since a content
// script does not receive chrome.runtime.sendMessage broadcasts the way extension pages do.
export function handlePillMessage(message: {
  type: string;
  runId?: string;
  status?: string;
  message?: string;
  requestId?: string;
  action?: NextActionResponse;
  riskTier?: RiskTier;
  redactionManifest?: RedactionEntry[];
  unfilledSensitiveTypes?: string[];
  question?: string;
}): void {
  if (message.type === "TASK_STEP" && message.runId === activeRunId) {
    setStatus(`Step ${(message as any).step}: ${message.status}`);
  } else if (message.type === "TASK_DONE" && message.runId === activeRunId) {
    setRunning(false);
    setStatus(message.message ?? "Done.", message.message?.toLowerCase().includes("error"));
  } else if (message.type === "CONFIRM_REQUEST" && message.runId === activeRunId && message.action && message.riskTier) {
    showConfirm(message.requestId!, message.action, message.riskTier, message.unfilledSensitiveTypes ?? []);
  } else if (message.type === "ASK_USER_REQUEST" && message.runId === activeRunId && message.question) {
    showAskUser(message.requestId!, message.question);
  }
}

export function initPill(): void {
  if (shadowHost) return; // already injected (e.g. duplicate script run)

  shadowHost = document.createElement("div");
  shadowHost.id = "__fusion_privacy_pill_host__";
  shadowHost.style.cssText = "position:fixed;inset:auto 20px 20px auto;z-index:2147483647;";
  root = shadowHost.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    .pill {
      width: 44px; height: 44px; border-radius: 50%; border: none; cursor: pointer;
      background: linear-gradient(135deg, #2563eb, #7c3aed);
      box-shadow: 0 2px 10px rgba(0,0,0,0.35);
      display: flex; align-items: center; justify-content: center;
      font-size: 18px; color: #fff;
      transition: opacity 0.4s ease, transform 0.2s ease;
      opacity: 1;
    }
    .pill.idle { opacity: 0.35; transform: scale(0.85); }
    .pill.running { animation: pulse 1.2s infinite; }
    .pill:hover { opacity: 1; transform: scale(1); }
    @keyframes pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(37,99,235,0.6);} 50% { box-shadow: 0 0 0 8px rgba(37,99,235,0);} }
    .popup {
      display: none; flex-direction: column; gap: 6px;
      position: absolute; bottom: 54px; right: 0;
      width: 260px; background: #111827; border: 1px solid #374151; border-radius: 12px;
      padding: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    }
    .popup-header { display:flex; justify-content:space-between; align-items:center; }
    .popup-title { font-size: 12px; font-weight: 600; color: #f3f4f6; }
    .popup-expand { font-size: 10px; color: #93c5fd; background: none; border: none; cursor: pointer; }
    textarea {
      resize: none; height: 44px; border-radius: 8px; border: 1px solid #374151;
      background: #1f2937; color: #f3f4f6; font-size: 12px; padding: 6px; font-family: inherit;
    }
    textarea:focus { outline: none; border-color: #2563eb; }
    .send-btn {
      border: none; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer;
      font-size: 12px; padding: 6px;
    }
    .send-btn:disabled { background: #374151; cursor: default; }
    .status { font-size: 10px; color: #9ca3af; min-height: 12px; }
  `;
  root.appendChild(style);

  pillEl = document.createElement("button");
  pillEl.className = "pill";
  pillEl.title = "Fusion Privacy Agent -- click to ask it something";
  pillEl.textContent = "✦";
  pillEl.addEventListener("click", () => {
    const isOpen = popupEl?.style.display === "flex";
    setPopupOpen(!isOpen);
  });
  pillEl.addEventListener("mouseenter", wake);

  popupEl = document.createElement("div");
  popupEl.className = "popup";

  const header = document.createElement("div");
  header.className = "popup-header";
  const title = document.createElement("span");
  title.className = "popup-title";
  title.textContent = "Fusion Privacy Agent";
  const expand = document.createElement("button");
  expand.className = "popup-expand";
  expand.textContent = "Open full panel ↗";
  expand.addEventListener("click", openSidePanel);
  header.appendChild(title);
  header.appendChild(expand);

  inputEl = document.createElement("textarea");
  inputEl.placeholder = "Tell it what to do on this page...";
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runTask();
    }
  });

  sendBtn = document.createElement("button");
  sendBtn.className = "send-btn";
  sendBtn.textContent = "Run";
  sendBtn.addEventListener("click", runTask);

  statusEl = document.createElement("div");
  statusEl.className = "status";

  confirmRow = document.createElement("div");
  confirmRow.style.display = "none";

  popupEl.appendChild(header);
  popupEl.appendChild(inputEl);
  popupEl.appendChild(sendBtn);
  popupEl.appendChild(statusEl);
  popupEl.appendChild(confirmRow);

  root.appendChild(popupEl);
  root.appendChild(pillEl);
  document.documentElement.appendChild(shadowHost);

  document.addEventListener("click", (e) => {
    if (!shadowHost) return;
    if (e.composedPath().includes(shadowHost)) return;
    setPopupOpen(false);
  });

  scheduleFade();
}
