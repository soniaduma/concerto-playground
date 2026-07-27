import { describe, it, expect } from "vitest";
import { declarationEqual, stringArrayEqual } from "../../utils/graph/modelDiff";
import { parseCto } from "../../utils/graph/ctoToGraph";
import type { Declaration } from "../../utils/graph/types";

const CTO = `namespace org.test@1.0.0

enum Status {
  o ACTIVE
  o INACTIVE
}

concept Person identified by email {
  @Term("electronic mail")
  o String email regex=/.+@.+/
  o Integer age range=[0,150] optional
  o Status status default="ACTIVE"
  --> Person manager optional
}

scalar Year extends Integer range=[1886, ]

map Registry {
  o String
  o Person
}
`;

function decls(): Declaration[] {
  return parseCto(CTO).declarations;
}

describe("stringArrayEqual", () => {
  it("treats same content as equal and different content as unequal", () => {
    expect(stringArrayEqual(["a", "b"], ["a", "b"])).toBe(true);
    expect(stringArrayEqual(["a", "b"], ["b", "a"])).toBe(false);
    expect(stringArrayEqual(["a"], ["a", "b"])).toBe(false);
    expect(stringArrayEqual(undefined, undefined)).toBe(true);
    expect(stringArrayEqual([], undefined)).toBe(false);
  });
});

describe("declarationEqual", () => {
  it("re-parsed declarations are structurally equal despite new references", () => {
    const first = decls();
    const second = decls();
    for (let i = 0; i < first.length; i++) {
      expect(first[i]).not.toBe(second[i]);
      expect(declarationEqual(first[i], second[i])).toBe(true);
    }
  });

  it("detects a changed property", () => {
    const a = decls().find((d) => d.name === "Person")!;
    const b = decls().find((d) => d.name === "Person")!;
    b.properties[1] = { ...b.properties[1], isOptional: false };
    expect(declarationEqual(a, b)).toBe(false);
  });

  it("detects a changed validator", () => {
    const a = decls().find((d) => d.name === "Person")!;
    const b = decls().find((d) => d.name === "Person")!;
    b.properties[0] = {
      ...b.properties[0],
      validators: { ...b.properties[0].validators, regex: "/other/" },
    };
    expect(declarationEqual(a, b)).toBe(false);
  });

  it("detects changed enum values", () => {
    const a = decls().find((d) => d.name === "Status")!;
    const b = decls().find((d) => d.name === "Status")!;
    b.enumValues = [...b.enumValues, "PENDING"];
    expect(declarationEqual(a, b)).toBe(false);
  });

  it("detects changed decorators", () => {
    const a = decls().find((d) => d.name === "Person")!;
    const b = decls().find((d) => d.name === "Person")!;
    b.properties[0] = { ...b.properties[0] };
    b.decorators = [...b.decorators, { name: "deprecated", args: [] }];
    expect(declarationEqual(a, b)).toBe(false);
  });

  it("detects changed map key/value types", () => {
    const a = decls().find((d) => d.name === "Registry")!;
    const b = decls().find((d) => d.name === "Registry")!;
    b.mapDeclaration = { ...b.mapDeclaration!, valueType: "String" };
    expect(declarationEqual(a, b)).toBe(false);
  });

  it("detects changed scalar constraints", () => {
    const a = decls().find((d) => d.name === "Year")!;
    const b = decls().find((d) => d.name === "Year")!;
    b.scalarValidators = { ...b.scalarValidators, range: "[1900,]" };
    expect(declarationEqual(a, b)).toBe(false);
  });

  it("detects a changed supertype and abstract flag", () => {
    const a = decls().find((d) => d.name === "Person")!;
    const asAbstract = { ...a, isAbstract: true };
    const withSuper = { ...a, superType: "Base" };
    expect(declarationEqual(a, asAbstract)).toBe(false);
    expect(declarationEqual(a, withSuper)).toBe(false);
  });
});
