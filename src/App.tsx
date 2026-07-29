import { useCallback, useMemo, useState } from "react";
import LZString from "lz-string";
import JSZip from "jszip";
import { Header } from "./components/Header";
import { Editor } from "./components/Editor";
import { OutputTabs } from "./components/OutputTabs";
import { ConcertoGraphEditor } from "./components/graph/ConcertoGraphEditor";
import { FormView } from "./components/form/FormView";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ShortcutsOverlay } from "./components/ShortcutsOverlay";
import { SHORTCUT_STRINGS } from "./components/graph/strings";
import { useKeyboardShortcuts, formatShortcut } from "./hooks/useKeyboardShortcuts";
import { SHORTCUT_COMBOS } from "./utils/shortcutCombos";
import { useOnboardingTour } from "./hooks/useOnboardingTour";
import { TOUR_STRINGS } from "./tour/strings";
import {
  APP_STRINGS,
  PANEL_LABELS,
  SHARE_LABELS,
  STATUS_BAR_STRINGS,
  type ShareLabel,
} from "./constants/ui";
import { EXAMPLES } from "./examples/catalog";
import { extractNamespace } from "./state/workspaceReducer";
import { useWorkspace } from "./hooks/useWorkspace";
import { useCodeGeneration } from "./hooks/useCodeGeneration";
import { validateCto, parseCto, buildExternalTypeMap, type GraphContext } from "./utils/graph/ctoToGraph";
import type { ImportStatement, TypeLinkTarget } from "./utils/graph/types";
import { parsePlaygroundUrlOptions, type ViewMode } from "./utils/urlOptions";
import {
  areWorkspaceModelsEqual,
  clearWorkspaceSnapshot,
  loadWorkspaceSnapshot,
  useWorkspacePersistence,
} from "./hooks/useWorkspacePersistence";
import { NDA_EXAMPLE } from "./examples/nda.cto";

// How long the Share button shows its feedback label before reverting.
const SHARE_FEEDBACK_MS = 2000;

// Evaluated once at module load — avoids parsing the URL hash twice for the
// two separate state initialisers that need models and activeNamespace.
const _initialModels = (() => {
  const hash = window.location.hash.slice(1);
  if (hash) {
    const decoded = LZString.decompressFromEncodedURIComponent(hash);
    if (decoded) {
      // New format: JSON array of CTO strings (multi-namespace share)
      try {
        const sources: unknown = JSON.parse(decoded);
        if (Array.isArray(sources) && sources.length > 0 && sources.every((s) => typeof s === 'string')) {
          const result: Record<string, string> = {};
          for (const src of sources as string[]) result[extractNamespace(src)] = src;
          return result;
        }
      } catch { /* not JSON — fall through to legacy single-model format */ }
      // Legacy format: plain CTO string
      const ns = extractNamespace(decoded);
      return { [ns]: decoded };
    }
  }
  return { [extractNamespace(NDA_EXAMPLE)]: NDA_EXAMPLE };
})();

const _initialUrlOptions = parsePlaygroundUrlOptions(window.location.search);

// Captured before the App mounts: the persistence hook starts overwriting the
// stored snapshot shortly after the first render, so the previous session has
// to be read here, not in an effect.
const _savedSnapshot = loadWorkspaceSnapshot();

