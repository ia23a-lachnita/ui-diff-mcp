import { describe, it, expect } from "vitest";
import { rubrics } from "../../src/audit/criteria.js";
import { UiCriterionSchema } from "../../src/schemas/core.js";

describe("Audit Criteria", () => {
  it("should have a rubric for every criterion", () => {
    for (const criterion of UiCriterionSchema.options) {
      expect(rubrics[criterion]).toBeDefined();
    }
  });
});
