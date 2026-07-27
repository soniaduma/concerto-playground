import { describe, it, expect } from "vitest";
import { parseCto, declarationsToGraph } from "../../utils/graph/ctoToGraph";

const BASE_CTO = `namespace org.test@1.0.0

concept Address {
  o String street
}

concept Person {
  o String name
  o Address home
}
`;

function graphFor(cto: string, context?: Parameters<typeof declarationsToGraph>[1]) {
  return declarationsToGraph(parseCto(cto).declarations, context);
}

describe("declarationsToGraph incremental updates", () => {
  it("runs the full layout when no previous graph is given", () => {
    const { nodes, edges } = graphFor(BASE_CTO);
    expect(nodes).toHaveLength(2);
    expect(edges).toHaveLength(1);
    // Person references Address, so they land in different layout columns.
    const [a, b] = nodes;
    expect(a.position.x).not.toBe(b.position.x);
  });

  it("reuses node and edge objects when nothing changed", () => {
    const first = graphFor(BASE_CTO);
    const second = graphFor(BASE_CTO, {
      previousNodes: first.nodes,
      previousEdges: first.edges,
    });
    for (let i = 0; i < first.nodes.length; i++) {
      expect(second.nodes[i]).toBe(first.nodes[i]);
    }
    for (let i = 0; i < first.edges.length; i++) {
      expect(second.edges[i]).toBe(first.edges[i]);
    }
  });

  it("adding a declaration keeps every existing node in place", () => {
    const first = graphFor(BASE_CTO);
    // Simulate the user having dragged Person somewhere specific.
    const dragged = first.nodes.map((n) =>
      n.id === "Person" ? { ...n, position: { x: 999, y: 111 } } : n,
    );

    const withNew = BASE_CTO + `
concept Company {
  o Person ceo
}
`;
    const result = graphFor(withNew, {
      previousNodes: dragged,
      previousEdges: first.edges,
    });

    const person = result.nodes.find((n) => n.id === "Person")!;
    expect(person.position).toEqual({ x: 999, y: 111 });
    // Untouched Person and Address keep their exact object references.
    expect(person).toBe(dragged.find((n) => n.id === "Person"));
    expect(result.nodes.find((n) => n.id === "Address")).toBe(
      dragged.find((n) => n.id === "Address"),
    );
    // The new node is placed next to its neighbor's column, not at origin.
    const company = result.nodes.find((n) => n.id === "Company")!;
    expect(company.position.x).toBe(999 + 380);
  });

  it("a changed declaration keeps its position but gets fresh data", () => {
    const first = graphFor(BASE_CTO);
    const dragged = first.nodes.map((n) =>
      n.id === "Address" ? { ...n, position: { x: -50, y: 400 } } : n,
    );

    const changed = BASE_CTO.replace("o String street", "o String street\n  o String city");
    const result = graphFor(changed, {
      previousNodes: dragged,
      previousEdges: first.edges,
    });

    const address = result.nodes.find((n) => n.id === "Address")!;
    expect(address).not.toBe(dragged.find((n) => n.id === "Address"));
    expect(address.position).toEqual({ x: -50, y: 400 });
    const decl = address.data.declaration as { properties: unknown[] };
    expect(decl.properties).toHaveLength(2);
  });

  it("a re-added declaration takes its remembered position", () => {
    const first = graphFor(BASE_CTO);
    const withoutPerson = graphFor(
      `namespace org.test@1.0.0\n\nconcept Address {\n  o String street\n}\n`,
      { previousNodes: first.nodes, previousEdges: first.edges },
    );
    const result = graphFor(BASE_CTO, {
      previousNodes: withoutPerson.nodes,
      previousEdges: withoutPerson.edges,
      savedPositions: new Map([["Person", { x: 123, y: 456 }]]),
    });
    expect(result.nodes.find((n) => n.id === "Person")!.position).toEqual({ x: 123, y: 456 });
  });

  it("an unconnected new declaration is appended below the graph", () => {
    const first = graphFor(BASE_CTO);
    const withLoner = BASE_CTO + `
enum Status {
  o ACTIVE
}
`;
    const result = graphFor(withLoner, {
      previousNodes: first.nodes,
      previousEdges: first.edges,
    });
    const loner = result.nodes.find((n) => n.id === "Status")!;
    const others = result.nodes.filter((n) => n.id !== "Status");
    const bottom = Math.max(...others.map((n) => n.position.y));
    expect(loner.position.y).toBeGreaterThan(bottom);
  });

  it("a model with no surviving declarations falls back to the full layout", () => {
    const first = graphFor(BASE_CTO);
    const fresh = `namespace org.other@1.0.0

concept Engine {
  o String code
}

concept Car {
  o Engine engine
}
`;
    const result = graphFor(fresh, {
      previousNodes: first.nodes,
      previousEdges: first.edges,
    });
    expect(result.nodes).toHaveLength(2);
    const xs = new Set(result.nodes.map((n) => n.position.x));
    // Tree layout: connected declarations spread across columns.
    expect(xs.size).toBe(2);
  });
});