// State conventions: the workspace (models + active namespace) is multi-action
// state and lives behind the reducer in state/workspaceReducer.ts via
// useWorkspace; codegen results live in useCodeGeneration. Independent UI
// flags (view mode, panel visibility, transient labels) stay as plain
// useState here.
export default function App() {
  const workspace = useWorkspace(_initialModels);
  const { models, activeNamespace, setActiveNamespace } = workspace;

  const [viewMode, setViewMode] = useState<ViewMode>(_initialUrlOptions.viewMode);
  const [showCto, setShowCto] = useState(_initialUrlOptions.showCto);
  const [shareLabel, setShareLabel] = useState<ShareLabel>(SHARE_LABELS.idle);
  const [importError, setImportError] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{ name: string; namespace?: string; ts: number } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  const { results, activeTab, setActiveTab } = useCodeGeneration(models, _initialUrlOptions.activeTab);

  // App-wide shortcuts, active in every view (the graph editor registers its
  // own on top of these). The cheat sheet overlay documents both sets.
  useKeyboardShortcuts([
    { ...SHORTCUT_COMBOS.showOverlay, description: SHORTCUT_STRINGS.showOverlay, category: SHORTCUT_STRINGS.categoryGeneral, handler: () => setShortcutsOpen((v) => !v) },
    { ...SHORTCUT_COMBOS.showOverlayAlt, description: SHORTCUT_STRINGS.showOverlay, category: SHORTCUT_STRINGS.categoryGeneral, handler: () => setShortcutsOpen((v) => !v) },
    { ...SHORTCUT_COMBOS.viewGraph, description: SHORTCUT_STRINGS.viewGraph, category: SHORTCUT_STRINGS.categoryNavigation, handler: () => setViewMode("graph") },
    { ...SHORTCUT_COMBOS.viewForm, description: SHORTCUT_STRINGS.viewForm, category: SHORTCUT_STRINGS.categoryNavigation, handler: () => setViewMode("form") },
    { ...SHORTCUT_COMBOS.viewCode, description: SHORTCUT_STRINGS.viewCode, category: SHORTCUT_STRINGS.categoryNavigation, handler: () => setViewMode("code") },
    { ...SHORTCUT_COMBOS.toggleCtoPanel, description: SHORTCUT_STRINGS.toggleCto, category: SHORTCUT_STRINGS.categoryNavigation, handler: () => setShowCto((v) => !v) },
  ]);

  // Offer to restore the previous session only when it would change something:
  // a shared link (URL hash) takes precedence over the cache, and a snapshot
  // identical to what already loaded has nothing to restore.
  const [showRestore, setShowRestore] = useState(
    () =>
      _savedSnapshot !== null &&
      !window.location.hash.slice(1) &&
      !areWorkspaceModelsEqual(_savedSnapshot.models, _initialModels),
  );
  // Do not overwrite a recoverable snapshot until the user chooses Restore or
  // Dismiss on the restore prompt.
  const { lastSaved, saveError, dismissSaveError } = useWorkspacePersistence(models, !showRestore);

  // First-visit onboarding walkthrough. Never auto-start over the restore
  // prompt, in headless embeds, without the toolbar (most anchors live
  // there), or when a shared link was opened (the visitor came for the
  // model, not the interface). The toolbar button re-triggers it any time.
  const { startTour } = useOnboardingTour({
    setShowCto,
    setViewMode,
    blockAutoStart:
      showRestore ||
      _initialUrlOptions.headless ||
      !_initialUrlOptions.showToolbar ||
      !!window.location.hash.slice(1),
  });

  function handleRestoreSession() {
    if (_savedSnapshot) workspace.restoreSnapshot(_savedSnapshot.models);
    setShowRestore(false);
  }

  function handleDismissRestore() {
    clearWorkspaceSnapshot();
    setShowRestore(false);
  }

  // The "active" source for single-model views (graph editor, CTO editor)
  const source = models[activeNamespace] ?? "";

  // Declared type names per open namespace. Used to resolve imported type
  // references (clickable links, foreign-namespace graph nodes).
  const workspaceDeclarations = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const [ns, cto] of Object.entries(models)) {
      if (!cto) continue;
      try {
        result[ns] = parseCto(cto).declarations.map((d) => d.name);
      } catch {
        // Unparseable model: treat its types as unavailable until it parses again
      }
    }
    return result;
  }, [models]);

  // Declarations and imports of the active model.
  const activeModel = useMemo(() => {
    try {
      const parsed = parseCto(source);
      return { declarations: parsed.declarations, imports: parsed.imports };
    } catch {
      return { declarations: [] as { name: string }[], imports: [] as ImportStatement[] };
    }
  }, [source]);

  // Types the active model pulls in from other namespaces, with resolution
  // status (resolved = the namespace is open and declares the type).
  const externalTypes = useMemo(
    () => buildExternalTypeMap(activeModel.imports, workspaceDeclarations),
    [activeModel, workspaceDeclarations],
  );

  const graphContext = useMemo<GraphContext>(
    () => ({ externalTypes, workspaceDeclarations }),
    [externalTypes, workspaceDeclarations],
  );

  // Clickable references in the CTO editor: local declarations plus imported
  // types. Local names win when an import shadows them.
  const linkTargets = useMemo<TypeLinkTarget[]>(() => {
    const local: TypeLinkTarget[] = activeModel.declarations.map((d) => ({ name: d.name, resolved: true }));
    const localNames = new Set(local.map((t) => t.name));
    const imported: TypeLinkTarget[] = Object.entries(externalTypes)
      .filter(([name]) => !localNames.has(name))
      .map(([name, info]) => ({ name, namespace: info.namespace, resolved: info.resolved }));
    return [...local, ...imported];
  }, [activeModel, externalTypes]);

  // Jump to a declaration's node in the graph (from a CTO reference click or
  // an imported node click). A namespace argument means the type lives in
  // another open namespace: switch the workspace there first, then focus.
  const handleFocusNode = useCallback((name: string, namespace?: string) => {
    if (namespace) {
      if (models[namespace] === undefined) return; // unresolved namespace: nothing to navigate to
      if (namespace !== activeNamespace) setActiveNamespace(namespace);
    }
    setViewMode("graph");
    setFocusRequest({ name, namespace, ts: Date.now() });
  }, [models, activeNamespace, setActiveNamespace]);

  const validationError = useMemo(() => {
    const peers = Object.values(models).filter((s) => s && s !== source);
    // validateCto reports problems as a return value; if it throws anyway,
    // surface the message instead of silently pretending the model is valid.
    try {
      return validateCto(source, peers);
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [source, models]);

  // Called by the graph editor / CTO text editor for the active model
  function setSource(newCto: string) {
    workspace.changeModel(activeNamespace, newCto);
  }

  async function handleShare() {
    // Encode all open models so multi-namespace sessions survive the round-trip.
    // Single-model sessions use the plain CTO string for backward compatibility
    // with links shared before this change.
    const sources = Object.values(models).filter(Boolean);
    const payload = sources.length === 1 ? sources[0] : JSON.stringify(sources);
    window.location.hash = LZString.compressToEncodedURIComponent(payload);
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareLabel(SHARE_LABELS.copied);
    } catch {
      // Clipboard write denied (e.g. Firefox without focus) — hash is updated
      // so the user can copy the URL bar manually.
      setShareLabel(SHARE_LABELS.fallback);
    } finally {
      setTimeout(() => setShareLabel(SHARE_LABELS.idle), SHARE_FEEDBACK_MS);
    }
  }

  // Loading an example never destroys work: user namespaces and edited
  // examples stay open as tabs, so they remain visible and included in
  // share/export/codegen. Only untouched examples are swapped out. Closing
  // an example's tab and clicking its button again reloads the pristine one.
  function handleLoadExample(src: string) {
    workspace.loadExample(src);
    window.location.hash = "";
  }

  // Convert a Concerto metamodel AST (single Model or a { models: [...] }
  // container) into one or more CTO source strings via the metamodel printer.
  async function astToCtoSources(json: string): Promise<string[]> {
    const { Printer } = await import("@accordproject/concerto-cto");
    const { MetaModel } = await import("@accordproject/concerto-core");

    const ast = JSON.parse(json); // SyntaxError for non-JSON

    // Quick pre-check: the top-level object (or the first item in models[])
    // must carry a concerto.metamodel $class. This catches common cases like
    // JSON Schema or OpenAPI files being uploaded accidentally and gives a
    // clearer message than the metamodel validator's property-level errors.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const topClass: unknown = (ast as any)?.["$class"] ?? (ast as any)?.models?.[0]?.["$class"];
    if (typeof topClass !== "string" || !topClass.startsWith("concerto.metamodel@")) {
      throw new Error(APP_STRINGS.invalidAstFile);
    }

    // Normalise to a Models container so validateMetaModel can check the
    // full structure. A single Model object is wrapped; a container is used
    // as-is.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelsAst: any = Array.isArray(ast?.models)
      ? ast
      : { $class: "concerto.metamodel@1.0.0.Models", models: [ast] };

    // Full metamodel validation via Concerto's own validator.
    // Requires proper $class identifiers and rejects unexpected properties.
    MetaModel.validateMetaModel(modelsAst);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return modelsAst.models.map((m: any) => Printer.toCTO(m));
  }

  function handleImport() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".cto,.json";
    input.multiple = true;
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files || files.length === 0) return;

      const readAsText = (file: File) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = () => reject(reader.error);
          reader.readAsText(file);
        });

      // Read and convert every file in the order the user selected them, so the
      // resulting namespace order — and the active tab — is deterministic.
      setImportError(null);
      const ctoSources: string[] = [];
      const errors: string[] = [];
      for (const file of Array.from(files)) {
        try {
          const text = await readAsText(file);
          const isJson =
            file.name.toLowerCase().endsWith(".json") ||
            /^\s*[{[]/.test(text);
          if (isJson) {
            ctoSources.push(...(await astToCtoSources(text)));
          } else {
            ctoSources.push(text);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`${file.name}: ${msg}`);
        }
      }
      if (errors.length > 0) setImportError(errors.join("\n"));

      if (ctoSources.length === 0) return;
      workspace.importModels(ctoSources);
    };
    input.click();
  }

  async function handleExport() {
    const entries = Object.entries(models).filter(([, cto]) => !!cto);
    if (entries.length === 1) {
      // Single file — download as .cto
      const [, cto] = entries[0];
      const blob = new Blob([cto], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = APP_STRINGS.exportSingleFilename;
      a.click();
      URL.revokeObjectURL(url);
    } else {
      // Multiple files — zip them
      const zip = new JSZip();
      for (const [ns, cto] of entries) {
        zip.file(`${ns}.cto`, cto);
      }
      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = APP_STRINGS.exportZipFilename;
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  const nsList = Object.keys(models);

  return (
    <div className={`flex flex-col h-screen bg-[#1a202c] text-white overflow-hidden ${_initialUrlOptions.headless ? "" : "pt-16"}`}>
      {!_initialUrlOptions.headless && <Header />}

      {/* Restore previous session prompt */}
      {showRestore && _savedSnapshot && (
        <div className="flex items-center gap-3 px-4 py-2 bg-[#2a4365] border-b border-[#2c5282] text-xs text-blue-100 shrink-0">
          <span className="flex-1">
            {APP_STRINGS.restorePrompt(new Date(_savedSnapshot.savedAt).toLocaleString())}
          </span>
          <button
            onClick={handleRestoreSession}
            className="shrink-0 text-xs px-2.5 py-1 rounded font-semibold"
            style={{ background: "#3182ce", color: "#e2e8f0", border: "none", cursor: "pointer" }}
          >
            {APP_STRINGS.restore}
          </button>
          <button
            onClick={handleDismissRestore}
            className="shrink-0 text-xs px-2.5 py-1 rounded"
            style={{ background: "transparent", color: "#90cdf4", border: "1px solid #2c5282", cursor: "pointer" }}
          >
            {APP_STRINGS.dismiss}
          </button>
        </div>
      )}

      {/* Storage failure banner */}
      {saveError && (
        <div role="alert" className="flex items-start gap-2 px-4 py-2 bg-amber-900 bg-opacity-60 border-b border-amber-700 text-xs text-amber-100 shrink-0">
          <span className="flex-1">{saveError}</span>
          <button
            onClick={dismissSaveError}
            className="shrink-0 text-amber-300 hover:text-white leading-none"
            aria-label={APP_STRINGS.dismissStorageWarning}
          >
            ×
          </button>
        </div>
      )}

      {/* Import error banner */}
      {importError && (
        <div className="flex items-start gap-2 px-4 py-2 bg-red-900 bg-opacity-60 border-b border-red-700 text-xs text-red-200 shrink-0">
          <span className="flex-1 whitespace-pre-wrap">{importError}</span>
          <button
            onClick={() => setImportError(null)}
            className="shrink-0 text-red-300 hover:text-white leading-none"
            aria-label={APP_STRINGS.dismissImportError}
          >
            ×
          </button>
        </div>
      )}

      {/* Toolbar */}
      {_initialUrlOptions.showToolbar && (
        <div className="flex items-center gap-2 px-3 py-2 bg-[#171d2b] border-b border-[#2d3748] shrink-0 flex-wrap">
          {/* CTO panel toggle */}
          <button
            onClick={() => setShowCto((v) => !v)}
            className="text-xs px-2.5 py-1 rounded font-semibold transition-colors"
            style={{
              background: showCto ? "#3182ce" : "#4a5568",
              color: "#e2e8f0",
              border: "none",
              cursor: "pointer",
            }}
            title={`${showCto ? APP_STRINGS.hideCtoPanel : APP_STRINGS.showCtoPanel} (${formatShortcut(SHORTCUT_COMBOS.toggleCtoPanel)})`}
          >
            {showCto ? APP_STRINGS.collapseCto : APP_STRINGS.expandCto}
          </button>

          <div style={{ width: 1, height: 20, background: "#4a5568", flexShrink: 0 }} />

          <div data-tour="examples" className="flex items-center gap-2">
            <span className="text-xs text-gray-500 font-medium">{APP_STRINGS.examplesLabel}</span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex.label}
                onClick={() => handleLoadExample(ex.source)}
                className="text-xs px-2.5 py-1 rounded font-semibold transition-colors"
                style={{ background: "#4a5568", color: "#e2e8f0", border: "none", cursor: "pointer" }}
                title={`Load the ${ex.label} example model`}
              >
                {ex.label}
              </button>
            ))}
          </div>

          {/* Right-side controls */}
          <div className="ml-auto flex items-center gap-2">
            <button
              data-tour="restart"
              onClick={startTour}
              className="text-xs px-2.5 py-1 rounded font-semibold transition-colors"
              style={{ background: "#4a5568", color: "#e2e8f0", border: "none", cursor: "pointer" }}
              title={TOUR_STRINGS.restartTour}
            >
              {TOUR_STRINGS.tourButton}
            </button>

            {/* Graph / Form / Code mode toggle */}
            <div data-tour="view-toggle" className="flex rounded overflow-hidden" style={{ border: "1px solid #4a5568" }}>
              <button
                onClick={() => setViewMode("graph")}
                className="text-xs px-3 py-1 font-semibold transition-colors"
                style={{
                  background: viewMode === "graph" ? "#3182ce" : "#2d3748",
                  color: "#e2e8f0",
                  border: "none",
                  cursor: "pointer",
                }}
                title={`Graph view (${formatShortcut(SHORTCUT_COMBOS.viewGraph)})`}
              >
                {APP_STRINGS.viewGraph}
              </button>
              <button
                onClick={() => setViewMode("form")}
                className="text-xs px-3 py-1 font-semibold transition-colors"
                style={{
                  background: viewMode === "form" ? "#3182ce" : "#2d3748",
                  color: "#e2e8f0",
                  border: "none",
                  borderLeft: "1px solid #4a5568",
                  cursor: "pointer",
                }}
                title={`Form view (${formatShortcut(SHORTCUT_COMBOS.viewForm)})`}
              >
                {APP_STRINGS.viewForm}
              </button>
              <button
                onClick={() => setViewMode("code")}
                className="text-xs px-3 py-1 font-semibold transition-colors"
                style={{
                  background: viewMode === "code" ? "#3182ce" : "#2d3748",
                  color: "#e2e8f0",
                  border: "none",
                  borderLeft: "1px solid #4a5568",
                  cursor: "pointer",
                }}
                title={`Code view (${formatShortcut(SHORTCUT_COMBOS.viewCode)})`}
              >
                {APP_STRINGS.viewCode}
              </button>
            </div>

            <button
              data-tour="share"
              onClick={handleShare}
              className="text-xs px-3 py-1 rounded border transition-colors"
              title="Copy a shareable link to this workspace"
              style={{
                background: "transparent",
                borderColor: "#4a5568",
                color: "#a0aec0",
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = "#19C6C8";
                (e.currentTarget as HTMLButtonElement).style.color = "#19C6C8";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.borderColor = "#4a5568";
                (e.currentTarget as HTMLButtonElement).style.color = "#a0aec0";
              }}
            >
              {shareLabel}
            </button>

            <button
              onClick={() => setShortcutsOpen(true)}
              className="text-xs px-2.5 py-1 rounded border transition-colors"
              style={{
                background: "transparent",
                borderColor: "#4a5568",
                color: "#a0aec0",
                cursor: "pointer",
              }}
              title={`${SHORTCUT_STRINGS.showOverlay} (?)`}
              aria-label={SHORTCUT_STRINGS.showOverlay}
            >
              ?
            </button>
          </div>
        </div>
      )}

      {shortcutsOpen && <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />}

      {/* Split pane */}
      <div className="flex flex-1 min-h-0">
        {/* Left: CTO editor (collapsible) — hidden in form view */}
        {showCto && viewMode !== "form" && (
          <div
            data-tour="cto-panel"
            className="flex flex-col"
            style={{ width: "35%", borderRight: "1px solid #2d3748", flexShrink: 0 }}
          >
            {/* Namespace tab strip */}
            {nsList.length > 1 && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  background: "#171d2b",
                  borderBottom: "1px solid #2d3748",
                  overflowX: "auto",
                  flexShrink: 0,
                }}
              >
                {nsList.map((ns) => (
                  <div
                    key={ns}
                    onClick={() => workspace.setActiveNamespace(ns)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "4px 10px",
                      cursor: "pointer",
                      fontSize: 11,
                      color: ns === activeNamespace ? "#e2e8f0" : "#718096",
                      background: ns === activeNamespace ? "#3182ce20" : "transparent",
                      borderBottom: ns === activeNamespace ? "2px solid #3182ce" : "2px solid transparent",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                    }}
                    title={ns}
                  >
                    <span>{ns.length > 24 ? ns.slice(0, 24) + "…" : ns}</span>
                    {nsList.length > 1 && (
                      <span
                        onClick={(e) => { e.stopPropagation(); workspace.removeNamespace(ns); }}
                        style={{
                          color: "#718096",
                          fontSize: 13,
                          lineHeight: 1,
                          padding: "0 2px",
                          borderRadius: 2,
                          cursor: "pointer",
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLSpanElement).style.color = "#fc8181"; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLSpanElement).style.color = "#718096"; }}
                        title={APP_STRINGS.removeNamespace}
                      >
                        ×
                      </span>
                    )}
                  </div>
                ))}
                <button
                  onClick={workspace.addNamespace}
                  style={{
                    background: "transparent",
                    border: "none",
                    color: "#718096",
                    cursor: "pointer",
                    fontSize: 16,
                    padding: "0 8px",
                    lineHeight: 1,
                    flexShrink: 0,
                  }}
                  title={APP_STRINGS.addNamespace}
                >
                  +
                </button>
              </div>
            )}

            <div
              className="flex items-center justify-between px-4 py-2 shrink-0"
              style={{ background: "#171d2b", borderBottom: "1px solid #2d3748" }}
            >
              <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: "#718096" }}>
                {APP_STRINGS.schemaPanelTitle}
              </span>
              <div className="flex items-center gap-2">
                {validationError && (
                  <span className="text-xs" style={{ color: "#fc8181" }} title={validationError}>
                    {APP_STRINGS.validationBadge}
                  </span>
                )}
                <span className="text-xs" style={{ color: "#4a5568" }}>{APP_STRINGS.schemaFileExt}</span>
                {nsList.length === 1 && (
                  <button
                    onClick={workspace.addNamespace}
                    style={{
                      background: "transparent",
                      border: "1px solid #4a5568",
                      color: "#718096",
                      cursor: "pointer",
                      fontSize: 11,
                      borderRadius: 4,
                      padding: "1px 6px",
                    }}
                    title={APP_STRINGS.addNamespace}
                  >
                    {APP_STRINGS.addNamespaceShort}
                  </button>
                )}
              </div>
            </div>
            <div className="flex-1 min-h-0">
              <ErrorBoundary label={PANEL_LABELS.textEditor} resetKeys={[source]}>
                <Editor value={source} onChange={setSource} language="concerto" error={validationError} linkTargets={linkTargets} onNavigate={handleFocusNode} />
              </ErrorBoundary>
            </div>
          </div>
        )}

        {/* Right: Graph, Form, or Code output */}
        <div data-tour="canvas" className="flex-1 flex flex-col min-w-0 min-h-0">
          {viewMode === "form" ? (
            <ErrorBoundary label={PANEL_LABELS.formView} resetKeys={[models]}>
              <FormView
                models={models}
                onModelChange={workspace.changeModel}
                onAddNamespace={workspace.addNamespace}
                onRemoveNamespace={workspace.removeNamespace}
              />
            </ErrorBoundary>
          ) : viewMode === "graph" ? (
            <ErrorBoundary label={PANEL_LABELS.graphCanvas} resetKeys={[source]}>
              <ConcertoGraphEditor
                cto={source}
                onModelChange={setSource}
                showText={showCto}
                onToggleText={() => setShowCto((v) => !v)}
                onImport={handleImport}
                onExport={handleExport}
                focusRequest={focusRequest}
                validationError={validationError}
                graphContext={graphContext}
                onNavigateToType={handleFocusNode}
              />
            </ErrorBoundary>
          ) : (
            <ErrorBoundary label={PANEL_LABELS.codeOutput} resetKeys={[results, activeTab]}>
              <OutputTabs
                results={results}
                activeTab={activeTab}
                onTabChange={setActiveTab}
              />
            </ErrorBoundary>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between px-4 py-1 text-white text-xs shrink-0" style={{ background: "#007acc" }}>
        <span>{STATUS_BAR_STRINGS.brand}</span>
        <div className="flex items-center gap-4">
          {lastSaved !== null && (
            <span className="opacity-80">{STATUS_BAR_STRINGS.lastSaved(new Date(lastSaved).toLocaleTimeString())}</span>
          )}
          <a
            data-tour="docs"
            href="https://concerto.accordproject.org/docs/intro"
            target="_blank"
            rel="noopener noreferrer"
            className="opacity-80 hover:opacity-100"
          >
            {STATUS_BAR_STRINGS.docs}
          </a>
          <a
            href="https://github.com/accordproject/concerto"
            target="_blank"
            rel="noopener noreferrer"
            className="opacity-80 hover:opacity-100"
          >
            {STATUS_BAR_STRINGS.github}
          </a>
          <span className="opacity-60">{STATUS_BAR_STRINGS.license}</span>
        </div>
      </div>
    </div>
  );
}
