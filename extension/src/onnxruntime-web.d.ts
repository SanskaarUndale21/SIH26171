// The pinned onnxruntime-web pre-release (matched to @huggingface/transformers' internal
// dependency, see perception/yolo.ts) ships types.d.ts but its package.json "exports" map
// has no "types" condition, so TypeScript's exports-respecting resolution can't find it.
// This is a minimal, accurate shim covering only the APIs this project actually calls.
declare module "onnxruntime-web" {
  export const env: {
    wasm: { wasmPaths: string };
  };

  export type TensorType = "float32" | "uint8" | "int32" | "int64" | "bool";

  export class Tensor {
    constructor(type: TensorType, data: Float32Array | Uint8Array | Int32Array | BigInt64Array, dims: readonly number[]);
    readonly dims: readonly number[];
    readonly data: Float32Array | Uint8Array | Int32Array | BigInt64Array;
  }

  export interface InferenceSessionOptions {
    executionProviders?: string[];
    [key: string]: unknown;
  }

  export class InferenceSession {
    static create(uriOrBuffer: string | ArrayBuffer, options?: InferenceSessionOptions): Promise<InferenceSession>;
    run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
    readonly inputNames: string[];
    readonly outputNames: string[];
  }
}
