import "./env-setup";
import { pipeline as createPipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";

const pipeline: (
  task: string,
  model: string,
  options?: Record<string, unknown>
) => Promise<AutomaticSpeechRecognitionPipeline> = createPipeline as any;

// Whisper tiny (English), ONNX export, bundled locally under
// public/models/Xenova/whisper-tiny.en/ -- same "no first-run download" rule as the rest of
// the perception stack. This replaces the browser's built-in SpeechRecognition, which Chrome
// does not expose to chrome-extension:// origins at all (it silently returns undefined there,
// which is why voice input never worked from the side panel) and which, even where it does
// work, sends raw audio to Google's servers -- a data path this project's whole design argues
// against. Transcription here never leaves the device.
const MODEL_ID = "Xenova/whisper-tiny.en";

let pipelinePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

async function getPipeline(): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!pipelinePromise) {
    // dtype must match the files actually bundled (onnx/encoder_model_quantized.onnx,
    // onnx/decoder_model_merged_quantized.onnx) -- see ner.ts for why an unspecified/"auto"
    // dtype resolves to an unsuffixed fp32 file that was never downloaded.
    pipelinePromise = pipeline("automatic-speech-recognition", MODEL_ID, {
      device: "webgpu",
      dtype: "q8"
    });
  }
  return pipelinePromise;
}

// samples must be a single-channel Float32Array at 16kHz -- the sample rate Whisper was
// trained on. The caller (sidepanel.ts) decodes the recorded audio through an AudioContext
// created with that sample rate so no separate resampling step is needed here.
export async function transcribeAudio(samples: Float32Array): Promise<string> {
  const transcriber = await getPipeline();
  const output = await transcriber(samples);
  const first = Array.isArray(output) ? output[0] : output;
  return (first?.text ?? "").trim();
}
