import type { NextActionResponse, RedactionEntry, RiskTier } from "../types";

// The always-available launcher: a small button on every page, separate from the side panel.
// Fades back after idle, comes forward on hover or while a task runs, and opens a compact
// popup for quick tasks. Rendered inside a closed shadow root so the host page's CSS can never
// reach it.
//
// Voice input deliberately stays in the side panel: a microphone prompt from a content script
// is asked in the name of the CURRENT WEBSITE, page by page. The side panel has its own stable
// extension origin for that permission.

const IDLE_FADE_MS = 8000;

let shadowHost: HTMLDivElement | null = null;
let root: ShadowRoot | null = null;
let popupEl: HTMLDivElement | null = null;
let pillEl: HTMLButtonElement | null = null;
let statusEl: HTMLParagraphElement | null = null;
let inputEl: HTMLTextAreaElement | null = null;
let sendBtn: HTMLButtonElement | null = null;
let promptEl: HTMLDivElement | null = null;

let fadeTimer: number | null = null;
let activeRunId: string | null = null;
let closeTimer: number | null = null;

const TYPE_NAMES: Record<string, string> = {
  password_field: "password",
  card_number: "card",
  phone_number: "phone",
  person_name: "name"
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function scheduleFade(): void {
  if (fadeTimer !== null) window.clearTimeout(fadeTimer);
  if (activeRunId) return; // never fade while a task is running
  fadeTimer = window.setTimeout(() => pillEl?.classList.add("idle"), IDLE_FADE_MS);
}

function wake(): void {
  pillEl?.classList.remove("idle");
  scheduleFade();
}

function isOpen(): boolean {
  return popupEl?.classList.contains("open") ?? false;
}

function setPopupOpen(open: boolean): void {
  if (!popupEl || !pillEl) return;
  if (closeTimer !== null) {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }
  pillEl.setAttribute("aria-expanded", String(open));
  if (open) {
    popupEl.classList.remove("closing");
    popupEl.classList.add("open");
    wake();
    inputEl?.focus();
  } else if (isOpen()) {
    popupEl.classList.add("closing");
    closeTimer = window.setTimeout(() => {
      popupEl?.classList.remove("open", "closing");
      closeTimer = null;
    }, 150);
  }
}

function setStatus(text: string, state: "idle" | "running" | "error" = "idle"): void {
  if (!statusEl) return;
  statusEl.textContent = text;
  statusEl.dataset.state = state;
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

function clearPrompt(): void {
  if (!promptEl) return;
  promptEl.replaceChildren();
  promptEl.hidden = true;
  promptEl.className = "prompt";
}

function showConfirm(requestId: string, action: NextActionResponse, _riskTier: RiskTier, unfilled: string[]): void {
  if (!promptEl) return;
  clearPrompt();
  promptEl.hidden = false;
  const target = action.target.selector ? ` ${action.target.selector}` : "";
  promptEl.appendChild(el("p", "prompt-title", "Needs your OK"));
  let text = `Next it will ${action.action}${target}.`;
  if (unfilled.length) {
    text += ` Still empty: ${unfilled.map((t) => TYPE_NAMES[t] ?? t).join(", ")}.`;
  }
  promptEl.appendChild(el("p", "", text));
  const row = el("div", "row");
  const yes = el("button", "btn go", "Go ahead");
  const no = el("button", "btn quiet", "Stop here");
  const respond = (approved: boolean) => {
    chrome.runtime.sendMessage({ type: "CONFIRM_RESPONSE", requestId, approved });
    clearPrompt();
  };
  yes.addEventListener("click", () => respond(true));
  no.addEventListener("click", () => respond(false));
  row.append(yes, no);
  promptEl.appendChild(row);
  setPopupOpen(true);
  yes.focus();
}

// A field the planner has no value for. The typed answer goes to the page through the
// background script; it is never sent to the server (see background/index.ts, ask_user).
function showAskUser(requestId: string, question: string): void {
  if (!promptEl) return;
  clearPrompt();
  promptEl.hidden = false;
  promptEl.classList.add("local");
  promptEl.appendChild(el("p", "prompt-title", question));
  const answer = el("input");
  answer.type = "text";
  answer.placeholder = "Your answer, kept in this browser";
  answer.setAttribute("aria-label", question);
  const row = el("div", "row");
  const fill = el("button", "btn go", "Fill it in");
  const skip = el("button", "btn quiet", "Skip");
  const respond = (value: string | null) => {
    chrome.runtime.sendMessage({ type: "ASK_USER_RESPONSE", requestId, answer: value });
    clearPrompt();
  };
  fill.addEventListener("click", () => respond(answer.value.trim() || null));
  answer.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      respond(answer.value.trim() || null);
    }
  });
  skip.addEventListener("click", () => respond(null));
  row.append(fill, skip);
  promptEl.append(answer, row);
  setPopupOpen(true);
  answer.focus();
}

