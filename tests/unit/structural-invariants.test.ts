import { describe, expect, it } from "vitest";
import {
  buildCandidateTerminalRecords,
  classifyStructuralRelation,
  freezeStructuralLedger,
  mapStructuralDecisionGroups,
  validateStructuralConsolidationLedger,
  type StructuralConsolidationLedger,
  type StructuralRelationInput,
  type StructuralRelationReason,
  type StructuralSuppressionDecision
} from "../../src/report/structural-invariants.js";
import { finalizeFindings } from "../../src/report/finding-consolidation.js";
import type { DiffRecord, UiElement } from "../../src/schemas/core.js";

const canvas = { width: 200, height: 400 };

function relation(overrides: Partial<StructuralRelationInput> = {}): StructuralRelationInput {
  return {
    parentFindingId: "parent",
    childFindingId: "child",
    parentElementId: "parent-element",
    childElementId: "child-element",
    criterion: "geometry",
    sameCriterion: true,
    semanticRelation: "descendant",
    parentBox: { x: 20, y: 40, width: 120, height: 120 },
    childBox: { x: 40, y: 60, width: 40, height: 40 },
    unionBox: { x: 20, y: 40, width: 120, height: 120 },
    canvas,
    parentAreaRatio: 0.18,
    unionAreaRatio: 0.18,
    childContainment: 1,
    parentMeasurement: { kind: "translation", x: 10, y: 10 },
    childMeasurement: { kind: "translation", x: 12, y: 12 },
    ...overrides
  };
}

const terminalCases: Array<[string, Partial<StructuralRelationInput>, StructuralRelationReason, string]> = [
  ["same finding", { parentFindingId: "same", childFindingId: "same" }, "same_finding", "unrelated"],
  ["unrelated ancestry", { semanticRelation: "unrelated" }, "no_semantic_relation", "unrelated"],
  ["sibling boundary", { semanticRelation: "sibling" }, "sibling_boundary", "retain_distinct"],
  ["different criterion", { sameCriterion: false, criterion: "color_appearance" }, "distinct_criterion", "retain_distinct"],
  ["oversized parent", { parentAreaRatio: 0.3 }, "oversized_parent", "retain_distinct"],
  ["nonlocal union", { unionAreaRatio: 0.2, childContainment: 0.69 }, "nonlocal", "retain_distinct"],
  ["distinct projection kind", { parentProjectionMismatchKind: "displaced", childProjectionMismatchKind: "absent_at_location" }, "distinct_projection_kind", "retain_distinct"],
  ["explicit group", { explicitFindingGroupId: "g1", explicitFindingGroupKind: "coherent_displacement" }, "equivalent_explicit_group", "suppress"],
  ["mixed measurement", { parentMeasurement: { kind: "mixed" } }, "invalid_measurement_relation", "violation"],
  ["invalid partial measurement", { parentMeasurement: { kind: "invalid", x: 2 } }, "invalid_measurement_relation", "violation"],
  ["independent geometry", { parentMeasurement: { kind: "translation", x: 4, y: 4 }, childMeasurement: { kind: "resize", width: 5, height: 5 } }, "independent_geometry", "retain_distinct"],
  ["coherent translation", {}, "coherent_translation", "suppress"],
  ["coherent resize", { parentMeasurement: { kind: "resize", width: 20, height: 20 }, childMeasurement: { kind: "resize", width: 23, height: 24 } }, "coherent_resize", "suppress"],
  ["missing nested measurement", { parentMeasurement: { kind: "none" }, childMeasurement: { kind: "none" } }, "unexplained_nested_same_criterion", "violation"]
];

describe("classifyStructuralRelation", () => {
  it.each(terminalCases)("returns the typed terminal for %s", (_name, overrides, reason, action) => {
    expect(classifyStructuralRelation(relation(overrides))).toMatchObject({ action, reason });
  });

  it("uses independent geometry for translation beyond tolerance or sign mismatch", () => {
    expect(classifyStructuralRelation(relation({ childMeasurement: { kind: "translation", x: 20, y: 12 } }))).toMatchObject({
      action: "retain_distinct",
      reason: "independent_geometry"
    });
    expect(classifyStructuralRelation(relation({ childMeasurement: { kind: "translation", x: -12, y: 12 } }))).toMatchObject({
      action: "retain_distinct",
      reason: "independent_geometry"
    });
  });
});

function malformedLedger(violation: string): StructuralConsolidationLedger {
  return {
    candidates: [
      { findingId: "child", criterion: "geometry", elementIds: ["child-element"] },
      { findingId: "parent", criterion: "geometry", elementIds: ["parent-element"] }
    ],
    elementLineage: violation === "sibling_boundary"
      ? [{ elementId: "child-element", parentId: "root-element" }, { elementId: "parent-element", parentId: "root-element" }, { elementId: "root-element" }]
      : [{ elementId: "child-element", parentId: "parent-element" }, { elementId: "parent-element", parentId: "root-element" }, { elementId: "root-element" }],
    retainedFindingIds: ["parent"],
    candidateTerminals: [],
    decisions: [{
      suppressedFindingId: violation === "missing_retained_lineage" ? "missing" : "child",
      retainedFindingId: "parent",
      parentElementId: "parent-element",
      childElementId: "child-element",
      criterion: "geometry",
      sameCriterion: violation !== "distinct_criterion",
      semanticDescendant: violation !== "sibling_boundary",
      semanticRelation: violation === "sibling_boundary" ? "sibling" : "descendant",
      parentAreaRatio: violation === "oversized_parent" ? 0.3 : 0.1,
      locality: violation === "sibling_boundary" ? 0.1 : 0.1,
      childContainment: 1,
      parentMeasurement: violation === "invalid_measurement_relation" ? { kind: "invalid" } : violation === "unexplained_nested_same_criterion" ? { kind: "none" } : { kind: "translation", x: 10, y: 10 },
      childMeasurement: violation === "unexplained_nested_same_criterion" ? { kind: "none" } : { kind: "translation", x: 10, y: 10 },
      displacementRelation: "coherent_translation",
      measurementRelation: violation === "invalid_measurement_relation" ? "missing_measurement" : "coherent_translation",
      action: "suppress",
      reason: violation === "unexplained_nested_same_criterion"
        ? "unexplained_nested_same_criterion"
        : violation === "oversized_parent" || violation === "sibling_boundary"
          ? violation
          : violation === "invalid_measurement_relation"
            ? "invalid_measurement_relation"
          : "coherent_translation",
      retainedGroupIds: violation === "ambiguous_retained_group" ? ["g1", "g2"] : violation === "missing_retained_group" ? [] : ["g1"]
    }]
  };
}

