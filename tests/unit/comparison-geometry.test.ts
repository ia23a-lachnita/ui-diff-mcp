import { describe, expect, it } from "vitest";
import { createImagePairTransform, createUniformContainImagePairTransform, projectExpectedBoxToActualSource } from "../../src/images/coordinates.js";
import { resolveComparisonBox } from "../../src/images/comparison-geometry.js";
import { computeComparisonSpaceDelta } from "../../src/images/comparison-geometry.js";

const canvas = { width: 402, height: 874 };

describe("computeComparisonSpaceDelta", () => {
  it("compares equal boxes directly without a transform", () => {
    expect(computeComparisonSpaceDelta({
      expectedBox: { x: 10, y: 20, width: 30, height: 40 },
      actualBox: { x: 10, y: 20, width: 30, height: 40 }
    })).toMatchObject({ comparable: true, dx: 0, dy: 0, dw: 0, dh: 0, positionDeltaPx: 0, geometryDeltaPx: 0 });
  });

  it("compares stretch-mapped boxes in expected space", () => {
    const transform = createImagePairTransform({ width: 100, height: 100 }, { width: 200, height: 300 });
    const expectedBox = { x: 10, y: 20, width: 30, height: 40 };
    expect(computeComparisonSpaceDelta({ expectedBox, actualBox: projectExpectedBoxToActualSource(expectedBox, transform), transform })).toMatchObject({ comparable: true, geometryDeltaPx: 0 });
  });

  it("clips the uniform-contain full-width projection to the valid rectangle", () => {
    const transform = createUniformContainImagePairTransform({ width: 402, height: 874 }, { width: 1080, height: 2400 });
    expect(computeComparisonSpaceDelta({
      expectedBox: { x: 0, y: 0, width: 402, height: 874 },
      actualBox: { x: 0, y: 0, width: 1080, height: 2400 },
      transform
    })).toMatchObject({ comparable: true, dx: 0, dy: 0, dw: 0, dh: 0, positionDeltaPx: 0, geometryDeltaPx: 0 });
  });

  it("keeps genuine movement and resizing nonzero inside validRect", () => {
    const transform = createUniformContainImagePairTransform({ width: 402, height: 874 }, { width: 1080, height: 2400 });
    const expectedBox = { x: 100, y: 200, width: 80, height: 100 };
    const projected = projectExpectedBoxToActualSource(expectedBox, transform);
    const moved = computeComparisonSpaceDelta({
      expectedBox,
      actualBox: { ...projected, x: projected.x + 20 / transform.scaleActualToExpectedX },
      transform
    });
    expect(moved).toMatchObject({ comparable: true });
    if (moved.comparable) {
      expect(moved.dx).toBeCloseTo(20, 10);
      expect(moved.positionDeltaPx).toBeCloseTo(20, 10);
      expect(moved.geometryDeltaPx).toBeCloseTo(20, 10);
    }
    const resized = computeComparisonSpaceDelta({
      expectedBox,
      actualBox: { ...projected, width: projected.width + 15 / transform.scaleActualToExpectedX },
      transform
    });
    expect(resized).toMatchObject({ comparable: true });
    if (resized.comparable) {
      expect(resized.dx).toBeCloseTo(0, 10);
      expect(resized.dw).toBeCloseTo(15, 10);
      expect(resized.positionDeltaPx).toBeCloseTo(0, 10);
      expect(resized.geometryDeltaPx).toBeCloseTo(15, 10);
    }
  });

  it("uses edge deltas when movement and resizing combine", () => {
    const direct = computeComparisonSpaceDelta({
      expectedBox: { x: 10, y: 20, width: 30, height: 40 },
      actualBox: { x: 12, y: 20, width: 32, height: 40 }
    });
    expect(direct).toMatchObject({ comparable: true, dx: 2, dw: 2, geometryDeltaPx: 4 });

    const vertical = computeComparisonSpaceDelta({
      expectedBox: { x: 10, y: 20, width: 30, height: 40 },
      actualBox: { x: 10, y: 22, width: 30, height: 42 }
    });
    expect(vertical).toMatchObject({ comparable: true, dy: 2, dh: 2, geometryDeltaPx: 4 });

    const boundaryAdjacent = computeComparisonSpaceDelta({
      expectedBox: { x: 0, y: 10, width: 20, height: 20 },
      actualBox: { x: 1, y: 10, width: 19, height: 20 }
    });
    expect(boundaryAdjacent).toMatchObject({ comparable: true, dx: 1, dw: -1, geometryDeltaPx: 1 });
  });

  it("reports no comparable intersection outside the contain valid rectangle", () => {
    const transform = createUniformContainImagePairTransform({ width: 400, height: 800 }, { width: 1000, height: 1000 });
    expect(computeComparisonSpaceDelta({
      expectedBox: { x: 20, y: 20, width: 50, height: 50 },
      actualBox: { x: 50, y: 25, width: 125, height: 125 },
      transform
    })).toEqual({ comparable: false, coordinateSpace: "comparison_expected_normalized", reason: "no_comparable_intersection" });
  });
});

