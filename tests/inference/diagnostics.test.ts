import { describe, expect, it } from "vitest";
import { classifyText, describeDiagnostics, summarizeOutput } from "../../src/inference/index.ts";
import { balancedEnd } from "../../src/inference/diagnostics.ts";

const SECRET = "sk-live-SECRET-VALUE-9876543210";

describe("classifyText", () => {
  it("recognizes well-formed JSON by top-level kind", () => {
    expect(classifyText(' {"a":1} ')).toEqual({ shape: "json_object", parsed: { a: 1 } });
    expect(classifyText("[1,2]")).toEqual({ shape: "json_array", parsed: [1, 2] });
    expect(classifyText('"s"')).toEqual({ shape: "json_scalar", parsed: "s" });
    expect(classifyText("   ")).toEqual({ shape: "empty" });
  });

  it("separates fenced, prose-wrapped, truncated, trailing and otherwise invalid output", () => {
    expect(classifyText('```json\n{"a":1}\n```').shape).toBe("fenced");
    expect(classifyText('Here is the decision: {"a":1}').shape).toBe("leading_prose");
    expect(classifyText('{"summary":"cut off mid str').shape).toBe("unbalanced_json");
    expect(classifyText('{"summary":"ok","calls":[{"tool":"observe"').shape).toBe("unbalanced_json");
    expect(classifyText('{"a":1}{"b":2}').shape).toBe("trailing_content");
    expect(classifyText('{"a":1} thanks').shape).toBe("trailing_content");
    expect(classifyText("{'a':1}").shape).toBe("invalid_json");
    expect(classifyText('{"a":1,}').shape).toBe("invalid_json");
  });

  it("does not let braces inside strings confuse the balance scan", () => {
    expect(balancedEnd('{"s":"}{"}')).toBe(10);
    expect(balancedEnd('{"s":"\\"}"}')).toBe(11);
    expect(balancedEnd('{"s":"unterminated')).toBe(-1);
    expect(balancedEnd("}")).toBe(-1);
  });
});

describe("summarizeOutput", () => {
  const body = (output: unknown[], extra: Record<string, unknown> = {}) => ({ id: "resp_1", output, usage: { input_tokens: 1, output_tokens: 224 }, ...extra });

  it("counts items and parts, flags refusals and never stores text", () => {
    const d = summarizeOutput(
      body([
        { type: "reasoning", summary: [] },
        { type: "message", role: "assistant", content: [{ type: "refusal", refusal: `I cannot ${SECRET}` }, { type: "output_text", text: `{"x":"${SECRET}"}` }] },
        { type: "message", role: "assistant", content: "plain string, not an array" },
        { type: "we!rd type with spaces" },
      ]),
      `{"x":"${SECRET}"}`,
      224,
    );
    expect(d).toEqual({
      providerStatus: null,
      incompleteReason: null,
      outputItems: 4,
      itemTypes: { reasoning: 1, message: 2, other: 1 },
      messageItems: 2,
      messageShapes:[{phase:null,status:null,textParts:1,textChars:`{"x":"${SECRET}"}`.length,textShape:'json_object'},{phase:null,status:null,textParts:0,textChars:0,textShape:'none'}],
      partTypes: { refusal: 1, output_text: 1, no_content_array: 1 },
      refusal: true,
      textChars: `{"x":"${SECRET}"}`.length,
      textShape: "json_object",
      outputTokens: 224,
    });
    const dump = JSON.stringify(d) + describeDiagnostics(d);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain("cannot");
  });

  it("reads provider status and incomplete reason as tokens only", () => {
    const d = summarizeOutput(body([], { status: "incomplete", incomplete_details: { reason: "content_filter" } }), null, 12);
    expect(d).toMatchObject({ providerStatus: "incomplete", incompleteReason: "content_filter", outputItems: 0, textShape: "none", textChars: null });
    const loud = summarizeOutput(body([], { status: `weird status ${SECRET}` }), null, null);
    expect(loud.providerStatus).toBeNull();
    expect(describeDiagnostics(loud)).toBe("shape=none status=- items=- parts=- chars=- tokens=-");
  });

  it("caps distinct type keys so a hostile body cannot grow the record unboundedly", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ type: `t${i}` }));
    const d = summarizeOutput(body(items), null, null);
    expect(Object.keys(d.itemTypes)).toHaveLength(1);
    expect(d.itemTypes.other).toBe(30);
    expect(d.outputItems).toBe(30);
  });
  it('never retains credential-shaped or prototype-like provider metadata as a type or status',()=>{
    const d=summarizeOutput(body([{type:SECRET},{type:'__proto__'},{type:'constructor'}],{status:SECRET,incomplete_details:{reason:SECRET}}),null,null);
    expect(d.itemTypes).toEqual({other:3});expect(d.providerStatus).toBeNull();expect(d.incompleteReason).toBeNull();
    expect(JSON.stringify(d)+describeDiagnostics(d)).not.toContain(SECRET);
  });
});

it('distinguishes commentary from final-answer shapes without retaining content or unknown phase labels',()=>{
 const d=summarizeOutput({output:[{type:'message',phase:'commentary',status:'completed',content:[{type:'output_text',text:SECRET}]},{type:'message',phase:'final_answer',status:'completed',content:[{type:'output_text',text:'{"done":true}'}]},{type:'message',phase:SECRET,content:[]}]},SECRET+'{"done":true}',224);
 expect(d.messageShapes).toMatchObject([{phase:'commentary',textShape:'leading_prose'},{phase:'final_answer',textShape:'json_object'},{phase:null,textShape:'none'}]);expect(JSON.stringify(d)).not.toContain(SECRET);
});
