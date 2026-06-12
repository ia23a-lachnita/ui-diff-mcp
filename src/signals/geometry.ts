import type { Box, NormalizedBox } from "../schemas/core.js";

export function area(box: Box): number {
  return box.width * box.height;
}

export function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

export function iou(a: Box, b: Box): number {
  const inter = intersect(a, b);
  if (!inter) return 0;
  const interArea = area(inter);
  const unionArea = area(a) + area(b) - interArea;
  if (unionArea === 0) return 0;
  return interArea / unionArea;
}

export function toNormalizedBox(box: Box, imageWidth: number, imageHeight: number): NormalizedBox {
  return {
    x: box.x / imageWidth,
    y: box.y / imageHeight,
    width: box.width / imageWidth,
    height: box.height / imageHeight
  };
}

export function fromNormalizedBox(nb: NormalizedBox, imageWidth: number, imageHeight: number): Box {
  return {
    x: nb.x * imageWidth,
    y: nb.y * imageHeight,
    width: nb.width * imageWidth,
    height: nb.height * imageHeight
  };
}

export function containsCenter(outer: Box, inner: Box): boolean {
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  return cx >= outer.x && cx <= outer.x + outer.width &&
         cy >= outer.y && cy <= outer.y + outer.height;
}

export function expandBox(box: Box, px: number, imageWidth: number, imageHeight: number): Box {
  const x = Math.max(0, box.x - px);
  const y = Math.max(0, box.y - px);
  const right = Math.min(imageWidth, box.x + box.width + px);
  const bottom = Math.min(imageHeight, box.y + box.height + px);
  return { x, y, width: right - x, height: bottom - y };
}