describe("resolveComparisonBox", () => {
  it("projects actual-source boxes into expected normalized comparison space", () => {
    const resolution = resolveComparisonBox({
      box: { x: 202, y: 402, width: 100, height: 200 },
      sourceSpace: "actual_normalized",
      canvas,
      transform: createImagePairTransform(canvas, { width: 804, height: 1748 })
    });

    expect(resolution).toEqual({
      status: "valid",
      box: { x: 101, y: 201, width: 50, height: 100 },
      clipped: false,
      coordinateSpace: "comparison_expected_normalized",
      sourceSpace: "actual_normalized"
    });
  });

  it("clips partially intersecting boxes at comparison canvas edges", () => {
    expect(resolveComparisonBox({
      box: { x: 398, y: 870, width: 10, height: 10 },
      sourceSpace: "comparison_expected_normalized",
      canvas
    })).toEqual({
      status: "valid",
      box: { x: 398, y: 870, width: 4, height: 4 },
      clipped: true,
      coordinateSpace: "comparison_expected_normalized",
      sourceSpace: "comparison_expected_normalized"
    });
  });

  it("preserves fractional actual-to-expected projection coordinates", () => {
    expect(resolveComparisonBox({
      box: { x: 150.75, y: 401.5, width: 3.75, height: 4.5 },
      sourceSpace: "actual_normalized",
      canvas,
      transform: createImagePairTransform(canvas, { width: 603, height: 1748 })
    })).toEqual({
      status: "valid",
      box: { x: 100.5, y: 200.75, width: 2.5, height: 2.25 },
      clipped: false,
      coordinateSpace: "comparison_expected_normalized",
      sourceSpace: "actual_normalized"
    });
  });

  it("uses continuous clipping around the 2x2 floor without rounding", () => {
    const fractionalCanvas = { width: 10, height: 10 };
    const accepted = resolveComparisonBox({
      box: { x: 7.999, y: 7.999, width: 5, height: 5 },
      sourceSpace: "comparison_expected_normalized",
      canvas: fractionalCanvas
    });
    expect(accepted).toMatchObject({ status: "valid", clipped: true });
    if (accepted.status === "valid") {
      expect(accepted.box).toMatchObject({ x: 7.999, y: 7.999 });
      expect(accepted.box.width).toBeCloseTo(2.001, 12);
      expect(accepted.box.height).toBeCloseTo(2.001, 12);
    }
    expect(resolveComparisonBox({
      box: { x: 8.001, y: 8.001, width: 5, height: 5 },
      sourceSpace: "comparison_expected_normalized",
      canvas: fractionalCanvas
    })).toEqual({
      status: "rejected",
      reason: "below_minimum_artifact_size",
      sourceSpace: "comparison_expected_normalized"
    });
  });

  it("rejects non-finite boxes", () => {
    expect(resolveComparisonBox({
      box: { x: Number.NaN, y: 0, width: 20, height: 20 },
      sourceSpace: "expected_normalized",
      canvas
    })).toEqual({
      status: "rejected",
      reason: "non_finite",
      sourceSpace: "expected_normalized"
    });
  });

  it("rejects non-positive dimensions", () => {
    expect(resolveComparisonBox({
      box: { x: 0, y: 0, width: 0, height: 20 },
      sourceSpace: "expected_normalized",
      canvas
    })).toEqual({
      status: "rejected",
      reason: "non_positive",
      sourceSpace: "expected_normalized"
    });
  });

  it("rejects boxes disjoint from the comparison canvas", () => {
    expect(resolveComparisonBox({
      box: { x: -10, y: 20, width: 8, height: 8 },
      sourceSpace: "expected_normalized",
      canvas
    })).toEqual({
      status: "rejected",
      reason: "disjoint",
      sourceSpace: "expected_normalized"
    });
  });

  it("rejects intersections below the two-pixel artifact minimum instead of accepting 1x1", () => {
    expect(resolveComparisonBox({
      box: { x: 401, y: 873, width: 1, height: 1 },
      sourceSpace: "expected_normalized",
      canvas
    })).toEqual({
      status: "rejected",
      reason: "below_minimum_artifact_size",
      sourceSpace: "expected_normalized"
    });
  });

  it.each([
    { minimumSize: { width: 1, height: 1 }, name: "lowered" },
    { minimumSize: { width: 0, height: 2 }, name: "non-positive" },
    { minimumSize: { width: Number.NaN, height: 2 }, name: "non-finite" }
  ])("rejects $name minimum-size overrides instead of bypassing the 2x2 floor", ({ minimumSize }) => {
    expect(resolveComparisonBox({
      box: { x: 10, y: 10, width: 2, height: 2 },
      sourceSpace: "expected_normalized",
      canvas,
      minimumSize
    })).toEqual({
      status: "rejected",
      reason: "below_minimum_artifact_size",
      sourceSpace: "expected_normalized"
    });
  });

  it("rejects non-finite and non-positive comparison canvases", () => {
    expect(resolveComparisonBox({
      box: { x: 10, y: 10, width: 10, height: 10 },
      sourceSpace: "expected_normalized",
      canvas: { width: Number.POSITIVE_INFINITY, height: 874 }
    })).toEqual({
      status: "rejected",
      reason: "non_finite",
      sourceSpace: "expected_normalized"
    });
    expect(resolveComparisonBox({
      box: { x: 10, y: 10, width: 10, height: 10 },
      sourceSpace: "expected_normalized",
      canvas: { width: 0, height: 874 }
    })).toEqual({
      status: "rejected",
      reason: "non_positive",
      sourceSpace: "expected_normalized"
    });
  });

  it("rejects non-finite intermediate intersection geometry", () => {
    expect(resolveComparisonBox({
      box: { x: Number.MAX_VALUE / 2, y: 0, width: Number.MAX_VALUE, height: 3 },
      sourceSpace: "expected_normalized",
      canvas: { width: Number.MAX_VALUE, height: 10 }
    })).toEqual({
      status: "rejected",
      reason: "non_finite",
      sourceSpace: "expected_normalized"
    });
  });

  it("is idempotent for canonical expected-space boxes", () => {
    const initial = resolveComparisonBox({
      box: { x: 100, y: 200, width: 50, height: 100 },
      sourceSpace: "expected_normalized",
      canvas
    });

    expect(initial).toMatchObject({ status: "valid", clipped: false });
    if (initial.status === "valid") {
      expect(resolveComparisonBox({
        box: initial.box,
        sourceSpace: initial.coordinateSpace,
        canvas
      })).toEqual({
        status: "valid",
        box: initial.box,
        clipped: false,
        coordinateSpace: "comparison_expected_normalized",
        sourceSpace: "comparison_expected_normalized"
      });
    }
  });
});
