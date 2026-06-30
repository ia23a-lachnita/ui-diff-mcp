import { describe, expect, it } from "vitest";
import { parseVisionJsonContent, ProviderJsonParseError } from "../../src/models/vision-json.js";

const schema = {
  type: "object",
  properties: { hasDiff: { type: "boolean" }, evidence: { type: "array", items: { type: "string" } } },
  required: ["hasDiff"],
  additionalProperties: false
};

function truncatedJson(length: number): string {
  const prefix = '{"hasDiff":true,"evidence":["';
  return prefix + "x".repeat(length - prefix.length);
}

describe("parseVisionJsonContent", () => {
  it("accepts OpenCode as a structured vision provider", () => {
    expect(parseVisionJsonContent("opencode", '{"hasDiff":false}', schema, true, "stop"))
      .toEqual({ hasDiff: false });
  });

  it("classifies the observed 564-character auditor response as truncated_json", () => {
    const raw = truncatedJson(564);
    const error = (() => { try { parseVisionJsonContent("nvidia", raw, schema, true, "length"); } catch (caught) { return caught; } })();
    expect(error).toBeInstanceOf(ProviderJsonParseError);
    expect((error as ProviderJsonParseError).diagnostic).toMatchObject({ kind: "truncated_json", rawContentLength: 564, startsWithJson: true, endsWithJson: false, finishReason: "length" });
  });

  it("classifies zero-length provider content as empty_content", () => {
    expect(() => parseVisionJsonContent("nvidia", "", schema, true, "stop")).toThrow(ProviderJsonParseError);
    try { parseVisionJsonContent("nvidia", "", schema, true, "stop"); } catch (caught) {
      expect((caught as ProviderJsonParseError).diagnostic.kind).toBe("empty_content");
    }
  });

  it("classifies the observed 416-character recovery response as truncated_json", () => {
    const raw = truncatedJson(416);
    try { parseVisionJsonContent("openrouter", raw, schema, true, "length"); } catch (caught) {
      const diagnostic = (caught as ProviderJsonParseError).diagnostic;
      expect(diagnostic.kind).toBe("truncated_json");
      expect(diagnostic.rawContentLength).toBe(416);
      expect(diagnostic.firstChars?.length).toBeLessThanOrEqual(300);
      expect(diagnostic.lastChars?.length).toBeLessThanOrEqual(300);
    }
  });

  it("trusts a provider length finish over a misleading closing bracket", () => {
    const raw = '{"hasDiff":true,"evidence":["unfinished",]}';
    try { parseVisionJsonContent("nvidia", raw, schema, true, "length"); } catch (caught) {
      expect((caught as ProviderJsonParseError).diagnostic).toMatchObject({
        kind: "truncated_json",
        startsWithJson: true,
        endsWithJson: true,
        finishReason: "length"
      });
    }
  });

  it("trusts Gemini MAX_TOKENS finish over a misleading closing bracket", () => {
    const raw = '{"hasDiff":true,"evidence":["unfinished",]}';
    try { parseVisionJsonContent("gemini", raw, schema, true, "MAX_TOKENS"); } catch (caught) {
      expect((caught as ProviderJsonParseError).diagnostic).toMatchObject({
        kind: "truncated_json",
        startsWithJson: true,
        endsWithJson: true,
        finishReason: "MAX_TOKENS"
      });
    }
  });

  it("classifies complete JSON that violates the response schema as schema_invalid", () => {
    try { parseVisionJsonContent("openrouter", '{"evidence":[]}', schema, true, "stop"); } catch (caught) {
      expect((caught as ProviderJsonParseError).diagnostic).toMatchObject({ kind: "schema_invalid", startsWithJson: true, endsWithJson: true });
    }
  });

  it("classifies Gemini finishReason MAX_TOKENS as truncated_json", () => {
    const raw = truncatedJson(500);
    try {
      parseVisionJsonContent("gemini", raw, schema, true, "MAX_TOKENS");
      throw new Error("expected to throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ProviderJsonParseError);
      const diagnostic = (caught as ProviderJsonParseError).diagnostic;
      expect(diagnostic.kind).toBe("truncated_json");
      expect(diagnostic.finishReason).toBe("MAX_TOKENS");
    }
  });

  it("classifies finishReason max_output_tokens case-insensitively as truncated_json", () => {
    const raw = truncatedJson(300);
    try {
      parseVisionJsonContent("gemini", raw, schema, true, "max_output_tokens");
      throw new Error("expected to throw");
    } catch (caught) {
      expect(caught).toBeInstanceOf(ProviderJsonParseError);
      const diagnostic = (caught as ProviderJsonParseError).diagnostic;
      expect(diagnostic.kind).toBe("truncated_json");
      expect(diagnostic.finishReason).toBe("max_output_tokens");
    }
  });
});
