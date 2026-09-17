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
let pendingAskUserRespond: ((answer: string | null) => void) | null = null;
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

// A field the planner has no value for -- asked directly instead of guessed. The typed
// answer goes straight to background -> EXECUTE_ACTION and is never sent to the server (see
// background/index.ts's ask_user branch); the chat log only ever shows the question, not
// anything about what gets typed back.
function addAskUserPrompt(requestId: string, question: string): void {
  const el = document.createElement("div");
  el.className = "msg agent";
  const label = document.createElement("div");
  label.textContent = question;
  speak(question);
  el.appendChild(label);

  const input = document.createElement("textarea");
  input.placeholder = "Type your answer... (never sent to the server)";
  input.style.cssText = "width:100%;margin-top:6px;height:36px;resize:none;border-radius:8px;border:1px solid #d1d5db;padding:6px;font-size:12px;font-family:inherit;";

  const row = document.createElement("div");
  row.style.display = "flex";
  row.style.gap = "6px";
  row.style.marginTop = "6px";

  const respond = (answer: string | null) => {
    chrome.runtime.sendMessage({ type: "ASK_USER_RESPONSE", requestId, answer });
    fillBtn.disabled = true;
    skipBtn.disabled = true;
    input.disabled = true;
    label.textContent += answer ? " (answered)" : " (skipped)";
    row.remove();
    if (pendingAskUserRespond === respond) pendingAskUserRespond = null;
  };
  pendingAskUserRespond = respond;

  const fillBtn = document.createElement("button");
  fillBtn.textContent = "Fill it in";
  fillBtn.style.cssText = "flex:1;padding:6px;border:none;border-radius:8px;background:#2563eb;color:#fff;cursor:pointer;font-size:12px;";
  fillBtn.addEventListener("click", () => respond(input.value.trim() || null));

  const skipBtn = document.createElement("button");
  skipBtn.textContent = "Skip";
  skipBtn.style.cssText = "flex:1;padding:6px;border:1px solid #d1d5db;border-radius:8px;background:#fff;cursor:pointer;font-size:12px;";
  skipBtn.addEventListener("click", () => respond(null));

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      respond(input.value.trim() || null);
    }
  });

  row.appendChild(fillBtn);
  row.appendChild(skipBtn);
  el.appendChild(input);
  el.appendChild(row);
  messagesEl.appendChild(el);
  input.focus();
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

  if (message.type === "ASK_USER_REQUEST") {
    if (message.runId !== activeRunId) return;
    activeThinkingEl?.remove();
    activeThinkingEl = null;
    addAskUserPrompt(message.requestId, message.question);
    return;
  }
});

// Voice input, push-to-talk: click to start recording, click again to stop and transcribe.
// This used to run on Chrome's built-in SpeechRecognition (webkitSpeechRecognition), which
// turned out to be a dead end on two counts -- Chrome does not expose that API to
// chrome-extension:// origins at all (it's undefined there), which is the actual reason voice
// input never worked from this side panel; and even where it does work, it sends raw audio to
// Google's servers, a separate data path this project's whole design argues against. This
// records locally via getUserMedia (a normal, universally-supported API, unlike
// SpeechRecognition) and transcribes with a small Whisper model running on-device in this
// same page (see perception/asr.ts) -- audio never leaves the browser.
let listening = false;
let mediaStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];

function setListening(value: boolean): void {
  listening = value;
  micButton.classList.toggle("listening", value);
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const out = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) out[i] += data[i] / buffer.numberOfChannels;
  }
  return out;
}

async function startRecording(): Promise<void> {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    addMessage("error", "Microphone access was denied or unavailable: " + String(err));
    return;
  }
  audioChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream);
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.start();
  setListening(true);
}

async function stopRecordingAndTranscribe(): Promise<void> {
  const recorder = mediaRecorder;
  if (!recorder) return;
  const mimeType = recorder.mimeType;
  const blob: Blob = await new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(audioChunks, { type: mimeType }));
    recorder.stop();
  });
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  mediaRecorder = null;
  setListening(false);

  const thinkingEl = addMessage("system", "Transcribing locally (first run downloads/loads the on-device model)...");
  try {
    const arrayBuffer = await blob.arrayBuffer();
    // Whisper expects mono audio at 16kHz -- creating the AudioContext with that sample rate
    // makes decodeAudioData resample to it, so no separate resampling step is needed.
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const decoded = await audioCtx.decodeAudioData(arrayBuffer);
    const samples = decoded.numberOfChannels > 1 ? mixToMono(decoded) : decoded.getChannelData(0);
    const { transcribeAudio } = await import("../perception/asr");
    const text = await transcribeAudio(samples);
    thinkingEl.remove();

    if (!text) {
      addMessage("error", "Didn't catch any speech in that recording -- try again.");
      return;
    }
    goalInput.value = text;
    autoGrow();

    const lower = text.toLowerCase();
    if (pendingAskUserRespond) {
      // Free-text answer, not a yes/no -- whatever was said is the value to fill in.
      pendingAskUserRespond(text || null);
      goalInput.value = "";
      return;
    }
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
  } catch (err) {
    thinkingEl.remove();
    addMessage("error", "Voice transcription failed: " + String(err));
  }
}

function toggleListening(): void {
  if (listening) {
    void stopRecordingAndTranscribe();
  } else {
    void startRecording();
  }
}

micButton.addEventListener("click", toggleListening);

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
