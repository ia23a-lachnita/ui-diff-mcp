import { z } from "zod";
import type { UiCriterion, DeterministicMeasurement } from "../schemas/core.js";

export const AuditResultSchema = z.object({
  hasDiff: z.boolean(),
  severity: z.enum(["low", "medium", "high"]).optional(),
  title: z.string().optional(),
  evidence: z.array(z.string()).optional()
});
export type AuditResult = z.infer<typeof AuditResultSchema>;

export interface CriterionRubric {
  criterion: UiCriterion;
  description: string;
  jsonSchema: Record<string, unknown>;
}

export const rubrics: Record<UiCriterion, CriterionRubric> = {
  presence: {
    criterion: "presence",
    description: "Determine if the expected element is present or absent in the actual screenshot.",
    jsonSchema: {
      type: "object",
      properties: {
        hasDiff: { type: "boolean" },
        severity: { type: "string", enum: ["low", "medium", "high"] },
        title: { type: "string" },
        evidence: { type: "array", items: { type: "string" } }
      },
      required: ["hasDiff"],
      additionalProperties: false
    }
  },
  geometry: {
    criterion: "geometry",
    description: "Compare the size, position, and bounding box of the element between expected and actual.",
    jsonSchema: {
      type: "object",
      properties: {
        hasDiff: { type: "boolean" },
        severity: { type: "string", enum: ["low", "medium", "high"] },
        title: { type: "string" },
        evidence: { type: "array", items: { type: "string" } }
      },
      required: ["hasDiff"],
      additionalProperties: false
    }
  },
  spacing_alignment: {
    criterion: "spacing_alignment",
    description: "Check spacing between elements, margins, padding, and baseline alignment.",
    jsonSchema: {
      type: "object",
      properties: {
        hasDiff: { type: "boolean" },
        severity: { type: "string", enum: ["low", "medium", "high"] },
        title: { type: "string" },
        evidence: { type: "array", items: { type: "string" } }
      },
      required: ["hasDiff"],
      additionalProperties: false
    }
  },
  typography_content: {
    criterion: "typography_content",
    description: "Compare text content, font size, weight, style, and color between expected and actual.",
    jsonSchema: {
      type: "object",
      properties: {
        hasDiff: { type: "boolean" },
        severity: { type: "string", enum: ["low", "medium", "high"] },
        title: { type: "string" },
        evidence: { type: "array", items: { type: "string" } }
      },
      required: ["hasDiff"],
      additionalProperties: false
    }
  },
  color_appearance: {
    criterion: "color_appearance",
    description: "Compare background color, fill color, border color, and overall visual appearance.",
    jsonSchema: {
      type: "object",
      properties: {
        hasDiff: { type: "boolean" },
        severity: { type: "string", enum: ["low", "medium", "high"] },
        title: { type: "string" },
        evidence: { type: "array", items: { type: "string" } }
      },
      required: ["hasDiff"],
      additionalProperties: false
    }
  },
  icon_image: {
    criterion: "icon_image",
    description: "Compare icon or image content, aspect ratio, style, and visual fidelity.",
    jsonSchema: {
      type: "object",
      properties: {
        hasDiff: { type: "boolean" },
        severity: { type: "string", enum: ["low", "medium", "high"] },
        title: { type: "string" },
        evidence: { type: "array", items: { type: "string" } }
      },
      required: ["hasDiff"],
      additionalProperties: false
    }
  },
  layering_clipping: {
    criterion: "layering_clipping",
    description: "Detect overlapping elements, z-index issues, or content being clipped outside its container.",
    jsonSchema: {
      type: "object",
      properties: {
        hasDiff: { type: "boolean" },
        severity: { type: "string", enum: ["low", "medium", "high"] },
        title: { type: "string" },
        evidence: { type: "array", items: { type: "string" } }
      },
      required: ["hasDiff"],
      additionalProperties: false
    }
  },
  component_state: {
    criterion: "component_state",
    description: "Compare interactive state: selected, active, disabled, focused, pressed, checked.",
    jsonSchema: {
      type: "object",
      properties: {
        hasDiff: { type: "boolean" },
        severity: { type: "string", enum: ["low", "medium", "high"] },
        title: { type: "string" },
        evidence: { type: "array", items: { type: "string" } }
      },
      required: ["hasDiff"],
      additionalProperties: false
    }
  },
  chart_special_geometry: {
    criterion: "chart_special_geometry",
    description: "Compare chart axes, data series, bar/line proportions, and legend positioning.",
    jsonSchema: {
      type: "object",
      properties: {
        hasDiff: { type: "boolean" },
        severity: { type: "string", enum: ["low", "medium", "high"] },
        title: { type: "string" },
        evidence: { type: "array", items: { type: "string" } }
      },
      required: ["hasDiff"],
      additionalProperties: false
    }
  },
  unclassified_visual_change: {
    criterion: "unclassified_visual_change",
    description: "A visual change that was detected by pixel diff but not matched to a specific criterion.",
    jsonSchema: {
      type: "object",
      properties: {
        hasDiff: { type: "boolean" },
        severity: { type: "string", enum: ["low", "medium", "high"] },
        title: { type: "string" },
        evidence: { type: "array", items: { type: "string" } }
      },
      required: ["hasDiff"],
      additionalProperties: false
    }
  }
};

export interface TriggerContext {
  pairingStatus: string;
  positionDeltaPx: number;
  geometryDeltaPx: number;
  comparisonComparable: boolean;
  textDelta: boolean;
  colorDelta: boolean;
  edgeMismatch: boolean;
  overlapDetected: boolean;
  stateWordsDiffer: boolean;
  elementType: string;
  measurements: DeterministicMeasurement[];
}

export function selectTriggeredCriteria(ctx: TriggerContext): UiCriterion[] {
  const triggered = new Set<UiCriterion>();

  if (ctx.pairingStatus === "missing" || ctx.pairingStatus === "extra") {
    triggered.add("presence");
  }
  if (ctx.geometryDeltaPx > 3) {
    triggered.add("geometry");
  }
  if (ctx.positionDeltaPx > 2 && ctx.pairingStatus === "matched") {
    triggered.add("spacing_alignment");
  }
  if (ctx.textDelta) {
    triggered.add("typography_content");
  }
  if (ctx.colorDelta) {
    triggered.add("color_appearance");
  }
  if (ctx.edgeMismatch && (ctx.elementType === "icon" || ctx.elementType === "image")) {
    triggered.add("icon_image");
  }
  if (ctx.overlapDetected) {
    triggered.add("layering_clipping");
  }
  if (ctx.stateWordsDiffer) {
    triggered.add("component_state");
  }
  if (ctx.elementType === "chart" && (ctx.edgeMismatch || ctx.colorDelta)) {
    triggered.add("chart_special_geometry");
  }

  return [...triggered];
}
