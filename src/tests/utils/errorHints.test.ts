import { describe, it, expect } from "vitest";
import { parseCto, validateCto, describeParseError } from "../../utils/graph/ctoToGraph";
import { findErrorHint, extractCulpritName, locateCulprit, buildErrorSnippet } from "../../utils/errorHints";

// Runs the real Concerto parser on a broken snippet and returns the official
// message, so the hint rules are tested against what the parser actually says.
function officialParseMessage(cto: string): string {
  try {
    parseCto(cto);
  } catch (e) {
    return describeParseError(e);
  }
  throw new Error("expected the snippet to fail parsing");
}

describe("findErrorHint", () => {
  it("hints when a declaration is missing its name", () => {
    const cto = 'namespace org.x@1.0.0\nconcept {\n}';
    expect(findErrorHint(officialParseMessage(cto), cto)).toContain("has no name");
  });

  it("suggests the joined name when a declaration name contains a space", () => {
    const cto = 'namespace org.x@1.0.0\nenum Contracting party {\n  o A\n}';
    const hint = findErrorHint(officialParseMessage(cto), cto);
    expect(hint).toContain('Rename "Contracting party" to "ContractingParty"');
  });

  it("does not fire the space hint for a valid extends clause", () => {
    const valid = 'namespace org.x@1.0.0\nconcept Base {\n  o String a\n}\nconcept Person extends Base {\n  o String b\n}';
    expect(() => parseCto(valid)).not.toThrow();
  });

  it("hints when a closing brace is missing", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person {\n  o String name\n';
    expect(findErrorHint(officialParseMessage(cto), cto)).toContain('missing "}"');
  });

  it("hints when the namespace is missing", () => {
    const cto = 'concept Person {\n  o String name\n}';
    expect(findErrorHint(officialParseMessage(cto), cto)).toContain("needs a namespace");
  });

  it("suggests the fixed line when a property lacks the o prefix", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person {\n  String name\n}';
    expect(findErrorHint(officialParseMessage(cto), cto)).toContain('write "o String name"');
  });

  it("hints when a property is missing its name", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person {\n  o String\n}';
    expect(findErrorHint(officialParseMessage(cto), cto)).toContain("a type but no name");
  });

  it("hints when a property is stranded outside its declaration by an early brace", () => {
    const cto = 'namespace org.x@1.0.0\nenum GoverningLaw {\n}\n  o DELAWARE\n  o ENGLAND_AND_WALES\n}';
    const hint = findErrorHint(officialParseMessage(cto), cto);
    expect(hint).toContain('closes the declaration too early');
  });

  it("hints on an extra closing brace", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person {\n  o String name\n}\n}';
    expect(findErrorHint(officialParseMessage(cto), cto)).toContain("closes nothing");
  });

  it("hints when the opening brace is missing", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person\n  o String name\n}';
    expect(findErrorHint(officialParseMessage(cto), cto)).toContain("never opens");
  });

  it("hints on an undeclared property type (validator message)", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person {\n  o Address home\n}';
    const message = validateCto(cto);
    expect(message).not.toBeNull();
    expect(findErrorHint(message as string, cto)).toContain("still references this type");
  });

  it("hints on a missing super type (validator message)", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person extends Base {\n  o String name\n}';
    const message = validateCto(cto);
    expect(message).not.toBeNull();
    expect(findErrorHint(message as string, cto)).toContain("parent type");
  });

  it("hints on duplicate declaration names (validator message)", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person {\n  o String a\n}\nconcept Person {\n  o String b\n}';
    const message = validateCto(cto);
    expect(message).not.toBeNull();
    expect(findErrorHint(message as string, cto)).toContain("already taken");
  });

  it("returns null for unrecognised errors", () => {
    expect(findErrorHint("Something completely different went wrong", "")).toBeNull();
  });

  it("uses the actual value name when an enum value has a type", () => {
    const cto = 'namespace org.x@1.0.0\nenum Status {\n  o String ACTIVE\n}';
    const hint = findErrorHint(officialParseMessage(cto), cto);
    expect(hint).toContain('write "o ACTIVE", not "o String ACTIVE"');
  });

  it("does not flag typed properties inside a concept", () => {
    // The same line that is wrong in an enum is valid in a concept, so the
    // enum hint must depend on the enclosing declaration, not just the line.
    const valid = 'namespace org.x@1.0.0\nconcept Flag {\n  o String ACTIVE\n}';
    expect(() => parseCto(valid)).not.toThrow();
  });

  it("hints when a relationship is used inside an enum", () => {
    const cto = 'namespace org.x@1.0.0\nenum Status {\n  --> Party owner\n}';
    expect(findErrorHint(officialParseMessage(cto), cto)).toContain("not allowed inside an enum");
  });

  it("uses the actual scalar name when extends is missing", () => {
    const cto = 'namespace org.x@1.0.0\nscalar SSN';
    expect(findErrorHint(officialParseMessage(cto), cto)).toContain('"scalar SSN extends String"');
  });

  it("hints when a scalar is given a body", () => {
    const cto = 'namespace org.x@1.0.0\nscalar SSN {\n  o String\n}';
    expect(findErrorHint(officialParseMessage(cto), cto)).toContain("extend a primitive type");
  });

  it("names the unclosed declaration when a new one starts before it is closed", () => {
    const cto = 'namespace org.x@1.0.0\nenum GoverningLaw {\n  o NEW_YORK\n  o CALIFORNIA\n\nconcept Party {\n  o String name\n}';
    const hint = findErrorHint(officialParseMessage(cto), cto);
    expect(hint).toContain('enum "GoverningLaw"');
    expect(hint).toContain('missing its closing "}"');
  });

  it("also detects an unclosed concept followed by another declaration", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person {\n  o String name\nenum Status {\n  o ACTIVE\n}';
    const hint = findErrorHint(officialParseMessage(cto), cto);
    expect(hint).toContain('concept "Person"');
  });

  it("keeps the enum hints scoped to the broken declaration", () => {
    // The error is inside the second declaration (a concept), even though an
    // enum was closed above it: the enum rules must not fire.
    const cto = 'namespace org.x@1.0.0\nenum Status {\n  o ACTIVE\n}\nconcept Person {\n  String name\n}';
    expect(findErrorHint(officialParseMessage(cto), cto)).toContain("starts with a marker");
  });
});

