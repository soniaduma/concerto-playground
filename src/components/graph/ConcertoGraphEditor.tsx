import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  Controls,
  type NodeTypes,
  type EdgeTypes,
  type Connection,
  type Node,
  type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { ConceptNode } from './ConceptNode';
import { EnumNode } from './EnumNode';
import { MapNode } from './MapNode';
import { ScalarNode } from './ScalarNode';
import { ImportedNode } from './ImportedNode';
import { FloatingEdge } from './FloatingEdge';
import { GraphToolbar } from './GraphToolbar';
import { NodeSearch } from './NodeSearch';
import { useFocusNode } from './useFocusNode';
import { SHORTCUT_STRINGS, TOOLBAR_STRINGS } from './strings';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { SHORTCUT_COMBOS } from '../../utils/shortcutCombos';
import { parseCto, declarationsToGraph, describeParseError, type GraphContext } from '../../utils/graph/ctoToGraph';
import { findErrorHint, locateCulprit, parseErrorPosition, buildSnippet, stripPosition } from '../../utils/errorHints';
import { declarationsToCto } from '../../utils/graph/graphToCto';
import { useRafBatchedNodeChanges } from '../../hooks/useRafBatchedNodeChanges';
import type { Declaration, ConcertoModel } from '../../utils/graph/types';

const nodeTypes: NodeTypes = {
  conceptNode: ConceptNode,
  enumNode: EnumNode,
  mapNode: MapNode,
  scalarNode: ScalarNode,
  importedNode: ImportedNode,
};

const edgeTypes: EdgeTypes = {
  floating: FloatingEdge,
};

interface ConcertoGraphEditorProps {
  cto: string;
  onModelChange?: (cto: string) => void;
  showText: boolean;
  onToggleText: () => void;
  onImport: () => void;
  onExport: () => void;
  /** When this changes, the graph centers on and highlights the named node.
      A namespace means the focus waits until that namespace's graph loaded. */
  focusRequest?: { name: string; namespace?: string; ts: number } | null;
  /** Semantic validation error for the current model (from validateCto). */
  validationError?: string | null;
  /** Workspace info used to render imported (foreign namespace) type nodes. */
  graphContext?: GraphContext;
  /** Called when an imported node is clicked, to switch to its namespace. */
  onNavigateToType?: (name: string, namespace: string) => void;
}

interface HistoryEntry {
  model: ConcertoModel;
  nodes: Node[];
  edges: Edge[];
}

const MAX_HISTORY = 50;

