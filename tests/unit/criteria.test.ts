import { describe, expect, it } from "vitest";
import { selectTriggeredCriteria, type TriggerContext } from "../../src/audit/criteria.js";

function ctx(overrides: Partial<TriggerContext> = {}): TriggerContext {
  return {
    pairingStatus: "matched",
    positionDeltaPx: 0,
    geometryDeltaPx: 0,
    comparisonComparable: true,
    textDelta: false,
    colorDelta: false,
    edgeMismatch: false,
    overlapDetected: false,
    stateWordsDiffer: false,
    elementType: "button",
    measurements: [],
    ...overrides
  };
}

describe("selectTriggeredCriteria", () => {
  it("uses comparison-space geometry and position thresholds independently", () => {
    expect(selectTriggeredCriteria(ctx({ geometryDeltaPx: 4, positionDeltaPx: 0 } as Partial<TriggerContext>))).toContain("geometry");
    expect(selectTriggeredCriteria(ctx({ geometryDeltaPx: 0, positionDeltaPx: 3 } as Partial<TriggerContext>))).toContain("spacing_alignment");
  });

  it("returns icon_image when edgeMismatch with icon type", () => {
    const result = selectTriggeredCriteria(ctx({ edgeMismatch: true, elementType: "icon" }));
    expect(result).toContain("icon_image");
  });

  it("returns layering_clipping when overlapDetected", () => {
    const result = selectTriggeredCriteria(ctx({ overlapDetected: true }));
    expect(result).toContain("layering_clipping");
  });

  it("returns component_state when stateWordsDiffer", () => {
    const result = selectTriggeredCriteria(ctx({ stateWordsDiffer: true }));
    expect(result).toContain("component_state");
  });

  it("returns chart_special_geometry for chart with edgeMismatch", () => {
    const result = selectTriggeredCriteria(ctx({ elementType: "chart", edgeMismatch: true }));
    expect(result).toContain("chart_special_geometry");
  });

  it("does not invent geometry when nothing triggered on a matched pair", () => {
    const result = selectTriggeredCriteria(ctx());
    expect(result).toEqual([]);
  });
});
