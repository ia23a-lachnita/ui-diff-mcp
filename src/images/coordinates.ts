import type { Box } from "../schemas/core.js";

export type ImagePairMappingMode = "stretch" | "uniform_contain";

export interface ImagePairTransform {
  expectedSize: { width: number; height: number };
  actualSize: { width: number; height: number };
  mappingMode: ImagePairMappingMode;
  scaleExpectedToActualX: number;
  scaleExpectedToActualY: number;
  scaleActualToExpectedX: number;
  scaleActualToExpectedY: number;
  offsetExpectedToActualX: number;
  offsetExpectedToActualY: number;
  offsetActualToExpectedX: number;
  offsetActualToExpectedY: number;
  validRect: Box;
  rasterValidRect: Box;
}

export function createImagePairTransform(
  expectedSize: { width: number; height: number },
  actualSize: { width: number; height: number }
): ImagePairTransform {
  return {
    expectedSize,
    actualSize,
    mappingMode: "stretch",
    scaleExpectedToActualX: actualSize.width / expectedSize.width,
    scaleExpectedToActualY: actualSize.height / expectedSize.height,
    scaleActualToExpectedX: expectedSize.width / actualSize.width,
    scaleActualToExpectedY: expectedSize.height / actualSize.height,
    offsetExpectedToActualX: 0,
    offsetExpectedToActualY: 0,
    offsetActualToExpectedX: 0,
    offsetActualToExpectedY: 0,
    validRect: { x: 0, y: 0, width: expectedSize.width, height: expectedSize.height },
    rasterValidRect: { x: 0, y: 0, width: expectedSize.width, height: expectedSize.height }
  };
}

export function createUniformContainImagePairTransform(
  expectedSize: { width: number; height: number },
  actualSize: { width: number; height: number }
): ImagePairTransform {
  if (expectedSize.width <= 0 || expectedSize.height <= 0 || actualSize.width <= 0 || actualSize.height <= 0) {
    throw new Error("Image pair dimensions must be positive.");
  }

  const scaleByWidth = expectedSize.width / actualSize.width;
  const scaleByHeight = expectedSize.height / actualSize.height;
  const widthConstrained = scaleByWidth <= scaleByHeight;
  const scaleActualToExpected = widthConstrained ? scaleByWidth : scaleByHeight;
  const renderedWidth = widthConstrained
    ? expectedSize.width
    : actualSize.width * scaleActualToExpected;
  const renderedHeight = widthConstrained
    ? actualSize.height * scaleActualToExpected
    : expectedSize.height;
  const offsetActualToExpectedX = (expectedSize.width - renderedWidth) / 2;
  const offsetActualToExpectedY = (expectedSize.height - renderedHeight) / 2;
  const scaleExpectedToActual = 1 / scaleActualToExpected;
  const left = Math.ceil(offsetActualToExpectedX);
  const top = Math.ceil(offsetActualToExpectedY);
  const right = Math.floor(offsetActualToExpectedX + renderedWidth);
  const bottom = Math.floor(offsetActualToExpectedY + renderedHeight);

  return {
    expectedSize,
    actualSize,
    mappingMode: "uniform_contain",
    scaleExpectedToActualX: scaleExpectedToActual,
    scaleExpectedToActualY: scaleExpectedToActual,
    scaleActualToExpectedX: scaleActualToExpected,
    scaleActualToExpectedY: scaleActualToExpected,
    offsetExpectedToActualX: -offsetActualToExpectedX * scaleExpectedToActual,
    offsetExpectedToActualY: -offsetActualToExpectedY * scaleExpectedToActual,
    offsetActualToExpectedX,
    offsetActualToExpectedY,
    validRect: {
      x: offsetActualToExpectedX,
      y: offsetActualToExpectedY,
      width: renderedWidth,
      height: renderedHeight
    },
    rasterValidRect: {
      x: left,
      y: top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top)
    }
  };
}

export function projectExpectedBoxToActualSource(box: Box, transform: ImagePairTransform): Box {
  return {
    x: box.x * transform.scaleExpectedToActualX + transform.offsetExpectedToActualX,
    y: box.y * transform.scaleExpectedToActualY + transform.offsetExpectedToActualY,
    width: box.width * transform.scaleExpectedToActualX,
    height: box.height * transform.scaleExpectedToActualY
  };
}

export function projectActualBoxToExpectedSource(box: Box, transform: ImagePairTransform): Box {
  return {
    x: box.x * transform.scaleActualToExpectedX + transform.offsetActualToExpectedX,
    y: box.y * transform.scaleActualToExpectedY + transform.offsetActualToExpectedY,
    width: box.width * transform.scaleActualToExpectedX,
    height: box.height * transform.scaleActualToExpectedY
  };
}
