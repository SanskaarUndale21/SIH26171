import "./env-setup";
import {
  AutoProcessor,
  AutoModelForCausalLM,
  RawImage,
  type PreTrainedModel,
  type Processor
} from "@huggingface/transformers";
import type { BBox } from "../types";

// Microsoft Florence-2 (base, fine-tuned), ONNX export for in-browser captioning/grounding.
const MODEL_ID = "onnx-community/Florence-2-base-ft";

export interface GroundedPhrase {
  label: string;
  bbox: BBox;
}

interface FlorenceHandle {
  model: PreTrainedModel;
  processor: Processor;
}

let handlePromise: Promise<FlorenceHandle> | null = null;

async function getHandle(): Promise<FlorenceHandle> {
  if (!handlePromise) {
    handlePromise = (async () => {
      const processor = await AutoProcessor.from_pretrained(MODEL_ID);
      // "q8" matches the quantized onnx files actually bundled locally under
      // public/models/onnx-community/Florence-2-base-ft/onnx/ (*_quantized.onnx) -- fp32
      // would be ~4x larger for all four sub-modules (encoder, decoder, vision encoder,
      // embed tokens) and was never downloaded.
      const model = await AutoModelForCausalLM.from_pretrained(MODEL_ID, {
        dtype: "q8",
        device: "webgpu"
      });
      return { model, processor };
    })();
  }
  return handlePromise;
}

// Caption an image region, or ground a phrase ("caption to phrase grounding") over the
// whole screenshot to recover bounding boxes for elements the DOM/YOLO pass missed.
export async function groundElements(imageUrl: string, promptText = ""): Promise<GroundedPhrase[]> {
  const { model, processor } = await getHandle();
  const image = await RawImage.fromURL(imageUrl);

  const task = "<DENSE_REGION_CAPTION>";
  const prompt = promptText ? `<CAPTION_TO_PHRASE_GROUNDING>${promptText}` : task;

  const inputs = await (processor as any)(image, prompt);
  const generated = await model.generate({
    ...inputs,
    max_new_tokens: 256
  });

  const decoded = (processor as any).batch_decode(generated, { skip_special_tokens: false })[0];
  const parsed = (processor as any).post_process_generation(decoded, prompt.startsWith("<CAPTION_TO_PHRASE_GROUNDING>") ? "<CAPTION_TO_PHRASE_GROUNDING>" : task, image.size);

  const region = parsed?.[task] ?? parsed?.["<CAPTION_TO_PHRASE_GROUNDING>"];
  if (!region?.bboxes) return [];

  return region.bboxes.map((box: number[], i: number) => {
    const [x0, y0, x1, y1] = box;
    return {
      label: region.labels?.[i] ?? "element",
      bbox: [x0, y0, x1 - x0, y1 - y0] as BBox
    };
  });
}
