import { describe, it, expect } from "vitest";
import { parseCto, validateCto, describeParseError } from "../../utils/graph/ctoToGraph";
import { computeQuickFixes, type QuickFix } from "../../utils/quickFixes";

function officialParseMessage(cto: string): string {
  try {
    parseCto(cto);
  } catch (e) {
    return describeParseError(e);
  }
  throw new Error("expected the snippet to fail parsing");
}

// Applies a fix's text edit the same way Monaco would.
function applyFix(source: string, fix: QuickFix): string {
  const lines = source.split("\n");
  const offset = (line: number, column: number) =>
    lines.slice(0, line - 1).reduce((acc, l) => acc + l.length + 1, 0) + (column - 1);
  const start = offset(fix.edit.startLine, fix.edit.startColumn);
  const end = offset(fix.edit.endLine, fix.edit.endColumn);
  return source.slice(0, start) + fix.edit.text + source.slice(end);
}

describe("computeQuickFixes", () => {
  it("fixes a missing closing brace at the end of the file", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person {\n  o String name';
    const fixes = computeQuickFixes(officialParseMessage(cto), cto);
    const fix = fixes.find((f) => f.title.includes('end of the file'));
    expect(fix).toBeDefined();
    expect(() => parseCto(applyFix(cto, fix as QuickFix))).not.toThrow();
  });

  it("closes an unclosed declaration before the next one", () => {
    const cto = 'namespace org.x@1.0.0\nenum GoverningLaw {\n  o NEW_YORK\nconcept Party {\n  o String name\n}';
    const fixes = computeQuickFixes(officialParseMessage(cto), cto);
    const fix = fixes.find((f) => f.title.includes('Close enum "GoverningLaw"'));
    expect(fix).toBeDefined();
    expect(() => parseCto(applyFix(cto, fix as QuickFix))).not.toThrow();
  });

  it("renames a declaration name that contains spaces", () => {
    const cto = 'namespace org.x@1.0.0\nenum Contracting party {\n  o A\n}';
    const fixes = computeQuickFixes(officialParseMessage(cto), cto);
    const fix = fixes.find((f) => f.title === 'Rename to "ContractingParty"');
    expect(fix).toBeDefined();
    const fixed = applyFix(cto, fix as QuickFix);
    expect(fixed).toContain('enum ContractingParty {');
    expect(() => parseCto(fixed)).not.toThrow();
  });

  it("strips the type from an enum value", () => {
    const cto = 'namespace org.x@1.0.0\nenum Status {\n  o String ACTIVE\n}';
    const fixes = computeQuickFixes(officialParseMessage(cto), cto);
    const fix = fixes.find((f) => f.title === 'Change to "o ACTIVE"');
    expect(fix).toBeDefined();
    expect(() => parseCto(applyFix(cto, fix as QuickFix))).not.toThrow();
  });

  it("adds the o marker to a bare property line", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person {\n  String name\n}';
    const fixes = computeQuickFixes(officialParseMessage(cto), cto);
    const fix = fixes.find((f) => f.title === 'Change to "o String name"');
    expect(fix).toBeDefined();
    expect(() => parseCto(applyFix(cto, fix as QuickFix))).not.toThrow();
  });

  it("offers to declare a missing type (official validator message)", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person {\n  o Address home\n}';
    const message = validateCto(cto) as string;
    const fixes = computeQuickFixes(message, cto);
    const declare = fixes.find((f) => f.title.includes('Declare "concept Address"'));
    expect(declare).toBeDefined();
    expect(validateCto(applyFix(cto, declare as QuickFix))).toBeNull();
  });

  it("offers to remove the property that uses a missing type (sweep message)", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person {\n  o Address home\n  o String name\n}';
    const sweepText = 'Type "Address" does not exist, but property "home" of "Person" uses it. Declare the type or remove the property.';
    const fixes = computeQuickFixes(sweepText, cto);
    const remove = fixes.find((f) => f.title === 'Remove property "home"');
    expect(remove).toBeDefined();
    const fixed = applyFix(cto, remove as QuickFix);
    expect(fixed).not.toContain('Address');
    expect(validateCto(fixed)).toBeNull();
  });

  it("returns no fixes for unrecognised messages", () => {
    expect(computeQuickFixes('Something else entirely', 'namespace org.x@1.0.0')).toHaveLength(0);
  });
});
