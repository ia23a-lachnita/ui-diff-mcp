import { describe, expect, it } from "vitest";
import { extractImageCrop } from "../../src/images/crop.js";

describe("extractImageCrop", () => {
  it("extracts a 2x2 box from a 4x4 RGBA buffer preserving exact source pixels", () => {
    // 4x4 image with unique pixel values per row/col for easy verification
    const width = 4;
    const height = 4;
    const data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = x * 10;
        data[i + 1] = y * 10;
        data[i + 2] = 50;
        data[i + 3] = 255;
      }
    }

    // Extract box at x=1, y=1, width=2, height=2
    const box = { x: 1, y: 1, width: 2, height: 2 };
    const crop = extractImageCrop(data, width, height, box);

    expect(crop.length).toBe(2 * 2 * 4);
    // Pixel (0,0) of crop = source pixel (1,1): R=10, G=10, B=50, A=255
    expect(crop[0]).toBe(10);
    expect(crop[1]).toBe(10);
    expect(crop[2]).toBe(50);
    expect(crop[3]).toBe(255);
    // Pixel (1,0) of crop = source pixel (2,1): R=20, G=10, B=50, A=255
    expect(crop[4]).toBe(20);
    expect(crop[5]).toBe(10);
    // Pixel (0,1) of crop = source pixel (1,2): R=10, G=20
    expect(crop[8]).toBe(10);
    expect(crop[9]).toBe(20);
    // Pixel (1,1) of crop = source pixel (2,2): R=20, G=20
    expect(crop[12]).toBe(20);
    expect(crop[13]).toBe(20);
  });

  it("returns a 1-pixel fallback for a box with zero effective width", () => {
    const data = new Uint8Array(4 * 4 * 4);
    const crop = extractImageCrop(data, 4, 4, { x: 4, y: 0, width: 2, height: 2 });
    expect(crop.length).toBe(4);
  });
});