function runTask(): void {
  if (!inputEl || activeRunId) return;
  const taskGoal = inputEl.value.trim();
  if (!taskGoal) return;
  inputEl.value = "";
  setRunning(true);
  setStatus("Reading the page and masking private data on this device", "running");

  chrome.runtime.sendMessage({ type: "RUN_TASK", taskGoal }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) {
      setRunning(false);
      setStatus(`Couldn't start: ${chrome.runtime.lastError?.message ?? response?.error ?? "unknown error"}`, "error");
      return;
    }
    activeRunId = response.runId as string;
  });
}

function openSidePanel(): void {
  chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" }).catch(() => undefined);
}

// Same broadcasts the side panel listens for. Background targets this tab directly with
// chrome.tabs.sendMessage, since content scripts don't receive runtime broadcasts.
export function handlePillMessage(message: {
  type: string;
  runId?: string;
  step?: number;
  status?: string;
  message?: string;
  reason?: string;
  requestId?: string;
  action?: NextActionResponse;
  riskTier?: RiskTier;
  redactionManifest?: RedactionEntry[];
  unfilledSensitiveTypes?: string[];
  question?: string;
}): void {
  if (message.runId !== activeRunId) return;
  if (message.type === "TASK_STEP") {
    const masked = message.redactionManifest?.length ?? 0;
    setStatus(`Step ${message.step}: ${message.status}${masked ? `. ${masked} masked` : ""}`, "running");
  } else if (message.type === "TASK_DONE") {
    setRunning(false);
    setStatus(message.message ?? "Done.", message.reason === "error" ? "error" : "idle");
    clearPrompt();
  } else if (message.type === "CONFIRM_REQUEST" && message.action && message.riskTier) {
    showConfirm(message.requestId!, message.action, message.riskTier, message.unfilledSensitiveTypes ?? []);
  } else if (message.type === "ASK_USER_REQUEST" && message.question) {
    showAskUser(message.requestId!, message.question);
  }
}

