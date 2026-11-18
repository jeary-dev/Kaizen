import { describe, expect, it } from "vitest";
import { placeholderPattern, placeholderTag } from "@/lib/protocol/formats";
import { detectLineBreak, fromEditorText, lineColumn, toEditorText } from "./text";
import { hasErrors, missingPlaceholders, validate } from "./validate";

const messages = (problems: { message: string }[]) => problems.map((p) => p.message);

describe("line endings", () => {
  it("keeps CRLF files CRLF and mixed files byte-identical", () => {
    for (const text of ["a\nb\n", "a\r\nb\r\n", "a\r\nb\nc", "no breaks", "", "\r\n"]) {
      const lb = detectLineBreak(text);
      expect(fromEditorText(toEditorText(text, lb), lb)).toBe(text);
    }
    expect(detectLineBreak("a\r\nb\r\n")).toBe("\r\n");
    expect(detectLineBreak("a\r\nb\n")).toBe("\n");
  });

  it("reports 1-based positions", () => {
    expect(lineColumn("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
  });
});

describe("placeholders", () => {
  it("only match whole ids with the session tag", () => {
    const text = "a: KAIZEN_SECRET_1_ab12\nb: KAIZEN_SECRET_2_ab12x\nc: xKAIZEN_SECRET_3_ab12\nd: KAIZEN_SECRET_4_zz99";
    expect(Array.from(text.matchAll(placeholderPattern("ab12")), (m) => m[0])).toEqual(["KAIZEN_SECRET_1_ab12"]);
    expect(placeholderTag("KAIZEN_SECRET_12_ab12")).toBe("ab12");
    expect(placeholderTag("KAIZEN_SECRET_0_ab12")).toBeNull();
  });

  it("flags duplicated and foreign placeholders, and lists removed ones", () => {
    const ids = new Set(["KAIZEN_SECRET_1_ab12", "KAIZEN_SECRET_2_ab12"]);
    const text = "a: KAIZEN_SECRET_1_ab12\nb: KAIZEN_SECRET_1_ab12\nc: KAIZEN_SECRET_9_ab12\n";
    const problems = validate("yaml", text, { placeholderTag: "ab12", placeholderIds: ids });
    expect(messages(problems)).toEqual([
      expect.stringContaining("only appear once"),
      expect.stringContaining("doesn't belong"),
    ]);
    expect(hasErrors(problems)).toBe(true);
    expect(missingPlaceholders(text, "ab12", ids)).toEqual(["KAIZEN_SECRET_2_ab12"]);
  });
});

describe("yaml", () => {
  it("accepts a normal Bukkit config", () => {
    expect(validate("yaml", "# comment\nshop:\n  title: \"Hi\"\n  items: [1, 2]\nlist:\n  - a\n  - b\n")).toEqual([]);
  });

  it("points at tab indentation with a clear message", () => {
    const text = "shop:\n\ttitle: x\n";
    const problems = validate("yaml", text);
    expect(problems[0]).toMatchObject({ from: 6, to: 7, severity: "error" });
    expect(problems[0].message).toMatch(/Tab used for indentation/);
    expect(problems.filter((p) => p.message.includes("Tab")).length).toBe(1);
  });

  it("reports syntax errors at their position", () => {
    const text = "a: [1, 2\nb: c\n";
    const problems = validate("yaml", text);
    expect(hasErrors(problems)).toBe(true);
    expect(problems[0].from).toBeGreaterThan(0);
  });

  it("warns about duplicate keys", () => {
    const problems = validate("yaml", "a: 1\nb: 2\na: 3\n");
    expect(problems).toEqual([expect.objectContaining({ severity: "warning", from: 10, message: expect.stringMatching(/Duplicate key/) })]);
  });

  it("warns when a value changes type, using YAML 1.1 like Bukkit", () => {
    const original = "max: 10\nenabled: yes\nname: Bob\nlist:\n  - a\n";
    const edited = 'max: "10"\nenabled: maybe\nname: 42\nlist: none\n';
    const problems = validate("yaml", edited, { original });
    expect(messages(problems)).toEqual([
      '"max" was a number and is now text. The plugin may not expect that. If you meant a number, remove the quotes.',
      '"enabled" was true/false and is now text. The plugin may not expect that.',
      '"name" was text and is now a number. The plugin may not expect that.',
      '"list" was a list and is now text. The plugin may not expect that.',
    ]);
    expect(problems.every((p) => p.severity === "warning")).toBe(true);
    expect(edited.slice(problems[0].from, problems[0].to)).toBe('"10"');
    // Same types, different values: nothing to say.
    expect(validate("yaml", "max: 11\nenabled: no\nname: Alice\nlist:\n  - b\n", { original })).toEqual([]);
  });
});

describe("json", () => {
  it("accepts comments and reports errors with friendly messages", () => {
    expect(validate("json", '{\n  // note\n  "a": 1\n}')).toEqual([]);
    const problems = validate("json", '{ "a": 1 "b": 2 }');
    expect(problems[0]).toMatchObject({ severity: "error", message: "Expected a comma.", from: 9 });
  });

  it("warns about duplicate keys and type changes", () => {
    const problems = validate("json", '{"a": "1", "a": 2, "b": {"c": true}}', { original: '{"a": 1, "b": {"c": false}}' });
    expect(messages(problems)).toEqual([
      expect.stringContaining('"a" was a number and is now text'),
      "Duplicate key. Only the last one will be used.",
    ]);
  });
});

describe("toml and properties", () => {
  it("reports TOML errors on the right line", () => {
    const text = 'title = "x"\n[server\nport = 1\n';
    const [problem] = validate("toml", text);
    expect(problem.severity).toBe("error");
    expect(lineColumn(text, problem.from).line).toBe(2);
    expect(validate("toml", 'a = 1\n[b]\nc = "d"\n')).toEqual([]);
  });

  it("warns about duplicate properties but understands continuations", () => {
    const text = "a=1\nlong=x \\\n  a=not-a-key\nb=2\na=3\n";
    const problems = validate("properties", text);
    expect(problems).toHaveLength(1);
    expect(lineColumn(text, problems[0].from).line).toBe(5);
  });
});