describe("validateStructuralConsolidationLedger", () => {
  it.each([
    "missing_retained_lineage",
    "unexplained_nested_same_criterion",
    "oversized_parent",
    "sibling_boundary",
    "invalid_measurement_relation",
    "missing_retained_group",
    "ambiguous_retained_group"
  ])("reports malformed ledger violation %s", violation => {
    const result = validateStructuralConsolidationLedger(malformedLedger(violation), { requireGroups: true });
    expect(result.status).toBe("fail");
    expect(result.violations.map(item => item.code)).toContain(violation);
  });

  it("passes a valid lineage ledger and preserves no-candidate pass", () => {
    expect(validateStructuralConsolidationLedger({ candidates: [], decisions: [], retainedFindingIds: [], candidateTerminals: [] })).toEqual({
      status: "pass",
      violations: []
    });
    expect(validateStructuralConsolidationLedger({
      candidates: [
        { findingId: "child", criterion: "geometry", elementIds: ["child-element"] },
        { findingId: "parent", criterion: "geometry", elementIds: ["parent-element"] }
      ],
      elementLineage: [{ elementId: "child-element", parentId: "parent-element" }, { elementId: "parent-element" }],
      retainedFindingIds: ["parent"],
      decisions: [{
        action: "suppress",
        suppressedFindingId: "child",
        retainedFindingId: "parent",
        parentElementId: "parent-element",
        childElementId: "child-element",
        criterion: "geometry",
        sameCriterion: true,
        semanticDescendant: true,
        semanticRelation: "descendant",
        parentAreaRatio: 0.1,
        locality: 0.1,
        childContainment: 1,
        parentMeasurement: { kind: "translation", x: 10, y: 10 },
        childMeasurement: { kind: "translation", x: 10, y: 10 },
        displacementRelation: "coherent_translation",
        measurementRelation: "coherent_translation",
        reason: "coherent_translation",
        retainedGroupIds: ["g1"]
      }],
      candidateTerminals: [
        { candidateId: "child", terminal: "suppressed_to_retained", retainedFindingId: "parent" },
        { candidateId: "parent", terminal: "retained" }
      ]
    })).toEqual({ status: "pass", violations: [] });
  });

  it("fails the synthetic 146-candidate/75-group ledger when retained group lineage is absent", () => {
    const candidates = Array.from({ length: 146 }, (_, index) => ({ findingId: `finding-${index}`, criterion: "geometry" }));
    const retainedFindingIds = candidates.slice(0, 75).map(candidate => candidate.findingId);
    const decisions = candidates.slice(75).map((candidate, index) => ({
      action: "suppress" as const,
      reason: "coherent_translation" as const,
      suppressedFindingId: candidate.findingId,
      retainedFindingId: retainedFindingIds[index % retainedFindingIds.length]!,
      criterion: "geometry",
      sameCriterion: true,
      semanticDescendant: true,
      parentAreaRatio: 0.1,
      locality: 0.1,
      displacementRelation: "coherent_translation" as const,
      measurementRelation: "coherent_translation" as const
    , semanticRelation: "descendant" as const,
      childContainment: 1,
      parentMeasurement: { kind: "translation" as const, x: 10, y: 10 },
      childMeasurement: { kind: "translation" as const, x: 10, y: 10 }
    }));
    const candidateTerminals = candidates.map((candidate, index) => index < 75
      ? { candidateId: candidate.findingId, terminal: "retained" as const }
      : { candidateId: candidate.findingId, terminal: "suppressed_to_retained" as const, retainedFindingId: retainedFindingIds[index % retainedFindingIds.length]! });
    const result = validateStructuralConsolidationLedger({ candidates, retainedFindingIds, decisions, candidateTerminals }, { requireGroups: true });
    expect(candidates).toHaveLength(146);
    expect(retainedFindingIds).toHaveLength(75);
    expect(result.status).toBe("fail");
    expect(result.violations.map(item => item.code)).toContain("missing_retained_group");
  });

  it.each([
    ["sibling boundary", { semanticDescendant: false, sameCriterion: true, parentAreaRatio: 0.1, locality: 0.1, childContainment: 1 }, "sibling_boundary"],
    ["oversized parent", { semanticDescendant: true, sameCriterion: true, parentAreaRatio: 0.3, locality: 0.1, childContainment: 1 }, "oversized_parent"],
    ["nonlocal child", { semanticDescendant: true, sameCriterion: true, parentAreaRatio: 0.1, locality: 0.1, childContainment: 0.69 }, "oversized_parent"],
    ["different criterion", { semanticDescendant: true, sameCriterion: false, parentAreaRatio: 0.1, locality: 0.1, childContainment: 1 }, "missing_retained_lineage"]
  ])("validates forged suppress facts independently for %s", (_name, facts, expectedReason) => {
    const result = validateStructuralConsolidationLedger({
      candidates: [
        { findingId: "child", criterion: "geometry", elementIds: ["child-element"] },
        { findingId: "parent", criterion: "geometry", elementIds: ["parent-element"] }
      ],
      elementLineage: facts.semanticDescendant
        ? [{ elementId: "child-element", parentId: "parent-element" }, { elementId: "parent-element" }]
        : [{ elementId: "child-element", parentId: "root-element" }, { elementId: "parent-element", parentId: "root-element" }, { elementId: "root-element" }],
      retainedFindingIds: ["parent"],
      decisions: [{
        action: "suppress",
        reason: "coherent_translation",
        suppressedFindingId: "child",
        retainedFindingId: "parent",
        criterion: "geometry",
        sameCriterion: facts.sameCriterion,
        semanticDescendant: facts.semanticDescendant,
        parentAreaRatio: facts.parentAreaRatio,
        locality: facts.locality,
        childContainment: facts.childContainment,
        semanticRelation: facts.semanticDescendant ? "descendant" : "sibling",
        parentMeasurement: { kind: "translation", x: 10, y: 10 },
        childMeasurement: { kind: "translation", x: 10, y: 10 },
        displacementRelation: "coherent_translation",
        measurementRelation: "coherent_translation"
      }],
      candidateTerminals: [
        { candidateId: "child", terminal: "suppressed_to_retained", retainedFindingId: "parent" },
        { candidateId: "parent", terminal: "retained" }
      ]
    });
    expect(result.status).toBe("fail");
    expect(result.violations.map(item => item.code)).toContain(expectedReason);
    expect(result.violations[0]).toMatchObject({ suppressedFindingId: "child", retainedFindingId: "parent" });
  });

  it("returns frozen structured violations and defers group mapping in Task 7A", () => {
    const result = validateStructuralConsolidationLedger({
      candidates: [
        { findingId: "child", criterion: "geometry", elementIds: ["child-element"] },
        { findingId: "parent", criterion: "geometry", elementIds: ["parent-element"] }
      ],
      elementLineage: [{ elementId: "child-element", parentId: "parent-element" }, { elementId: "parent-element" }],
      retainedFindingIds: ["parent"],
      decisions: [{
        action: "suppress",
        reason: "coherent_translation",
        suppressedFindingId: "child",
        retainedFindingId: "parent",
        criterion: "geometry",
        sameCriterion: true,
        semanticDescendant: true,
        semanticRelation: "descendant",
        parentAreaRatio: 0.1,
        locality: 0.1,
        childContainment: 1,
        parentMeasurement: { kind: "translation", x: 10, y: 10 },
        childMeasurement: { kind: "translation", x: 10, y: 10 },
        displacementRelation: "coherent_translation",
        measurementRelation: "coherent_translation"
      }],
      candidateTerminals: [
        { candidateId: "child", terminal: "suppressed_to_retained", retainedFindingId: "parent" },
        { candidateId: "parent", terminal: "retained" }
      ]
    });
    expect(result).toEqual({ status: "pass", violations: [] });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.violations)).toBe(true);
  });

  it("sorts ledger collections deterministically and preserves byte-equivalent permutations", () => {
    const base = {
      candidates: [{ findingId: "z", criterion: "geometry" }, { findingId: "a", criterion: "geometry" }],
      retainedFindingIds: ["z", "a"],
      decisions: [],
      candidateTerminals: []
    } as const;
    const reversed = {
      candidates: [...base.candidates].reverse(),
      retainedFindingIds: [...base.retainedFindingIds].reverse(),
      decisions: [],
      candidateTerminals: []
    } as const;
    expect(JSON.stringify(freezeStructuralLedger(base))).toBe(JSON.stringify(freezeStructuralLedger(reversed)));
  });
});

