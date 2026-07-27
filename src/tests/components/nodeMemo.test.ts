import { describe, it, expect } from "vitest";
import { nodePropsEqual } from "../../components/graph/nodeMemo";
import { parseCto } from "../../utils/graph/ctoToGraph";
import type { Declaration } from "../../utils/graph/types";

const CTO = `namespace org.test@1.0.0

concept Person {
  o String name
}
`;

function personDecl(): Declaration {
  return parseCto(CTO).declarations[0];
}

function props(overrides: Partial<{
  id: string;
  selected: boolean;
  declaration: Declaration;
  edgeProperties: string[];
  onDelete: () => void;
}> = {}) {
  return {
    id: overrides.id ?? "Person",
    selected: overrides.selected ?? false,
    data: {
      label: "Person",
      declaration: overrides.declaration ?? personDecl(),
      edgeProperties: overrides.edgeProperties ?? [],
      onDeleteDeclaration: overrides.onDelete ?? sharedCallback,
    },
  };
}

const sharedCallback = () => {};

describe("nodePropsEqual", () => {
  it("treats a re-parse with identical content as equal (blocks the render)", () => {
    // Two separate parses: fresh object references, same content.
    expect(nodePropsEqual(props(), props())).toBe(true);
  });

  it("re-renders when the declaration content changed", () => {
    const changed = personDecl();
    changed.properties = [
      ...changed.properties,
      { name: "age", type: "Integer", isOptional: false, isArray: false, isRelationship: false, validators: {} },
    ];
    expect(nodePropsEqual(props(), props({ declaration: changed }))).toBe(false);
  });

  it("re-renders when selection changes", () => {
    expect(nodePropsEqual(props({ selected: false }), props({ selected: true }))).toBe(false);
  });

  it("re-renders when edge anchors change", () => {
    expect(
      nodePropsEqual(props({ edgeProperties: [] }), props({ edgeProperties: ["home"] })),
    ).toBe(false);
  });

  it("re-renders when an injected callback identity changes", () => {
    expect(nodePropsEqual(props(), props({ onDelete: () => {} }))).toBe(false);
  });

  it("ignores position-style props that the components do not render", () => {
    const prev = { ...props(), positionAbsoluteX: 0, positionAbsoluteY: 0, dragging: false };
    const next = { ...props(), positionAbsoluteX: 500, positionAbsoluteY: 300, dragging: true };
    expect(nodePropsEqual(prev, next)).toBe(true);
  });
});
