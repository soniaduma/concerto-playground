import { useCallback, useEffect, useRef } from "react";
import type { Node, NodeChange, OnNodesChange } from "@xyflow/react";

/**
 * Throttles React Flow node change events to one state update per animation
 * frame. Dragging a node (or a selected cluster) emits a position change per
 * pointer move, which can be several per frame; applying each one forces its
 * own React commit and layout pass mid-frame. Queuing them and applying the
 * whole batch in requestAnimationFrame keeps drag updates in lockstep with
 * the browser's paint cycle.
 *
 * Change order is preserved, so selection, dimension and remove events stay
 * correct; they just land at the next frame boundary.
 */
export function useRafBatchedNodeChanges(apply: OnNodesChange<Node>): OnNodesChange<Node> {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  const queueRef = useRef<NodeChange<Node>[]>([]);
  const frameRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      queueRef.current = [];
    },
    [],
  );

  return useCallback((changes: NodeChange<Node>[]) => {
    queueRef.current.push(...changes);
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const queued = queueRef.current;
      queueRef.current = [];
      applyRef.current(queued);
    });
  }, []);
}
