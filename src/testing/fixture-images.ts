import path from "node:path";
import sharp from "sharp";

export async function writeSolidPng(
  dir: string,
  filename: string,
  width: number,
  height: number,
  r: number,
  g: number,
  b: number
): Promise<string> {
  const outPath = path.join(dir, filename);
  await sharp({
    create: { width, height, channels: 3, background: { r, g, b } }
  })
    .png()
    .toFile(outPath);
  return outPath;
}

export async function writeRectPng(
  dir: string,
  filename: string,
  width: number,
  height: number,
  bgR: number,
  bgG: number,
  bgB: number,
  rectX: number,
  rectY: number,
  rectW: number,
  rectH: number,
  fgR: number,
  fgG: number,
  fgB: number
): Promise<string> {
  const outPath = path.join(dir, filename);
  const bg = await sharp({
    create: { width, height, channels: 3, background: { r: bgR, g: bgG, b: bgB } }
  })
    .png()
    .toBuffer();

  const rect = await sharp({
    create: { width: rectW, height: rectH, channels: 3, background: { r: fgR, g: fgG, b: fgB } }
  })
    .png()
    .toBuffer();

  await sharp(bg)
    .composite([{ input: rect, left: rectX, top: rectY }])
    .png()
    .toFile(outPath);

  return outPath;
}

export async function writeMismatchedDimensionFixture(
  dir: string,
  filenameExpected: string,
  filenameActual: string
): Promise<{ expected: string; actual: string }> {
  // expected 120x262, actual 108x240 — different aspect ratios trigger viewport mismatch
  const expected = await writeSolidPng(dir, filenameExpected, 120, 262, 220, 220, 220);
  const actual = await writeSolidPng(dir, filenameActual, 108, 240, 220, 220, 220);
  return { expected, actual };
}

export async function writeTwoButtonFixture(
  dir: string,
  filenameExpected: string,
  filenameActual: string
): Promise<{ expected: string; actual: string }> {
  const expected = await writeRectPng(
    dir, filenameExpected,
    200, 400,
    240, 240, 240,
    20, 50, 160, 44,
    0, 120, 255
  );
  const actual = await writeRectPng(
    dir, filenameActual,
    200, 400,
    240, 240, 240,
    20, 70, 160, 44,
    0, 120, 255
  );
  return { expected, actual };
}