// Debounces an error value: shows it only after `delay` ms of stability, so
// banners do not flash on every keystroke, and clears it immediately when it
// becomes null.
function useDebouncedError<T>(value: T | null, delay: number): T | null {
  const [debounced, setDebounced] = useState<T | null>(null);
  useEffect(() => {
    if (value === null) {
      setDebounced(null);
      return;
    }
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function ConcertoGraphEditor({ cto, onModelChange, showText, onToggleText, onImport, onExport, focusRequest, validationError, graphContext, onNavigateToType }: ConcertoGraphEditorProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [model, setModelState] = useState<ConcertoModel>({ namespace: 'org.example@1.0.0', imports: [], declarations: [] });
  const modelRef = useRef(model);
  const setModel = useCallback((m: ConcertoModel) => { modelRef.current = m; setModelState(m); }, []);
  const [rawParseError, setRawParseError] = useState<{ message: string; hint: string | null; snippet: string | null } | null>(null);
  const parseError = useDebouncedError(rawParseError, 600);
  const [activeDialog, setActiveDialog] = useState<{ type: 'property' | 'enum-value' | 'inheritance'; declName: string } | null>(null);
  const [connectDialog, setConnectDialog] = useState<{ sourceId: string; targetId: string } | null>(null);
  const updatingFromGraph = useRef(false);

  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  // Mirror of historyIndex so pushHistory can stay referentially stable; the
  // node-injected callbacks depend on it and must not change identity on
  // every push, or the memoized nodes would re-render for nothing.
  const historyIndexRef = useRef(-1);
  const isUndoRedo = useRef(false);

  const nodePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  // Mirrors of the current graph state, read by the incremental sync without
  // making the sync effect depend on (and re-run for) every nodes change.
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  // The parent's onModelChange is recreated per render; a ref keeps the graph
  // mutation callbacks stable so memoized nodes are not invalidated.
  const onModelChangeRef = useRef(onModelChange);
  onModelChangeRef.current = onModelChange;

  // The semantic validation error shown in the overlay banner when the text
  // parses but the model is invalid. The snippet points a caret at the
  // culprit name, the same way parse errors point at their position.
  const rawSemanticError = useMemo(() => {
    if (!validationError) return null;
    const culprit = locateCulprit(validationError, cto);
    return {
      message: validationError,
      hint: findErrorHint(validationError, cto),
      snippet: culprit ? buildSnippet(cto, culprit.line, culprit.column) : null,
    };
  }, [validationError, cto]);
  const semanticError = useDebouncedError(rawSemanticError, 600);

  // Latest workspace context, readable from callbacks without re-creating them.
  const graphContextRef = useRef(graphContext);
  graphContextRef.current = graphContext;
  // Tracks the last CTO pushed to history so a graphContext-only change
  // (e.g. a peer namespace appearing) refreshes the graph without adding a
  // duplicate undo entry.
  const lastHistoryCtoRef = useRef<string | null>(null);

  useEffect(() => {
    nodesRef.current = nodes;
    for (const node of nodes) {
      nodePositionsRef.current.set(node.id, { ...node.position });
    }
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  const pushHistory = useCallback((entry: HistoryEntry) => {
    const base = historyIndexRef.current;
    setHistory((prev) => {
      const truncated = prev.slice(0, base + 1);
      const next = [...truncated, entry];
      if (next.length > MAX_HISTORY) next.shift();
      return next;
    });
    const nextIndex = Math.min(base + 1, MAX_HISTORY - 1);
    historyIndexRef.current = nextIndex;
    setHistoryIndex(nextIndex);
  }, []);

  useEffect(() => {
    if (updatingFromGraph.current) {
      updatingFromGraph.current = false;
      return;
    }
    try {
      const parsed = parseCto(cto);
      setModel(parsed);
      // Incremental sync: unchanged declarations keep their exact node
      // objects, changed ones keep their position, and only new declarations
      // are placed. Nothing else moves, and memoized nodes skip re-rendering.
      const graph = declarationsToGraph(parsed.declarations, {
        ...graphContext,
        previousNodes: nodesRef.current,
        previousEdges: edgesRef.current,
        savedPositions: nodePositionsRef.current,
      });
      setNodes(graph.nodes);
      setEdges(graph.edges);
      if (!isUndoRedo.current && lastHistoryCtoRef.current !== cto) {
        pushHistory({ model: parsed, nodes: graph.nodes, edges: graph.edges });
        lastHistoryCtoRef.current = cto;
      }
      isUndoRedo.current = false;
      setRawParseError(null);
    } catch (e) {
      // Keep the last valid graph on screen while the user is typing, but
      // report the parse error in an overlay banner instead of dropping it
      // (debounced above so it does not flash while typing).
      const message = describeParseError(e);
      const position = parseErrorPosition(message);
      setRawParseError({
        message,
        hint: findErrorHint(message, cto),
        snippet: position ? buildSnippet(cto, position.line, position.column) : null,
      });
    }
  }, [cto, graphContext, setNodes, setEdges]);

  const updateModelAndSync = useCallback((newDeclarations: Declaration[]) => {
    const cur = modelRef.current;
    const newModel = { ...cur, declarations: newDeclarations };
    const newCto = declarationsToCto(newModel);
    setModel(newModel);
    const graph = declarationsToGraph(newDeclarations, {
      ...graphContextRef.current,
      previousNodes: nodesRef.current,
      previousEdges: edgesRef.current,
      savedPositions: nodePositionsRef.current,
    });
    setNodes(graph.nodes);
    setEdges(graph.edges);
    pushHistory({ model: newModel, nodes: graph.nodes, edges: graph.edges });
    // A graph edit regenerates the CTO from the last valid model, so any
    // pending text parse error is now stale.
    setRawParseError(null);
    lastHistoryCtoRef.current = newCto;
    updatingFromGraph.current = true;
    onModelChangeRef.current?.(newCto);
  }, [setModel, setNodes, setEdges, pushHistory]);

  const handleAddDeclaration = useCallback((decl: Declaration) => {
    updateModelAndSync([...modelRef.current.declarations, decl]);
  }, [updateModelAndSync]);

  const handleDeleteDeclaration = useCallback((declName: string) => {
    const remaining = modelRef.current.declarations.filter((d) => d.name !== declName);
    const cleaned = remaining.map((d) => ({
      ...d,
      superType: d.superType === declName ? undefined : d.superType,
      properties: (d.properties || []).filter((p) => p.type !== declName),
    }));
    updateModelAndSync(cleaned);
  }, [updateModelAndSync]);

  const handleToggleAbstract = useCallback((declName: string) => {
    updateModelAndSync(
      modelRef.current.declarations.map((d) => d.name === declName ? { ...d, isAbstract: !d.isAbstract } : d)
    );
  }, [updateModelAndSync]);

  const handleAddProperty = useCallback((declName: string, propName: string, propType: string, isOptional: boolean, isArray: boolean, isRelationship: boolean) => {
    updateModelAndSync(
      modelRef.current.declarations.map((d) =>
        d.name === declName
          ? { ...d, properties: [...d.properties, { name: propName, type: propType, isOptional, isArray, isRelationship, validators: {} }] }
          : d
      )
    );
  }, [updateModelAndSync]);

  const handleDeleteProperty = useCallback((declName: string, propName: string) => {
    updateModelAndSync(
      modelRef.current.declarations.map((d) =>
        d.name === declName
          ? { ...d, properties: d.properties.filter((p) => p.name !== propName) }
          : d
      )
    );
  }, [updateModelAndSync]);

  const handleAddEnumValue = useCallback((declName: string, value: string) => {
    updateModelAndSync(
      modelRef.current.declarations.map((d) =>
        d.name === declName ? { ...d, enumValues: [...d.enumValues, value] } : d
      )
    );
  }, [updateModelAndSync]);

  const handleDeleteEnumValue = useCallback((declName: string, value: string) => {
    updateModelAndSync(
      modelRef.current.declarations.map((d) =>
        d.name === declName ? { ...d, enumValues: d.enumValues.filter((v) => v !== value) } : d
      )
    );
  }, [updateModelAndSync]);

  const handleSetSuperType = useCallback((declName: string, superType: string | undefined) => {
    updateModelAndSync(
      modelRef.current.declarations.map((d) => d.name === declName ? { ...d, superType } : d)
    );
  }, [updateModelAndSync]);

  const handleUndo = useCallback(() => {
    if (historyIndex <= 0) return;
    const newIndex = historyIndex - 1;
    const entry = history[newIndex];
    isUndoRedo.current = true;
    historyIndexRef.current = newIndex;
    setHistoryIndex(newIndex);
    setModel(entry.model);
    setNodes(entry.nodes);
    setEdges(entry.edges);
    for (const node of entry.nodes) {
      nodePositionsRef.current.set(node.id, { ...node.position });
    }
    setRawParseError(null);
    updatingFromGraph.current = true;
    const entryCto = declarationsToCto(entry.model);
    lastHistoryCtoRef.current = entryCto;
    onModelChangeRef.current?.(entryCto);
  }, [history, historyIndex, setModel, setNodes, setEdges]);

  const handleRedo = useCallback(() => {
    if (historyIndex >= history.length - 1) return;
    const newIndex = historyIndex + 1;
    const entry = history[newIndex];
    isUndoRedo.current = true;
    historyIndexRef.current = newIndex;
    setHistoryIndex(newIndex);
    setModel(entry.model);
    setNodes(entry.nodes);
    setEdges(entry.edges);
    for (const node of entry.nodes) {
      nodePositionsRef.current.set(node.id, { ...node.position });
    }
    setRawParseError(null);
    updatingFromGraph.current = true;
    const entryCto = declarationsToCto(entry.model);
    lastHistoryCtoRef.current = entryCto;
    onModelChangeRef.current?.(entryCto);
  }, [history, historyIndex, setModel, setNodes, setEdges]);

  // Escape closes the topmost overlay only: dialogs render above the search
  // panel, so they go first.
  const closeTopOverlay = useCallback(() => {
    if (connectDialog) setConnectDialog(null);
    else if (activeDialog) setActiveDialog(null);
    else setSearchOpen(false);
  }, [connectDialog, activeDialog]);

  const handleClearCanvas = useCallback(() => {
    if (modelRef.current.declarations.length === 0) return;
    if (!window.confirm(TOOLBAR_STRINGS.clearConfirm)) return;
    nodePositionsRef.current.clear();
    updateModelAndSync([]);
  }, [updateModelAndSync]);

  useKeyboardShortcuts([
    { ...SHORTCUT_COMBOS.undo, description: SHORTCUT_STRINGS.undo, category: SHORTCUT_STRINGS.categoryEditing, handler: handleUndo },
    { ...SHORTCUT_COMBOS.redoPrimary, description: SHORTCUT_STRINGS.redo, category: SHORTCUT_STRINGS.categoryEditing, handler: handleRedo },
    { ...SHORTCUT_COMBOS.redoAlt, description: SHORTCUT_STRINGS.redo, category: SHORTCUT_STRINGS.categoryEditing, handler: handleRedo },
    { ...SHORTCUT_COMBOS.clearCanvas, description: SHORTCUT_STRINGS.clearCanvas, category: SHORTCUT_STRINGS.categoryEditing, handler: handleClearCanvas },
    { ...SHORTCUT_COMBOS.searchNodes, allowInInput: true, description: SHORTCUT_STRINGS.searchNodes, category: SHORTCUT_STRINGS.categoryNavigation, handler: () => setSearchOpen((v) => !v) },
    {
      ...SHORTCUT_COMBOS.closeDialog,
      allowInInput: true,
      enabled: searchOpen || activeDialog !== null || connectDialog !== null,
      description: SHORTCUT_STRINGS.closeDialog,
      category: SHORTCUT_STRINGS.categoryNavigation,
      handler: closeTopOverlay,
    },
  ]);

  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  // Parse errors win over semantic ones: unparseable text cannot be
  // semantically validated anyway, so the parse message is the actionable one.
  const bannerError = parseError ?? semanticError;

  const onNodeDragStop = useCallback((_event: React.MouseEvent, _node: Node, draggedNodes: Node[]) => {
    // The rAF-batched change queue may still be one frame behind at drag
    // stop; the event carries the final positions, so record them first.
    for (const dragged of draggedNodes) {
      nodePositionsRef.current.set(dragged.id, { ...dragged.position });
    }
    const currentNodes = nodes.map((n) => {
      const pos = nodePositionsRef.current.get(n.id);
      return pos ? { ...n, position: pos } : n;
    });
    pushHistory({ model: modelRef.current, nodes: currentNodes, edges });
  }, [nodes, edges, pushHistory]);

  // Routes React Flow's Delete/Backspace removals through the model, so a
  // keyboard delete updates the CTO instead of being reverted on the next
  // sync. Mirrors the cleanup done by handleDeleteDeclaration.
  const onDeleteSelection = useCallback(({ nodes: deletedNodes, edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) => {
    if (deletedNodes.length === 0 && deletedEdges.length === 0) return;
    const deletedNames = new Set(deletedNodes.map((n) => n.id));
    let decls = modelRef.current.declarations
      .filter((d) => !deletedNames.has(d.name))
      .map((d) => ({
        ...d,
        superType: d.superType && deletedNames.has(d.superType) ? undefined : d.superType,
        properties: (d.properties || []).filter((p) => !deletedNames.has(p.type)),
      }));
    for (const edge of deletedEdges) {
      // Edges attached to a deleted node are already gone with the node.
      if (deletedNames.has(edge.source) || deletedNames.has(edge.target)) continue;
      const handle = edge.sourceHandle ?? '';
      if (handle.startsWith('prop:')) {
        const propName = handle.slice('prop:'.length);
        decls = decls.map((d) =>
          d.name === edge.source ? { ...d, properties: d.properties.filter((p) => p.name !== propName) } : d
        );
      } else if (edge.id === `${edge.source}-extends-${edge.target}`) {
        decls = decls.map((d) => (d.name === edge.source ? { ...d, superType: undefined } : d));
      }
    }
    updateModelAndSync(decls);
  }, [updateModelAndSync]);

  // Drag coordinates arrive faster than the display refreshes; batching them
  // into one state update per animation frame keeps cluster drags smooth.
  const handleNodesChange = useRafBatchedNodeChanges(onNodesChange);

  const onConnect = useCallback((connection: Connection) => {
    if (connection.source && connection.target && connection.source !== connection.target) {
      // Imported nodes use namespace-qualified ids; a property created against
      // one references the short name (the import statement already exists).
      const targetNode = nodes.find((n) => n.id === connection.target);
      const targetId = targetNode?.type === 'importedNode'
        ? (targetNode.data as { label: string }).label
        : connection.target;
      setConnectDialog({ sourceId: connection.source, targetId });
    }
  }, [nodes]);

  const handleConnectSubmit = useCallback((connType: 'property' | 'relationship' | 'extends', propName: string) => {
    if (!connectDialog) return;
    const { sourceId, targetId } = connectDialog;
    if (connType === 'extends') {
      handleSetSuperType(sourceId, targetId);
    } else {
      handleAddProperty(sourceId, propName, targetId, false, false, connType === 'relationship');
    }
    setConnectDialog(null);
  }, [connectDialog, handleSetSuperType, handleAddProperty]);

  const openPropertyDialog = useCallback((declName: string) => setActiveDialog({ type: 'property', declName }), []);
  const openInheritanceDialog = useCallback((declName: string) => setActiveDialog({ type: 'inheritance', declName }), []);
  const openEnumValueDialog = useCallback((declName: string) => setActiveDialog({ type: 'enum-value', declName }), []);
  // The parent's onNavigateToType may change identity per render; a ref-backed
  // wrapper keeps the node-injected callback stable so memoized nodes and the
  // wrap cache below are not invalidated.
  const onNavigateToTypeRef = useRef(onNavigateToType);
  onNavigateToTypeRef.current = onNavigateToType;
  const handleNavigateToType = useCallback(
    (name: string, namespace: string) => onNavigateToTypeRef.current?.(name, namespace),
    [],
  );

  // Injects the (all stable) callbacks into each node's data. The WeakMap
  // keyed on the underlying node object keeps the wrapped object identical
  // for nodes the incremental sync reused, so memoized node components can
  // skip on reference equality alone.
  const wrapCache = useRef(new WeakMap<Node, Node>());
  const nodesWithCallbacks = useMemo(() => nodes.map((node) => {
    const cached = wrapCache.current.get(node);
    if (cached) return cached;
    const wrapped: Node = {
      ...node,
      data: {
        ...node.data,
        onAddProperty: openPropertyDialog,
        onDeleteProperty: handleDeleteProperty,
        onDeleteDeclaration: handleDeleteDeclaration,
        onToggleAbstract: handleToggleAbstract,
        onSetInheritance: openInheritanceDialog,
        onAddEnumValue: openEnumValueDialog,
        onDeleteEnumValue: handleDeleteEnumValue,
        onNavigateToType: handleNavigateToType,
      },
    };
    wrapCache.current.set(node, wrapped);
    return wrapped;
  }), [
    nodes,
    openPropertyDialog,
    handleDeleteProperty,
    handleDeleteDeclaration,
    handleToggleAbstract,
    openInheritanceDialog,
    openEnumValueDialog,
    handleDeleteEnumValue,
    handleNavigateToType,
  ]);

  return (
    <ReactFlowProvider>
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <GraphToolbar
        declarations={model.declarations}
        onAddDeclaration={handleAddDeclaration}
        onAddProperty={handleAddProperty}
        onAddEnumValue={handleAddEnumValue}
        onSetSuperType={handleSetSuperType}
        activeDialog={activeDialog}
        onCloseDialog={() => setActiveDialog(null)}
        onClearCanvas={handleClearCanvas}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={canUndo}
        canRedo={canRedo}
        onOpenSearch={() => setSearchOpen(true)}
        showText={showText}
        onToggleText={onToggleText}
        onImport={onImport}
        onExport={onExport}
      />
      <div style={{ flex: 1, position: 'relative' }}>
        <ReactFlow
          nodes={nodesWithCallbacks}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onDelete={onDeleteSelection}
          deleteKeyCode={['Backspace', 'Delete']}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onlyRenderVisibleElements
          fitView
          fitViewOptions={{ padding: 0.3 }}
          style={{ background: '#1a202c' }}
          connectionLineStyle={{ stroke: '#63b3ed', strokeWidth: 2 }}
          minZoom={0.05}
          maxZoom={4}
          panActivationKeyCode={null}
          proOptions={{ hideAttribution: true }}
        >
           <Controls />
          <Background variant={BackgroundVariant.Dots} color="#4a5568" gap={20} size={1} />
        </ReactFlow>

        {bannerError && (
          <div
            role="alert"
            className="absolute top-2 left-2 right-2 z-10 px-3.5 py-2.5 rounded-md border border-[#e53e3e] bg-[#742a2a]/55 backdrop-blur-[3px] text-[13px] leading-normal text-[#fed7d7] max-h-[45vh] overflow-hidden pointer-events-none"
          >
            <div className="font-semibold mb-0.5">
              {parseError ? 'Schema parse error' : 'Schema error'}
            </div>
            {/* Lead with the friendly hint; the raw parser/validator message
                stays on the left editor's squiggle. Fall back to the raw
                message when no hint matches this error. */}
            <div className="whitespace-pre-wrap [overflow-wrap:anywhere] pointer-events-auto select-text">
              {bannerError.hint ?? stripPosition(bannerError.message)}
            </div>
            {/* Every banner points at its location the same way: a code
                excerpt with a caret under the offending column. */}
            {bannerError.snippet && (
              <pre className="my-1.5 font-['Fira_Code','Cascadia_Code',Consolas,monospace] overflow-x-auto pointer-events-auto select-text">
                {bannerError.snippet}
              </pre>
            )}
            {parseError && (
              <div className="mt-1 opacity-75">
                Showing the last valid graph. Fix the text on the left to update it.
              </div>
            )}
          </div>
        )}

        <FocusController focusRequest={focusRequest} currentNamespace={model.namespace} />

        {searchOpen && (
          <NodeSearch
            declarations={model.declarations}
            onClose={() => setSearchOpen(false)}
          />
        )}

        {connectDialog && (
          <ConnectEdgeDialog
            sourceId={connectDialog.sourceId}
            targetId={connectDialog.targetId}
            onSubmit={handleConnectSubmit}
            onClose={() => setConnectDialog(null)}
          />
        )}
      </div>
    </div>
    </ReactFlowProvider>
  );
}

/** Centers/highlights a node whenever focusRequest changes (e.g. a CTO link click). */
function FocusController({ focusRequest, currentNamespace }: {
  focusRequest?: { name: string; namespace?: string; ts: number } | null;
  currentNamespace: string;
}) {
  const focusNode = useFocusNode();
  const lastTs = useRef<number>(0);
  useEffect(() => {
    if (!focusRequest || focusRequest.ts === lastTs.current) return;
    // A cross-namespace request waits until the target namespace's graph is
    // loaded, otherwise the old graph's same-named node would be centered.
    // The effect re-runs when currentNamespace catches up.
    if (focusRequest.namespace && focusRequest.namespace !== currentNamespace) return;
    lastTs.current = focusRequest.ts;
    const id = requestAnimationFrame(() => focusNode(focusRequest.name));
    return () => cancelAnimationFrame(id);
  }, [focusRequest, currentNamespace, focusNode]);
  return null;
}

function ConnectEdgeDialog({ sourceId, targetId, onSubmit, onClose }: {
  sourceId: string;
  targetId: string;
  onSubmit: (type: 'property' | 'relationship' | 'extends', name: string) => void;
  onClose: () => void;
}) {
  const [connType, setConnType] = useState<'property' | 'relationship' | 'extends'>('property');
  const [propName, setPropName] = useState('');

  const handleSubmit = () => {
    if (connType === 'extends') {
      onSubmit('extends', '');
    } else {
      if (!propName.trim()) return;
      onSubmit(connType, propName.trim());
    }
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 4px', color: '#e2e8f0', fontSize: 14 }}>
          Connect: {sourceId} &rarr; {targetId}
        </h3>
        <p style={{ margin: '0 0 12px', color: '#a0aec0', fontSize: 12 }}>
          How should these be related?
        </p>

        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <button onClick={() => setConnType('property')}
            style={{ ...typeBtnStyle, background: connType === 'property' ? '#3182ce' : '#4a5568' }}>
            Property (o)
          </button>
          <button onClick={() => setConnType('relationship')}
            style={{ ...typeBtnStyle, background: connType === 'relationship' ? '#e53e3e' : '#4a5568' }}>
            Relationship (&rarr;)
          </button>
          <button onClick={() => setConnType('extends')}
            style={{ ...typeBtnStyle, background: connType === 'extends' ? '#805ad5' : '#4a5568' }}>
            Extends
          </button>
        </div>

        {connType !== 'extends' && (
          <input
            value={propName}
            onChange={(e) => setPropName(e.target.value)}
            placeholder={`Property name (e.g. my${targetId})`}
            style={inputStyle}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          />
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button onClick={handleSubmit} style={{
            ...typeBtnStyle,
            background: connType === 'property' ? '#3182ce' : connType === 'relationship' ? '#e53e3e' : '#805ad5',
          }}>
            Connect
          </button>
          <button onClick={onClose} style={typeBtnStyle}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0,0,0,0.5)', zIndex: 20,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};

const dialogStyle: React.CSSProperties = {
  background: '#2d3748', borderRadius: 12, padding: 24, minWidth: 360,
  boxShadow: '0 8px 32px rgba(0,0,0,0.5)', border: '1px solid #4a5568',
};

const typeBtnStyle: React.CSSProperties = {
  background: '#4a5568', color: '#e2e8f0', border: 'none', borderRadius: 6,
  padding: '8px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600,
  transition: 'background 0.15s',
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '10px 12px', background: '#1a202c', color: '#e2e8f0',
  border: '1px solid #4a5568', borderRadius: 6, fontSize: 13,
  outline: 'none', boxSizing: 'border-box',
};
