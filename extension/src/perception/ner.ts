import "./env-setup";
import { pipeline as createPipeline, type TokenClassificationPipeline } from "@huggingface/transformers";

const pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<TokenClassificationPipeline> =
  createPipeline as any;

// Distilled BERT NER, ONNX export. Used as an extra signal over OCR'd text to catch
// PERSON entities (names) that plain regex cannot reliably find.
const MODEL_ID = "Xenova/bert-base-NER";

export interface NerEntity {
  type: "person_name" | "other";
  text: string;
  start: number;
  end: number;
  confidence: number;
}

let pipelinePromise: Promise<TokenClassificationPipeline> | null = null;

async function getPipeline(): Promise<TokenClassificationPipeline> {
  if (!pipelinePromise) {
    // dtype must be explicit and match a file actually bundled locally (see
    // public/models/Xenova/bert-base-NER/onnx/) -- "auto" or an unspecified default on
    // webgpu resolves to unsuffixed fp32, which was never downloaded, so the fetch to the
    // local model path would 404. "q8" maps to the bundled model_quantized.onnx.
    pipelinePromise = pipeline("token-classification", MODEL_ID, {
      device: "webgpu",
      dtype: "q8"
    });
  }
  return pipelinePromise;
}

export async function findNamedEntities(text: string): Promise<NerEntity[]> {
  if (!text.trim()) return [];
  const classifier = await getPipeline();
  const output = await classifier(text);
  const results = Array.isArray(output) ? output : [output];

  return results
    .filter((r: any) => r.entity?.includes("PER"))
    .map((r: any) => ({
      type: "person_name" as const,
      text: r.word,
      start: r.start ?? 0,
      end: r.end ?? 0,
      confidence: r.score
    }));
}
