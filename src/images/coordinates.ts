import type { Box } from "../schemas/core.js";

export interface ImagePairTransform {
  expectedSize: { width: number; height: number };
  actualSize: { width: number; height: number };
  scaleExpectedToActualX: number;
  scaleExpectedToActualY: number;
  scaleActualToExpectedX: number;
  scaleActualToExpectedY: number;
}

export function createImagePairTransform(
  expectedSize: { width: number; height: number },
  actualSize: { width: number; height: number }
): ImagePairTransform {
  return {
    expectedSize,
    actualSize,
    scaleExpectedToActualX: actualSize.width / expectedSize.width,
    scaleExpectedToActualY: actualSize.height / expectedSize.height,
    scaleActualToExpectedX: expectedSize.width / actualSize.width,
    scaleActualToExpectedY: expectedSize.height / actualSize.height
  };
}

export function projectExpectedBoxToActualSource(box: Box, transform: ImagePairTransform): Box {
  return {
    x: box.x * transform.scaleExpectedToActualX,
    y: box.y * transform.scaleExpectedToActualY,
    width: box.width * transform.scaleExpectedToActualX,
    height: box.height * transform.scaleExpectedToActualY
  };
}

export function projectActualBoxToExpectedSource(box: Box, transform: ImagePairTransform): Box {
  return {
    x: box.x * transform.scaleActualToExpectedX,
    y: box.y * transform.scaleActualToExpectedY,
    width: box.width * transform.scaleActualToExpectedX,
    height: box.height * transform.scaleActualToExpectedY
  };
}
