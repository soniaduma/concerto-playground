import { describe, it, expect } from "vitest";
import { parseCto } from "../../utils/graph/ctoToGraph";
import { collectSemanticIssues } from "../../utils/semanticErrors";

function issuesFor(cto: string) {
  return collectSemanticIssues(parseCto(cto), cto);
}

describe("collectSemanticIssues", () => {
  it("returns no issues for a valid model", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person {\n  o String name\n}';
    expect(issuesFor(cto)).toHaveLength(0);
  });

  it("lists every property that uses a missing type, with its line", () => {
    const cto = [
      'namespace org.x@1.0.0',
      'concept NDAData {',
      '  o GoverningLaw governingLaw',
      '  o String title',
      '  o GoverningLaw fallbackLaw',
      '}',
    ].join('\n');
    const issues = issuesFor(cto);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({ line: 3, name: 'GoverningLaw' });
    expect(issues[0].text).toContain('"governingLaw"');
    expect(issues[1]).toMatchObject({ line: 5, name: 'GoverningLaw' });
    expect(issues[1].text).toContain('"fallbackLaw"');
  });

  it("reports several different problems at once", () => {
    const cto = [
      'namespace org.x@1.0.0',
      'concept Person extends Base {',
      '  o Address home',
      '}',
      'concept Person {',
      '  o String name',
      '}',
    ].join('\n');
    const issues = issuesFor(cto);
    const texts = issues.map((i) => i.text).join('\n');
    expect(texts).toContain('declared more than once');
    expect(texts).toContain('extends "Base"');
    expect(texts).toContain('Type "Address" does not exist');
    expect(issues).toHaveLength(3);
  });

  it("locates the duplicate at its second declaration", () => {
    const cto = 'namespace org.x@1.0.0\nconcept Person {\n  o String a\n}\nconcept Person {\n  o String b\n}';
    const issues = issuesFor(cto);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ name: 'Person', line: 5 });
  });

  it("treats explicitly imported types as known", () => {
    const cto = 'namespace org.x@1.0.0\nimport org.other@1.0.0.{Address}\nconcept Person {\n  o Address home\n}';
    expect(issuesFor(cto)).toHaveLength(0);
  });

  it("treats single-type imports as known", () => {
    const cto = 'namespace org.x@1.0.0\nimport org.other.Address\nconcept Person {\n  o Address home\n}';
    expect(issuesFor(cto)).toHaveLength(0);
  });

  it("reports a map using a missing type", () => {
    const cto = 'namespace org.x@1.0.0\nmap Lookup {\n  o String\n  o Address\n}';
    const issues = issuesFor(cto);
    expect(issues).toHaveLength(1);
    expect(issues[0].text).toContain('"Address"');
  });
});
