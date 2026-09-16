import { env } from "@huggingface/transformers";

// Keep the ONNX wasm runtime inside the packaged extension instead of fetching it from a
// CDN at runtime -- fewer external network dependencies, and it keeps working offline
// once models are cached.
env.allowLocalModels = false;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("assets/");
}
