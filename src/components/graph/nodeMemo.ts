import type { Declaration } from '../../utils/graph/types';
import { declarationEqual, stringArrayEqual } from '../../utils/graph/modelDiff';

// The prop surface the custom node components actually render from. React
// Flow passes more (positions, dragging, z-index), but none of it is used in
// the component output, so the comparator ignores it on purpose.
export interface ComparableNodeProps {
  id?: string;
  selected?: boolean;
  data: {
    label?: string;
    declaration: Declaration;
    edgeProperties?: string[];
  };
}

/**
 * Strict comparison for React.memo on the custom node components. A node
 * only re-renders when its declaration content, edge anchors, selection
 * state or injected callbacks change. In particular:
 *
 * - Position props are ignored: React Flow moves the node wrapper itself,
 *   the inner component never renders coordinates.
 * - Declarations are compared structurally, not by reference, because each
 *   re-parse creates fresh objects for unchanged declarations.
 * - Callbacks are compared by identity: a skipped render with a stale
 *   closure would act on outdated state, so a changed callback must render.
 */
export function nodePropsEqual<P extends ComparableNodeProps>(
  prev: Readonly<P>,
  next: Readonly<P>,
): boolean {
  if (prev.id !== next.id || prev.selected !== next.selected) return false;
  const a = prev.data as Record<string, unknown>;
  const b = next.data as Record<string, unknown>;
  if (a === b) return true;
  if (prev.data.label !== next.data.label) return false;
  if (!stringArrayEqual(prev.data.edgeProperties, next.data.edgeProperties)) return false;
  if (!declarationEqual(prev.data.declaration, next.data.declaration)) return false;
  for (const key of Object.keys(b)) {
    if (typeof b[key] === 'function' && a[key] !== b[key]) return false;
  }
  for (const key of Object.keys(a)) {
    if (typeof a[key] === 'function' && !(key in b)) return false;
  }
  return true;
}
