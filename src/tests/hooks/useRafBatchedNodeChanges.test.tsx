// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import type { NodeChange, Node } from "@xyflow/react";
import { useRafBatchedNodeChanges } from "../../hooks/useRafBatchedNodeChanges";

function positionChange(id: string, x: number, y: number): NodeChange<Node> {
  return { id, type: "position", position: { x, y } };
}

describe("useRafBatchedNodeChanges", () => {
  let frameCallbacks: Map<number, FrameRequestCallback>;
  let nextFrameId: number;

  beforeEach(() => {
    frameCallbacks = new Map();
    nextFrameId = 1;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      const id = nextFrameId++;
      frameCallbacks.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frameCallbacks.delete(id);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function runFrame() {
    const pending = [...frameCallbacks.values()];
    frameCallbacks.clear();
    pending.forEach((cb) => cb(0));
  }

  it("does not apply changes until the animation frame fires", () => {
    const apply = vi.fn();
    const { result } = renderHook(() => useRafBatchedNodeChanges(apply));

    result.current([positionChange("a", 1, 1)]);
    expect(apply).not.toHaveBeenCalled();

    runFrame();
    expect(apply).toHaveBeenCalledExactlyOnceWith([positionChange("a", 1, 1)]);
  });

  it("batches several change events into one application, in order", () => {
    const apply = vi.fn();
    const { result } = renderHook(() => useRafBatchedNodeChanges(apply));

    result.current([positionChange("a", 1, 1)]);
    result.current([positionChange("a", 2, 2), positionChange("b", 0, 0)]);
    result.current([positionChange("a", 3, 3)]);

    runFrame();
    expect(apply).toHaveBeenCalledExactlyOnceWith([
      positionChange("a", 1, 1),
      positionChange("a", 2, 2),
      positionChange("b", 0, 0),
      positionChange("a", 3, 3),
    ]);
  });

  it("requests at most one frame per batch", () => {
    const apply = vi.fn();
    const { result } = renderHook(() => useRafBatchedNodeChanges(apply));

    result.current([positionChange("a", 1, 1)]);
    result.current([positionChange("a", 2, 2)]);
    expect(frameCallbacks.size).toBe(1);

    runFrame();
    result.current([positionChange("a", 3, 3)]);
    expect(frameCallbacks.size).toBe(1);
    runFrame();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it("cancels the scheduled frame on unmount", () => {
    const apply = vi.fn();
    const { result, unmount } = renderHook(() => useRafBatchedNodeChanges(apply));

    result.current([positionChange("a", 1, 1)]);
    unmount();
    expect(frameCallbacks.size).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });
});