const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap { font: 400 13px/1.45 "Segoe UI", system-ui, sans-serif; color: #1b2230; }

  .pill {
    width: 46px; height: 46px; border-radius: 50%; border: 0; cursor: pointer;
    background: #1b2230; display: grid; place-items: center;
    box-shadow: 0 6px 18px rgba(27, 34, 48, 0.28);
    transition: opacity 300ms ease, transform 150ms ease-out;
  }
  .pill svg { width: 22px; height: 22px; }
  .pill.idle { opacity: 0.4; transform: scale(0.88); }
  .pill:hover, .pill:focus-visible { opacity: 1; transform: none; }
  .pill.running .mask-line { animation: scan 1.2s ease-in-out infinite; transform-origin: 7px 15px; }
  @keyframes scan { 50% { transform: scaleX(0.45); } }
  :focus-visible { outline: 2px solid #3d3bf3; outline-offset: 2px; }

  .popup {
    display: none; flex-direction: column; gap: 8px;
    position: absolute; bottom: 58px; right: 0; width: 288px;
    background: #fff; border: 1px solid #dce1e8; border-radius: 16px;
    padding: 12px; box-shadow: 0 18px 40px rgba(27, 34, 48, 0.18);
    transform-origin: bottom right;
  }
  .popup.open { display: flex; animation: pop 160ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
  .popup.closing { animation: unpop 150ms ease-in both; }
  @keyframes pop { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: none; } }
  @keyframes unpop { to { opacity: 0; transform: scale(0.96); } }

  .head { display: flex; justify-content: space-between; align-items: center; }
  .title { font-weight: 700; font-size: 14px; margin: 0; }
  .link { border: 0; background: none; color: #3d3bf3; font: inherit; font-size: 12px; cursor: pointer; padding: 4px; }
  .link:hover { text-decoration: underline; }

  textarea {
    resize: none; height: 58px; padding: 8px 10px; border-radius: 10px;
    border: 1.5px solid #dce1e8; background: #f3f5f8; font: inherit; color: inherit;
  }
  textarea:focus { outline: none; border-color: #3d3bf3; background: #fff; }

  .btn { border: 0; border-radius: 10px; padding: 8px 12px; font: inherit; font-weight: 600; cursor: pointer; }
  .btn.go { background: #1b2230; color: #fff; }
  .btn.go:hover:not(:disabled) { background: #000; }
  .btn.go:disabled { background: #c3c9d3; cursor: default; }
  .btn.quiet { background: transparent; color: #1b2230; box-shadow: inset 0 0 0 1.5px #dce1e8; }
  .row { display: flex; gap: 6px; }
  .row .btn { flex: 1; }

  .status { margin: 0; font-size: 12px; color: #5a6475; display: flex; gap: 6px; align-items: baseline; min-height: 1em; }
  .status:empty { display: none; }
  .status::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: #3d3bf3; flex: none; transform: translateY(-1px); }
  .status[data-state="running"]::before { animation: blink 1.2s ease-in-out infinite; }
  .status[data-state="error"] { color: #b42318; }
  .status[data-state="error"]::before { background: #b42318; }
  @keyframes blink { 50% { opacity: 0.3; } }

  .prompt { border-radius: 12px; padding: 10px; background: #fff4dc; display: flex; flex-direction: column; gap: 6px; }
  .prompt[hidden] { display: none; }
  .prompt.local { background: #ebebfe; }
  .prompt p { margin: 0; }
  .prompt-title { font-weight: 700; }
  .prompt input {
    padding: 7px 9px; border-radius: 8px; border: 1.5px solid #dce1e8; background: #fff; font: inherit; color: inherit;
  }
  .prompt input:focus { outline: none; border-color: #3d3bf3; }

  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

export function initPill(): void {
  if (shadowHost) return; // already injected (e.g. duplicate script run)

  shadowHost = document.createElement("div");
  shadowHost.id = "__fusion_privacy_pill_host__";
  shadowHost.style.cssText = "position:fixed;inset:auto 20px 20px auto;z-index:2147483647;";
  root = shadowHost.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = STYLE;
  const wrap = el("div", "wrap");

  pillEl = el("button", "pill");
  pillEl.setAttribute("aria-label", "Fusion Privacy Agent: ask it to do something on this page");
  pillEl.setAttribute("aria-expanded", "false");
  pillEl.title = "Fusion Privacy Agent";
  // the product glyph: a line of text and a masked line beneath it
  const ns = "http://www.w3.org/2000/svg";
  const glyph = document.createElementNS(ns, "svg");
  glyph.setAttribute("viewBox", "0 0 22 22");
  const line = document.createElementNS(ns, "rect");
  Object.entries({ x: "4", y: "6", width: "14", height: "3", rx: "1", fill: "#ffffff" }).forEach(([k, v]) => line.setAttribute(k, v));
  const mask = document.createElementNS(ns, "rect");
  Object.entries({ x: "4", y: "13", width: "10", height: "3.5", rx: "1", fill: "#8f8eff", class: "mask-line" }).forEach(([k, v]) =>
    mask.setAttribute(k, v)
  );
  glyph.append(line, mask);
  pillEl.appendChild(glyph);
  pillEl.addEventListener("click", () => setPopupOpen(!isOpen()));
  pillEl.addEventListener("mouseenter", wake);

  popupEl = el("div", "popup");
  popupEl.setAttribute("role", "dialog");
  popupEl.setAttribute("aria-label", "Fusion Privacy Agent");

  const head = el("div", "head");
  head.appendChild(el("p", "title", "Fusion Privacy Agent"));
  const expand = el("button", "link", "Open side panel");
  expand.addEventListener("click", openSidePanel);
  head.appendChild(expand);

  inputEl = el("textarea");
  inputEl.placeholder = "What should it do on this page?";
  inputEl.setAttribute("aria-label", "What should it do on this page?");
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      runTask();
    }
    if (e.key === "Escape") setPopupOpen(false);
  });

  sendBtn = el("button", "btn go", "Run on this page");
  sendBtn.addEventListener("click", runTask);

  statusEl = el("p", "status");
  statusEl.setAttribute("aria-live", "polite");

  promptEl = el("div", "prompt");
  promptEl.hidden = true;

  popupEl.append(head, inputEl, sendBtn, statusEl, promptEl);
  wrap.append(popupEl, pillEl);
  root.append(style, wrap);
  document.documentElement.appendChild(shadowHost);

  document.addEventListener("click", (e) => {
    if (!shadowHost || e.composedPath().includes(shadowHost)) return;
    setPopupOpen(false);
  });

  scheduleFade();
}