describe("finalizeFindings structural ledger", () => {
  it("returns an immutable pre-candidate-to-final ledger", () => {
    const finding: DiffRecord = {
      id: "single",
      criterion: "geometry",
      severity: "medium",
      title: "single",
      location: { x: 10, y: 10, width: 20, height: 20 },
      evidence: ["evidence"],
      measurements: [],
      artifactPaths: [],
      reviewerStatus: "accepted"
    };
    const result = finalizeFindings([finding], [], [], { canvas });
    expect(result.structuralLedger.candidates.map(candidate => candidate.findingId)).toEqual(["single"]);
    expect(result.structuralLedger.retainedFindingIds).toEqual(["single"]);
    expect(Object.isFrozen(result.structuralLedger)).toBe(true);
    expect(Object.isFrozen(result.structuralLedger.candidates)).toBe(true);
    expect(Object.isFrozen(result.structuralLedger.decisions)).toBe(true);
  });

  it("records typed suppression lineage while finalizing a nested coherent pair", () => {
    const parentElement: UiElement = {
      id: "parent-element",
      label: "parent",
      type: "card",
      box: { x: 20, y: 40, width: 120, height: 120 },
      normalizedBox: { x: 0.1, y: 0.1, width: 0.6, height: 0.3 },
      confidence: 0.9,
      source: "locator",
      childIds: ["child-element"]
    };
    const childElement: UiElement = {
      id: "child-element",
      label: "child",
      type: "text",
      box: { x: 40, y: 60, width: 40, height: 40 },
      normalizedBox: { x: 0.2, y: 0.15, width: 0.2, height: 0.1 },
      confidence: 0.9,
      source: "locator",
      parentId: "parent-element",
      childIds: []
    };
    const base = (id: string, targetId: string, location: DiffRecord["location"]): DiffRecord => ({
      id,
      pairId: `pair-${id}`,
      criterion: "geometry",
      severity: "medium",
      title: id,
      location,
      evidence: [id],
      measurements: [{ name: "deltaX", value: 10, unit: "px" }, { name: "deltaY", value: 10, unit: "px" }],
      artifactPaths: [],
      targetIds: [targetId],
      reviewerStatus: "accepted"
    });
    const result = finalizeFindings(
      [base("parent", parentElement.id, parentElement.box), base("child", childElement.id, childElement.box)],
      [parentElement, childElement],
      [
        { id: "pair-parent", expectedId: parentElement.id, status: "matched", score: 1, reasons: [] },
        { id: "pair-child", expectedId: childElement.id, status: "matched", score: 1, reasons: [] }
      ],
      { canvas }
    );
    expect(result.structuralLedger.candidates.map(candidate => candidate.findingId)).toEqual(["child", "parent"]);
    expect(result.structuralLedger.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        suppressedFindingId: "child",
        retainedFindingId: "parent",
        reason: "coherent_translation",
        semanticDescendant: true
      })
    ]));
  });

  it("accounts for every original candidate exactly once and labels broad findings explicitly", () => {
    const make = (id: string, location: DiffRecord["location"]): DiffRecord => ({
      id,
      criterion: "geometry",
      severity: "medium",
      title: id,
      location,
      evidence: [id],
      measurements: [{ name: "deltaX", value: 10, unit: "px" }, { name: "deltaY", value: 10, unit: "px" }],
      artifactPaths: [],
      reviewerStatus: "accepted",
      ...(id === "broad" ? { repairLocality: "broad" as const, classificationSource: "vlm_reviewed" as const } : {})
    });
    const parent = make("parent", { x: 20, y: 40, width: 120, height: 120 });
    parent.targetIds = ["parent-element"];
    const child = make("child", { x: 40, y: 60, width: 40, height: 40 });
    child.targetIds = ["child-element"];
    const broad = make("broad", { x: 0, y: 0, width: 200, height: 400 });
    const parentElement: UiElement = {
      id: "parent-element", label: "parent", type: "card", box: parent.location,
      normalizedBox: { x: 0.1, y: 0.1, width: 0.6, height: 0.3 }, confidence: 0.9, source: "locator", childIds: ["child-element"]
    };
    const childElement: UiElement = {
      id: "child-element", label: "child", type: "text", box: child.location,
      normalizedBox: { x: 0.2, y: 0.15, width: 0.2, height: 0.1 }, confidence: 0.9, source: "locator", parentId: "parent-element", childIds: []
    };
    const result = finalizeFindings([parent, child, broad], [parentElement, childElement], [
      { id: "pair-parent", expectedId: "parent-element", status: "matched", score: 1, reasons: [] },
      { id: "pair-child", expectedId: "child-element", status: "matched", score: 1, reasons: [] }
    ], { canvas });
    const terminals = result.structuralLedger.candidateTerminals;
    expect(terminals.map(item => item.candidateId)).toEqual(["broad", "child", "parent"]);
    expect(terminals.map(item => item.terminal)).toEqual(["broad_excluded", "suppressed_to_retained", "retained"]);
    expect(new Set(terminals.map(item => item.candidateId)).size).toBe(3);
  });
});

