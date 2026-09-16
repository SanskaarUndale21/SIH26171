import type { BBox, DetectedRegion } from "../types";

function iou(a: BBox, b: BBox): number {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x0 = Math.max(ax, bx);
  const y0 = Math.max(ay, by);
  const x1 = Math.min(ax + aw, bx + bw);
  const y1 = Math.min(ay + ah, by + bh);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

function unionBBox(a: BBox, b: BBox): BBox {
  const x0 = Math.min(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0] + a[2], b[0] + b[2]);
  const y1 = Math.max(a[1] + a[3], b[1] + b[3]);
  return [x0, y0, x1 - x0, y1 - y0];
}

// Below this, a lone vision-only detection is still redacted (fail-safe default: when in
// doubt, hide it) but is flagged low_confidence in the manifest for the transparency panel.
export const LOW_CONFIDENCE_THRESHOLD = 0.5;
const OVERLAP_MERGE_IOU = 0.3;

export interface FusedRegion extends DetectedRegion {
  agreeingSources: number;
  lowConfidence: boolean;
}

// Independent detectors agreeing on the same region is real signal: two weak-but-independent
// hits (e.g. regex text match + NER match landing on the same span) are combined with a
// noisy-OR, the standard way to fuse independent-probability estimates, rather than just
// keeping whichever fired first or averaging (which would incorrectly discount agreement).
function noisyOr(confidences: number[]): number {
  const productOfMisses = confidences.reduce((acc, c) => acc * (1 - c), 1);
  return 1 - productOfMisses;
}

export function fuseVisionConfidence(regions: DetectedRegion[]): FusedRegion[] {
  const used = new Array(regions.length).fill(false);
  const fused: FusedRegion[] = [];

  for (let i = 0; i < regions.length; i++) {
    if (used[i]) continue;
    const group = [regions[i]];
    used[i] = true;

    for (let j = i + 1; j < regions.length; j++) {
      if (used[j]) continue;
      if (regions[j].label !== regions[i].label) continue;
      if (iou(regions[i].bbox, regions[j].bbox) < OVERLAP_MERGE_IOU) continue;
      group.push(regions[j]);
      used[j] = true;
    }

    const confidence = noisyOr(group.map((r) => r.confidence));
    const bbox = group.reduce<BBox>((box, r) => (box ? unionBBox(box, r.bbox) : r.bbox), group[0].bbox);

    fused.push({
      label: regions[i].label,
      source: regions[i].source,
      bbox,
      confidence,
      agreeingSources: group.length,
      lowConfidence: confidence < LOW_CONFIDENCE_THRESHOLD
    });
  }

  return fused;
}
