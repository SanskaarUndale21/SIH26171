import { env } from "@huggingface/transformers";

// Every model this extension uses (NER, Florence-2) is bundled locally under
// public/models/<repo_id>/... at install time -- no first-run download, works fully offline.
// allowLocalModels must be true (it's transformers.js's flag for "may read from
// localModelPath", unrelated to the ONNX wasm runtime files below) and allowRemoteModels is
// off so a missing local file fails loudly instead of silently falling back to the network.
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = chrome.runtime.getURL("models/");

// Keep the ONNX wasm runtime inside the packaged extension instead of fetching it from a
// CDN at runtime -- fewer external network dependencies, and it keeps working offline.
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("assets/");
}
