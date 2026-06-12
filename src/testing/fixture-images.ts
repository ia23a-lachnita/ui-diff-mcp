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
