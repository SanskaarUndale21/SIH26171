import type { NextActionResponse, RedactionEntry, RiskTier } from "../types";
import type { ExtensionMessage } from "../messages";

const messagesEl = document.getElementById("messages") as HTMLDivElement;
const goalInput = document.getElementById("goal") as HTMLTextAreaElement;
const sendButton = document.getElementById("send") as HTMLButtonElement;
const micButton = document.getElementById("mic") as HTMLButtonElement;
const voiceToggle = document.getElementById("voiceToggle") as HTMLButtonElement;

let activeRunId: string | null = null;
let activeThinkingEl: HTMLDivElement | null = null;
let pendingConfirmRespond: ((approved: boolean) => void) | null = null;
let voiceEnabled = true;

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

// Voice output. Uses the browser's built-in speechSynthesis -- no new dependency, and unlike
// speech recognition it runs fully client-side (no audio ever leaves the machine to produce
// it). Only step/done/confirm messages are spoken, not the redaction chip/JSON detail, since
// reading raw JSON aloud would be useless.
function speak(text: string): void {
  if (!voiceEnabled || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel(); // don't queue up stale utterances behind a fast-moving run
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  } catch {
    // best-effort; speech synthesis failures should never block the visible chat log
  }
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

function addConfirmPrompt(
  requestId: string,
  action: NextActionResponse,
  riskTier: RiskTier,
  unfilledSensitiveTypes: string[]
): void {
  const el = document.createElement("div");
  el.className = "msg agent";
  const label = document.createElement("div");
  let questionText = `This looks like a ${riskTier.replace("_", " ")} action: ${action.action}${
    action.target.selector ? ` on ${action.target.selector}` : ""
  }.`;
  // Real bug this closes: the agent correctly never fills password/email/card/phone (it
  // can't see their values), but was silently submitting anyway with them still empty and
  // calling the task done. Surfacing what's still redacted here gives the user an actual
  // chance to go fill those in before confirming, instead of finding out after the fact.
  if (unfilledSensitiveTypes.length > 0) {
    questionText += ` Note: ${unfilledSensitiveTypes.join(", ")} on this page were never filled in by the agent (by design) -- make sure you've filled them in yourself if this form needs them.`;
  }
  questionText += " Go ahead? You can say yes or no.";
  label.textContent = questionText;
  speak(questionText);
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
    if (pendingConfirmRespond === respond) pendingConfirmRespond = null;
  };
  pendingConfirmRespond = respond;

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
    speak(message.status);
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
    speak(message.message);
    return;
  }

  if (message.type === "CONFIRM_REQUEST") {
    if (message.runId !== activeRunId) return;
    activeThinkingEl?.remove();
    activeThinkingEl = null;
    addConfirmPrompt(message.requestId, message.action, message.riskTier, message.unfilledSensitiveTypes);
    return;
  }
});

// Voice input. SpeechRecognition is Chrome's built-in speech-to-text -- no new dependency --
// but it is NOT on-device: Chrome sends the audio to Google's speech recognition service to
// transcribe it, the same as using voice search. That's a real, separate data path from this
// project's redaction pipeline (which only ever concerns screen content, not microphone
// audio) and is standard browser behavior outside this extension's control, but it's worth
// being explicit about rather than implying "voice" is covered by the same privacy guarantee
// as the screen redaction. This could not be verified inside a real Chrome side panel in this
// environment (no live browser available while building it) -- if it fails to start at all,
// that is the most likely reason, not a logic bug here.
const SpeechRecognitionCtor: (new () => any) | undefined =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
let recognition: any = null;
let listening = false;

function setListening(value: boolean): void {
  listening = value;
  micButton.classList.toggle("listening", value);
}

function startListening(): void {
  if (!SpeechRecognitionCtor) {
    addMessage("error", "Voice input isn't available in this browser context.");
    return;
  }
  if (listening) {
    recognition?.stop();
    return;
  }

  recognition = new SpeechRecognitionCtor();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = false;

  recognition.onstart = () => setListening(true);
  recognition.onend = () => setListening(false);
  recognition.onerror = (event: any) => {
    setListening(false);
    addMessage("error", "Voice input error: " + (event?.error ?? "unknown"));
  };

  recognition.onresult = (event: any) => {
    let finalTranscript = "";
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalTranscript += transcript;
      else interim += transcript;
    }
    goalInput.value = (finalTranscript || interim).trim();
    autoGrow();

    if (!finalTranscript) return;
    const lower = finalTranscript.toLowerCase();

    if (pendingConfirmRespond) {
      if (/\b(yes|confirm|go ahead|do it|proceed)\b/.test(lower)) {
        pendingConfirmRespond(true);
        goalInput.value = "";
        return;
      }
      if (/\b(no|stop|cancel)\b/.test(lower)) {
        pendingConfirmRespond(false);
        goalInput.value = "";
        return;
      }
    }

    runTask();
  };

  recognition.start();
}

micButton.addEventListener("click", startListening);

voiceToggle.addEventListener("click", () => {
  voiceEnabled = !voiceEnabled;
  voiceToggle.classList.toggle("off", !voiceEnabled);
  if (!voiceEnabled) window.speechSynthesis?.cancel();
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

addMessage(
  "system",
  "Open a page, then tell it what to do -- type or press the mic. PII never leaves your browser unredacted. It works step by step, speaks its progress, and asks before submit/payment-style actions (say yes or no)."
);
