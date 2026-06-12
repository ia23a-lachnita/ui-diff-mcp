import { UiCriterion, DiffRecordSchema } from "../schemas/core.js";
import { z } from "zod";

export const AuditResultSchema = z.object({
  hasDiff: z.boolean(),
  severity: DiffRecordSchema.shape.severity.optional(),
  title: z.string().optional(),
  evidence: z.array(z.string()).optional(),
  measurements: z.array(z.any()).optional(),
});
export type AuditResult = z.infer<typeof AuditResultSchema>;

export type CriterionRubric = {
  criterion: UiCriterion;
  evaluate: (...args: any[]) => AuditResult;
};

// This is a placeholder implementation.
// The actual implementation will require more context and business logic.

export const rubrics: Record<UiCriterion, CriterionRubric> = {
  presence: {
    criterion: "presence",
    evaluate: () => ({ hasDiff: false }),
  },
  geometry: {
    criterion: "geometry",
    evaluate: () => ({ hasDiff: false }),
  },
  spacing_alignment: {
    criterion: "spacing_alignment",
    evaluate: () => ({ hasDiff: false }),
  },
  typography_content: {
    criterion: "typography_content",
    evaluate: () => ({ hasDiff: false }),
  },
  color_appearance: {
    criterion: "color_appearance",
    evaluate: () => ({ hasDiff: false }),
  },
  icon_image: {
    criterion: "icon_image",
    evaluate: () => ({ hasDiff: false }),
  },
  layering_clipping: {
    criterion: "layering_clipping",
    evaluate: () => ({ hasDiff: false }),
  },
  component_state: {
    criterion: "component_state",
    evaluate: () => ({ hasDiff: false }),
  },
  chart_special_geometry: {
    criterion: "chart_special_geometry",
    evaluate: () => ({ hasDiff: false }),
  },
  unclassified_visual_change: {
    criterion: "unclassified_visual_change",
    evaluate: () => ({ hasDiff: false }),
  },
};