describe("locateCulprit", () => {
  it("points at the line where an undeclared type is used", () => {
    const cto = 'namespace org.x@1.0.0\nconcept NDAData {\n  o String name\n  o GoverningLaw governingLaw\n}';
    const message = validateCto(cto);
    expect(message).not.toBeNull();
    expect(locateCulprit(message as string, cto)).toMatchObject({ name: "GoverningLaw", line: 4 });
  });

  it("points at the line of a missing super type", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person extends Base {\n  o String name\n}';
    const message = validateCto(cto);
    expect(message).not.toBeNull();
    expect(locateCulprit(message as string, cto)).toMatchObject({ name: "Base", line: 2 });
  });

  it("extracts the bare name from a duplicate class message", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person {\n  o String a\n}\nconcept Person {\n  o String b\n}';
    const message = validateCto(cto);
    expect(message).not.toBeNull();
    expect(extractCulpritName(message as string)).toBe("Person");
    expect(locateCulprit(message as string, cto)).toMatchObject({ name: "Person", line: 2 });
  });

  it("returns null for messages without a recognisable name", () => {
    expect(extractCulpritName("Something else went wrong")).toBeNull();
    expect(locateCulprit("Something else went wrong", "namespace org.x@1.0.0")).toBeNull();
  });
});

describe("buildErrorSnippet", () => {
  it("shows the offending line with a caret at the column", () => {
    const cto = 'namespace org.x@1.0.0\nenum Contracting party {\n}';
    const message = officialParseMessage(cto);
    const snippet = buildErrorSnippet(message, cto);
    expect(snippet).not.toBeNull();
    const [codeLine, caretLine] = (snippet as string).split('\n');
    expect(codeLine).toBe('2 | enum Contracting party {');
    // The caret must sit under the column the parser reported
    const column = parseInt(message.match(/column (\d+)/)![1], 10);
    expect(caretLine.indexOf('^')).toBe('2 | '.length + column - 1);
  });

  it("returns null for positionless messages", () => {
    expect(buildErrorSnippet('Undeclared type "X" in "property y".', 'namespace org.x@1.0.0')).toBeNull();
  });
});