function accountingDecision(overrides: Partial<StructuralSuppressionDecision> = {}): StructuralSuppressionDecision {
  return {
    action: "suppress",
    reason: "coherent_translation",
    suppressedFindingId: "child",
    retainedFindingId: "parent",
    criterion: "geometry",
    sameCriterion: true,
    semanticDescendant: true,
    semanticRelation: "descendant",
    parentAreaRatio: 0.1,
    locality: 0.1,
    childContainment: 1,
    parentMeasurement: { kind: "translation", x: 10, y: 10 },
    childMeasurement: { kind: "translation", x: 10, y: 10 },
    displacementRelation: "coherent_translation",
    measurementRelation: "coherent_translation",
    ...overrides
  };
}

describe("Task 7A decision-aware accounting", () => {
  const candidates = [
    { findingId: "child", criterion: "geometry" },
    { findingId: "parent", criterion: "geometry" }
  ] as const;

  it("builds suppressed_to_retained only from exactly one matching suppress decision", () => {
    const result = buildCandidateTerminalRecords({
      candidates,
      retainedFindingIds: ["parent"],
      removedLineage: [{ candidateId: "child", retainedFindingIds: ["parent"] }],
      decisions: [accountingDecision()]
    } as never);
    expect(result).toEqual([
      { candidateId: "child", terminal: "suppressed_to_retained", retainedFindingId: "parent" },
      { candidateId: "parent", terminal: "retained" }
    ]);
  });

  it.each([
    ["retain_distinct", { action: "retain_distinct" as const, reason: "independent_geometry" as const }],
    ["unrelated", { action: "unrelated" as const, reason: "no_semantic_relation" as const }],
    ["violation", { action: "violation" as const, reason: "invalid_measurement_relation" as const }],
    ["mismatched retained ID", { retainedFindingId: "other" }],
    ["duplicate decision", {}, {}]
  ])("marks removed candidate %s as a violation", (_label, override, duplicate = undefined) => {
    const decisions = [accountingDecision(override as Partial<StructuralSuppressionDecision>)];
    if (duplicate !== undefined) decisions.push(accountingDecision());
    const result = buildCandidateTerminalRecords({
      candidates,
      retainedFindingIds: ["parent"],
      removedLineage: [{ candidateId: "child", retainedFindingIds: ["parent"] }],
      decisions
    } as never);
    expect(result[0]).toMatchObject({ candidateId: "child", terminal: "violation" });
  });

  it("records broad exclusion only for eligible VLM evidence", () => {
    const result = buildCandidateTerminalRecords({
      candidates: [{ findingId: "broad", criterion: "geometry", classificationSource: "vlm_reviewed", repairLocality: "broad" }],
      retainedFindingIds: [],
      broadExcludedIds: ["broad"],
      removedLineage: [],
      decisions: []
    } as never);
    expect(result).toEqual([{
      candidateId: "broad",
      terminal: "broad_excluded",
      exclusionReason: "broad_vlm_evidence"
    }]);
  });

  it("fails bidirectional accounting inconsistencies", () => {
    const base = {
      candidates,
      retainedFindingIds: ["parent"],
      candidateTerminals: [
        { candidateId: "child", terminal: "suppressed_to_retained", retainedFindingId: "other" },
        { candidateId: "child", terminal: "retained" },
        { candidateId: "parent", terminal: "retained" },
        { candidateId: "unknown", terminal: "retained" }
      ],
      decisions: [accountingDecision(), accountingDecision()]
    } satisfies StructuralConsolidationLedger;
    const result = validateStructuralConsolidationLedger(base);
    expect(result.status).toBe("fail");
    expect(result.violations.map(violation => violation.detail?.accountingIssue)).toEqual(expect.arrayContaining([
      "duplicate_terminal",
      "unknown_terminal",
      "duplicate_decision",
      "suppressed_mismatched_decision"
    ]));
  });

  it("rejects forged broad terminals and retained IDs without exact terminal accounting", () => {
    const result = validateStructuralConsolidationLedger({
      candidates: [{ findingId: "broad", criterion: "geometry" }],
      retainedFindingIds: ["broad", "ghost"],
      candidateTerminals: [{ candidateId: "broad", terminal: "broad_excluded", exclusionReason: "broad_vlm_evidence" }],
      decisions: []
    });
    expect(result.status).toBe("fail");
    expect(result.violations.map(violation => violation.detail?.accountingIssue)).toEqual(expect.arrayContaining([
      "broad_ineligible",
      "retained_id_without_candidate"
    ]));
  });

  it.each([
    ["duplicate_candidate", {
      candidates: [...candidates, { findingId: "child", criterion: "geometry" }],
      retainedFindingIds: ["parent"],
      candidateTerminals: [
        { candidateId: "child", terminal: "violation" as const },
        { candidateId: "parent", terminal: "retained" as const }
      ],
      decisions: []
    }],
    ["unknown_terminal", {
      candidates,
      retainedFindingIds: ["parent"],
      candidateTerminals: [
        { candidateId: "unknown", terminal: "retained" as const },
        { candidateId: "child", terminal: "violation" as const },
        { candidateId: "parent", terminal: "retained" as const }
      ],
      decisions: []
    }],
    ["duplicate_terminal", {
      candidates,
      retainedFindingIds: ["parent"],
      candidateTerminals: [
        { candidateId: "child", terminal: "violation" as const },
        { candidateId: "child", terminal: "retained" as const },
        { candidateId: "parent", terminal: "retained" as const }
      ],
      decisions: []
    }],
    ["retained_terminal_not_retained", {
      candidates,
      retainedFindingIds: ["parent"],
      candidateTerminals: [
        { candidateId: "child", terminal: "retained" as const },
        { candidateId: "parent", terminal: "retained" as const }
      ],
      decisions: []
    }],
    ["retained_id_without_terminal", {
      candidates,
      retainedFindingIds: ["parent"],
      candidateTerminals: [{ candidateId: "child", terminal: "violation" as const }],
      decisions: []
    }],
    ["suppressed_missing_decision", {
      candidates,
      retainedFindingIds: ["parent"],
      candidateTerminals: [
        { candidateId: "child", terminal: "suppressed_to_retained" as const, retainedFindingId: "parent" },
        { candidateId: "parent", terminal: "retained" as const }
      ],
      decisions: []
    }],
    ["decision_for_retained_candidate", {
      candidates,
      retainedFindingIds: ["child", "parent"],
      candidateTerminals: [
        { candidateId: "child", terminal: "retained" as const },
        { candidateId: "parent", terminal: "retained" as const }
      ],
      decisions: [accountingDecision()]
    }],
    ["unknown_decision_id", {
      candidates: [{ findingId: "parent", criterion: "geometry" }],
      retainedFindingIds: ["parent"],
      candidateTerminals: [{ candidateId: "parent", terminal: "retained" as const }],
      decisions: [accountingDecision({ suppressedFindingId: "unknown" })]
    }],
    ["broad_has_retained", {
      candidates: [{ findingId: "broad", criterion: "geometry", classificationSource: "vlm_reviewed" as const, repairLocality: "broad" as const }],
      retainedFindingIds: ["broad"],
      candidateTerminals: [{ candidateId: "broad", terminal: "broad_excluded" as const, exclusionReason: "broad_vlm_evidence" as const }],
      decisions: []
    }],
    ["broad_has_retained", {
      candidates: [{ findingId: "broad", criterion: "geometry", classificationSource: "vlm_reviewed" as const, repairLocality: "broad" as const }],
      retainedFindingIds: ["broad"],
      candidateTerminals: [{ candidateId: "broad", terminal: "retained" as const }],
      decisions: []
    }],
    ["broad_has_decision", {
      candidates: [
        { findingId: "broad", criterion: "geometry", classificationSource: "vlm_reviewed" as const, repairLocality: "broad" as const },
        { findingId: "parent", criterion: "geometry" }
      ],
      retainedFindingIds: ["parent"],
      candidateTerminals: [
        { candidateId: "broad", terminal: "broad_excluded" as const, exclusionReason: "broad_vlm_evidence" as const },
        { candidateId: "parent", terminal: "retained" as const }
      ],
      decisions: [accountingDecision({ suppressedFindingId: "broad" })]
    }],
    ["terminal_violation", {
      candidates,
      retainedFindingIds: ["parent"],
      candidateTerminals: [
        { candidateId: "child", terminal: "violation" as const, violationCode: "missing_retained_lineage" as const },
        { candidateId: "parent", terminal: "retained" as const }
      ],
      decisions: []
    }]
  ])("reports exact bidirectional accounting issue %s", (_issue, ledger) => {
    const result = validateStructuralConsolidationLedger(ledger);
    expect(result.status).toBe("fail");
    expect(result.violations.map(violation => violation.detail?.accountingIssue)).toContain(_issue);
  });

  it("reports a mismatched retained ID and duplicate decision independently", () => {
    const result = validateStructuralConsolidationLedger({
      candidates: [
        { findingId: "child", criterion: "geometry" },
        { findingId: "parent", criterion: "geometry" },
        { findingId: "other", criterion: "geometry" }
      ],
      retainedFindingIds: ["parent", "other"],
      candidateTerminals: [
        { candidateId: "child", terminal: "suppressed_to_retained", retainedFindingId: "parent" },
        { candidateId: "parent", terminal: "retained" },
        { candidateId: "other", terminal: "retained" }
      ],
      decisions: [accountingDecision({ retainedFindingId: "other" }), accountingDecision()]
    });
    expect(result.status).toBe("fail");
    expect(result.violations.map(violation => violation.detail?.accountingIssue)).toEqual(expect.arrayContaining([
      "duplicate_decision",
      "suppressed_mismatched_decision"
    ]));
  });

  it("does not authorize broad exclusion from a standalone handcrafted flag", () => {
    const result = buildCandidateTerminalRecords({
      candidates: [{ findingId: "broad", criterion: "geometry", exclusionEligibility: "broad_vlm_evidence" }],
      retainedFindingIds: [],
      broadExcludedIds: ["broad"],
      removedLineage: [],
      decisions: []
    } as never);
    expect(result[0]).toMatchObject({ candidateId: "broad", terminal: "violation" });
    expect(validateStructuralConsolidationLedger({
      candidates: [{ findingId: "broad", criterion: "geometry", exclusionEligibility: "broad_vlm_evidence" }],
      retainedFindingIds: [],
      candidateTerminals: [{ candidateId: "broad", terminal: "broad_excluded", exclusionReason: "broad_vlm_evidence" }],
      decisions: []
    } as never).status).toBe("fail");
  });

  it.each([
    ["criterion", { criterion: "color" }, "decision_criterion_mismatch"],
    ["sameCriterion", { sameCriterion: false }, "decision_criterion_mismatch"],
    ["action", { action: "retain_distinct", reason: "independent_geometry" }, "decision_action_mismatch"],
    ["reason", { reason: "independent_geometry" }, "decision_reason_mismatch"],
    ["semanticDescendant", { semanticDescendant: false }, "decision_semantic_descendant_mismatch"],
    ["displacementRelation", { displacementRelation: "distinct_translation" }, "decision_displacement_mismatch"],
    ["measurementRelation", { measurementRelation: "distinct_resize" }, "decision_measurement_mismatch"]
  ])("rejects forged persisted decision %s facts", (_label, override, issue) => {
    const result = validateStructuralConsolidationLedger({
      candidates,
      retainedFindingIds: ["parent"],
      candidateTerminals: [
        { candidateId: "child", terminal: "suppressed_to_retained", retainedFindingId: "parent" },
        { candidateId: "parent", terminal: "retained" }
      ],
      decisions: [accountingDecision(override as Partial<StructuralSuppressionDecision>)]
    });
    expect(result.status).toBe("fail");
    expect(result.violations.map(violation => violation.detail?.accountingIssue)).toContain(issue);
  });

  it("derives sameCriterion from candidate criteria instead of persisted facts", () => {
    const result = validateStructuralConsolidationLedger({
      candidates: [
        { findingId: "child", criterion: "geometry" },
        { findingId: "parent", criterion: "color" }
      ],
      retainedFindingIds: ["parent"],
      candidateTerminals: [
        { candidateId: "child", terminal: "suppressed_to_retained", retainedFindingId: "parent" },
        { candidateId: "parent", terminal: "retained" }
      ],
      decisions: [accountingDecision({ criterion: "geometry", sameCriterion: true })]
    });
    expect(result.status).toBe("fail");
    expect(result.violations.map(violation => violation.detail?.accountingIssue)).toContain("decision_criterion_mismatch");
  });

  it("finalization exposes invalid removed-child relation instead of silently accepting it", () => {
    const make = (id: string, targetId: string, measurements: DiffRecord["measurements"]): DiffRecord => ({
      id,
      pairId: `pair-${id}`,
      criterion: "geometry",
      severity: "medium",
      title: id,
      location: id === "parent" ? { x: 20, y: 40, width: 120, height: 120 } : { x: 40, y: 60, width: 40, height: 40 },
      evidence: [id],
      measurements,
      artifactPaths: [],
      targetIds: [targetId],
      reviewerStatus: "accepted"
    });
    const parentElement: UiElement = {
      id: "parent-element", label: "parent", type: "card", box: { x: 20, y: 40, width: 120, height: 120 },
      normalizedBox: { x: 0.1, y: 0.1, width: 0.6, height: 0.3 }, confidence: 0.9, source: "locator", childIds: ["child-element"]
    };
    const childElement: UiElement = {
      id: "child-element", label: "child", type: "text", box: { x: 40, y: 60, width: 40, height: 40 },
      normalizedBox: { x: 0.2, y: 0.15, width: 0.2, height: 0.1 }, confidence: 0.9, source: "locator", parentId: "parent-element", childIds: []
    };
    const result = finalizeFindings([
      make("parent", parentElement.id, [{ name: "deltaX", value: 10, unit: "px" }, { name: "deltaY", value: 10, unit: "px" }]),
      make("child", childElement.id, [{ name: "deltaX", value: -10, unit: "px" }, { name: "deltaY", value: -10, unit: "px" }])
    ], [parentElement, childElement], [
      { id: "pair-parent", expectedId: parentElement.id, status: "matched", score: 1, reasons: [] },
      { id: "pair-child", expectedId: childElement.id, status: "matched", score: 1, reasons: [] }
    ], { canvas });
    expect(result.structuralLedger.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ suppressedFindingId: "child", retainedFindingId: "parent", action: "retain_distinct" })
    ]));
    expect(result.diffs.map(finding => finding.id)).not.toContain("child");
    expect(result.diffs.find(finding => finding.id === "parent")?.childFindingIds).toContain("child");
    expect(validateStructuralConsolidationLedger(result.structuralLedger).status).toBe("fail");
  });

  it("persists sorted candidate element IDs and immutable element lineage", () => {
    const finding: DiffRecord = {
      id: "lineage",
      pairId: "pair-lineage",
      criterion: "geometry",
      severity: "medium",
      title: "lineage",
      location: { x: 10, y: 10, width: 20, height: 20 },
      evidence: ["lineage"],
      measurements: [],
      artifactPaths: [],
      targetIds: ["child-element"],
      reviewerStatus: "accepted"
    };
    const result = finalizeFindings([finding], [{
      id: "root-element", label: "root", type: "card", box: { x: 0, y: 0, width: 100, height: 100 },
      normalizedBox: { x: 0, y: 0, width: 1, height: 1 }, confidence: 1, source: "locator", childIds: ["child-element"]
    }, {
      id: "child-element", label: "child", type: "text", box: finding.location,
      normalizedBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, confidence: 1, source: "locator", parentId: "root-element", childIds: []
    }], [{ id: "pair-lineage", expectedId: "child-element", actualId: "actual-child", status: "matched", score: 1, reasons: [] }], { canvas });
    expect(result.structuralLedger.candidates[0]?.elementIds).toEqual(["actual-child", "child-element"]);
    expect(result.structuralLedger.elementLineage).toEqual([
      { elementId: "actual-child" },
      { elementId: "child-element", parentId: "root-element" },
      { elementId: "root-element" }
    ]);
    expect(Object.isFrozen(result.structuralLedger.elementLineage)).toBe(true);
  });

  it.each([
    ["sibling", {
      semanticRelation: "sibling" as const,
      semanticDescendant: false,
      parentElementId: "parent-element",
      childElementId: "child-element"
    }],
    ["unrelated as descendant", {
      semanticRelation: "descendant" as const,
      semanticDescendant: true,
      parentElementId: "parent-element",
      childElementId: "unrelated-element"
    }]
  ])("rejects forged %s semantic relation from canonical lineage", (_label, override) => {
    const result = validateStructuralConsolidationLedger({
      candidates: [
        { findingId: "child", criterion: "geometry", elementIds: ["child-element"] },
        { findingId: "parent", criterion: "geometry", elementIds: ["parent-element"] }
      ],
      elementLineage: [
        { elementId: "parent-element", parentId: "root-element" },
        { elementId: "child-element", parentId: "parent-element" },
        { elementId: "unrelated-element", parentId: "other-root" },
        { elementId: "root-element" },
        { elementId: "other-root" }
      ],
      retainedFindingIds: ["parent"],
      candidateTerminals: [
        { candidateId: "child", terminal: "suppressed_to_retained", retainedFindingId: "parent" },
        { candidateId: "parent", terminal: "retained" }
      ],
      decisions: [accountingDecision(override)]
    } as never);
    expect(result.status).toBe("fail");
    expect(result.violations.map(violation => violation.detail?.accountingIssue)).toContain("decision_semantic_relation_mismatch");
  });

  it("rejects decision element IDs that do not belong to the candidate lineage", () => {
    const result = validateStructuralConsolidationLedger({
      candidates: [
        { findingId: "child", criterion: "geometry", elementIds: ["child-element"] },
        { findingId: "parent", criterion: "geometry", elementIds: ["parent-element"] }
      ],
      elementLineage: [
        { elementId: "parent-element", parentId: "root-element" },
        { elementId: "child-element", parentId: "parent-element" },
        { elementId: "root-element" }
      ],
      retainedFindingIds: ["parent"],
      candidateTerminals: [
        { candidateId: "child", terminal: "suppressed_to_retained", retainedFindingId: "parent" },
        { candidateId: "parent", terminal: "retained" }
      ],
      decisions: [accountingDecision({ parentElementId: "wrong-element" })]
    } as never);
    expect(result.status).toBe("fail");
    expect(result.violations.map(violation => violation.detail?.accountingIssue)).toContain("decision_semantic_relation_mismatch");
  });

  it("produces byte-equivalent non-empty ledgers for forward and reverse finalization order", () => {
    const elements: UiElement[] = [{
      id: "parent-element", label: "parent", type: "card", box: { x: 20, y: 40, width: 120, height: 120 },
      normalizedBox: { x: 0.1, y: 0.1, width: 0.6, height: 0.3 }, confidence: 1, source: "locator", childIds: ["child-element"]
    }, {
      id: "child-element", label: "child", type: "text", box: { x: 40, y: 60, width: 40, height: 40 },
      normalizedBox: { x: 0.2, y: 0.15, width: 0.2, height: 0.1 }, confidence: 1, source: "locator", parentId: "parent-element", childIds: []
    }];
    const make = (id: string, targetId: string, box: DiffRecord["location"]): DiffRecord => ({
      id, pairId: `pair-${id}`, criterion: "geometry", severity: "medium", title: id, location: box,
      evidence: [id], measurements: [{ name: "deltaX", value: 10, unit: "px" }, { name: "deltaY", value: 10, unit: "px" }],
      artifactPaths: [], targetIds: [targetId], reviewerStatus: "accepted"
    });
    const findings = [
      make("parent", "parent-element", elements[0]!.box),
      make("child", "child-element", elements[1]!.box)
    ];
    const pairs = [
      { id: "pair-parent", expectedId: "parent-element", status: "matched" as const, score: 1, reasons: [] },
      { id: "pair-child", expectedId: "child-element", status: "matched" as const, score: 1, reasons: [] }
    ];
    const forward = finalizeFindings(findings, elements, pairs, { canvas }).structuralLedger;
    const reverse = finalizeFindings([...findings].reverse(), [...elements].reverse(), [...pairs].reverse(), { canvas }).structuralLedger;
    expect(JSON.stringify(forward)).not.toBe("{}");
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
  });

  const lineageCandidateLedger = (elementLineage: Array<{ elementId: string; parentId?: string }>) => ({
    candidates: [
      { findingId: "child", criterion: "geometry", elementIds: ["child-element"] },
      { findingId: "parent", criterion: "geometry", elementIds: ["parent-element"] }
    ],
    elementLineage,
    retainedFindingIds: ["parent"],
    candidateTerminals: [
      { candidateId: "child", terminal: "suppressed_to_retained" as const, retainedFindingId: "parent" },
      { candidateId: "parent", terminal: "retained" as const }
    ],
    decisions: [accountingDecision()]
  });

  it.each([
    ["duplicate_element_lineage", [
      { elementId: "child-element", parentId: "parent-element" },
      { elementId: "child-element", parentId: "other-parent" },
      { elementId: "parent-element" }
    ]],
    ["dangling_parent_lineage", [
      { elementId: "child-element", parentId: "missing-parent" },
      { elementId: "parent-element" }
    ]],
    ["cyclic_element_lineage", [
      { elementId: "child-element", parentId: "parent-element" },
      { elementId: "parent-element", parentId: "child-element" }
    ]],
    ["cyclic_element_lineage self cycle", [
      { elementId: "child-element", parentId: "child-element" },
      { elementId: "parent-element" }
    ]]
  ])("rejects invalid element lineage: %s", (_label, elementLineage) => {
    const result = validateStructuralConsolidationLedger(lineageCandidateLedger(elementLineage));
    expect(result.status).toBe("fail");
    expect(result.violations.map(violation => violation.detail?.accountingIssue)).toContain(
      _label.startsWith("cyclic") ? "cyclic_element_lineage" : _label
    );
    expect(result.violations.some(violation => violation.elementId !== undefined)).toBe(true);
  });

  it("keeps a canonical lineage path valid and rejects suppression when the graph is corrupted", () => {
    const valid = validateStructuralConsolidationLedger(lineageCandidateLedger([
      { elementId: "child-element", parentId: "parent-element" },
      { elementId: "parent-element" }
    ]));
    expect(valid).toEqual({ status: "pass", violations: [] });
    const corrupted = validateStructuralConsolidationLedger(lineageCandidateLedger([
      { elementId: "child-element", parentId: "parent-element" },
      { elementId: "parent-element", parentId: "child-element" }
    ]));
    expect(corrupted.status).toBe("fail");
    expect(corrupted.violations.map(violation => violation.detail?.accountingIssue)).toContain("cyclic_element_lineage");
  });

  it("sorts duplicate lineage ties by parent ID before validation rejects them", () => {
    const ledger = freezeStructuralLedger({
      ...lineageCandidateLedger([
        { elementId: "child-element", parentId: "z-parent" },
        { elementId: "child-element", parentId: "a-parent" },
        { elementId: "parent-element" }
      ])
    });
    expect(ledger.elementLineage?.slice(0, 2).map(lineage => lineage.parentId)).toEqual(["a-parent", "z-parent"]);
    expect(validateStructuralConsolidationLedger(ledger).status).toBe("fail");
  });

  it("maps each retained decision to exactly one stable finding group", () => {
    const mapped = mapStructuralDecisionGroups(lineageCandidateLedger([
      { elementId: "child-element", parentId: "parent-element" },
      { elementId: "parent-element" }
    ]), [{ id: "group-002", diffIds: ["parent"] }, { id: "group-001", diffIds: ["child"] }]);
    expect(mapped.decisions[0]).toMatchObject({ retainedGroupId: "group-002", retainedGroupIds: ["group-002"] });
    expect(validateStructuralConsolidationLedger(mapped, { requireGroups: true })).toEqual({ status: "pass", violations: [] });
  });

  it.each([
    ["missing", []],
    ["ambiguous", [{ id: "group-001", diffIds: ["parent"] }, { id: "group-002", diffIds: ["parent"] }]]
  ])("fails requireGroups validation for %s retained group mapping", (_label, groups) => {
    const mapped = mapStructuralDecisionGroups(lineageCandidateLedger([
      { elementId: "child-element", parentId: "parent-element" },
      { elementId: "parent-element" }
    ]), groups);
    expect(validateStructuralConsolidationLedger(mapped, { requireGroups: true }).status).toBe("fail");
  });

  it("keeps group mapping byte-stable under input permutations", () => {
    const ledger = lineageCandidateLedger([
      { elementId: "child-element", parentId: "parent-element" },
      { elementId: "parent-element" }
    ]);
    const groups = [{ id: "group-002", diffIds: ["parent"] }, { id: "group-001", diffIds: ["child"] }];
    const forward = mapStructuralDecisionGroups(ledger, groups);
    const reverse = mapStructuralDecisionGroups({
      ...ledger,
      decisions: [...ledger.decisions].reverse(),
      candidates: [...ledger.candidates].reverse(),
      elementLineage: [...ledger.elementLineage].reverse()
    }, [...groups].reverse());
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
  });

  it("clears stale retained group ownership before remapping", () => {
    const ledger = lineageCandidateLedger([{ elementId: "child-element", parentId: "parent-element" }, { elementId: "parent-element" }]);
    const stale = {
      ...ledger,
      decisions: ledger.decisions.map(decision => ({ ...decision, retainedGroupId: "stale", retainedGroupIds: ["stale"] }))
    };
    const mapped = mapStructuralDecisionGroups(stale, [{ id: "group-001", diffIds: ["parent"] }]);
    expect(mapped.decisions[0]).toMatchObject({ retainedGroupId: "group-001", retainedGroupIds: ["group-001"] });
    expect(mapped.decisions[0]).not.toMatchObject({ retainedGroupId: "stale", retainedGroupIds: ["stale"] });
  });

  it("rejects stale, wrong-owner, missing, and ambiguous actual group ownership", () => {
    const ledger = lineageCandidateLedger([{ elementId: "child-element", parentId: "parent-element" }, { elementId: "parent-element" }]);
    const stale = mapStructuralDecisionGroups(ledger, [{ id: "group-001", diffIds: ["parent"] }]);
    expect(validateStructuralConsolidationLedger(stale, {
      requireGroups: true,
      actualGroups: [{ id: "group-999", diffIds: ["parent"] }]
    }).status).toBe("fail");
    expect(validateStructuralConsolidationLedger(stale, {
      requireGroups: true,
      actualGroups: [{ id: "group-001", diffIds: ["other"] }]
    }).status).toBe("fail");
    expect(validateStructuralConsolidationLedger(stale, {
      requireGroups: true,
      actualGroups: [{ id: "group-001", diffIds: ["parent"] }, { id: "group-002", diffIds: ["parent"] }]
    }).status).toBe("fail");
  });
});
