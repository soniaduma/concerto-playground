// Form view adapted from accordproject/lab-concerto-editor-web (Dan Selman <danscode@selman.org>, Ayman)

import { useMemo, useState } from 'react';
import type { ConcertoModel, Declaration, Property } from '../../utils/graph/types';
import { parseCto, describeParseError } from '../../utils/graph/ctoToGraph';
import { findErrorHint } from '../../utils/errorHints';
import { declarationsToCto } from '../../utils/graph/graphToCto';
import { PropertyTree } from './PropertyTree';
import { PropertySheet } from './PropertySheet';
import { COLOR } from './theme';
import '../errors.css';

// ─── Types ────────────────────────────────────────────────────────────────────

export type FormSel =
  | { kind: 'none' }
  | { kind: 'namespace'; ns: string }
  | { kind: 'decl'; ns: string; declName: string }
  | { kind: 'prop'; ns: string; declName: string; propName: string }
  | { kind: 'enumVal'; ns: string; declName: string; value: string };

// ─── FormView ─────────────────────────────────────────────────────────────────

interface FormViewProps {
  models: Record<string, string>;
  onModelChange: (ns: string, newCto: string) => void;
  onAddNamespace: () => void;
  onRemoveNamespace: (ns: string) => void;
}

export function FormView({ models, onModelChange, onAddNamespace, onRemoveNamespace }: FormViewProps) {
  const [selection, setSelection] = useState<FormSel>({ kind: 'none' });
  const [saveError, setSaveError] = useState<string | null>(null);

  // Every CTO produced by the form passes through the real Concerto parser
  // before it reaches the app state. Whatever the cause (bad name, duplicate
  // declaration, anything else), invalid CTO is never saved: the save is
  // dropped and Concerto's own error message is shown instead.
  function guardedModelChange(ns: string, newCto: string): boolean {
    if (newCto) {
      try {
        parseCto(newCto);
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
        return false;
      }
    }
    setSaveError(null);
    onModelChange(ns, newCto);
    return true;
  }

  function handleSelect(sel: FormSel) {
    setSaveError(null);
    setSelection(sel);
  }

  // Parse all models. Broken ones are excluded from the form, but their
  // errors are collected and shown in a banner instead of silently
  // disappearing from the tree. Memoized so selection changes do not
  // re-run the parser for every namespace.
  const { parsedModels, parseErrors } = useMemo(() => {
    const parsed: Record<string, ConcertoModel> = {};
    const errors: Array<{ ns: string; message: string; hint: string | null }> = [];
    for (const [ns, cto] of Object.entries(models)) {
      if (!cto) continue;
      try {
        parsed[ns] = parseCto(cto);
      } catch (e) {
        const message = describeParseError(e);
        errors.push({ ns, message, hint: findErrorHint(message, cto) });
      }
    }
    return { parsedModels: parsed, parseErrors: errors };
  }, [models]);

  function handleAddDeclaration(ns: string) {
    const model = parsedModels[ns];
    if (!model) return;
    const newDecl: Declaration = {
      name: `NewConcept${Date.now() % 10000}`,
      type: 'concept',
      isAbstract: false,
      properties: [],
      enumValues: [],
      identified: 'none',
      decorators: [],
    };
    const updated: ConcertoModel = { ...model, declarations: [...model.declarations, newDecl] };
    if (guardedModelChange(ns, declarationsToCto(updated))) {
      setSelection({ kind: 'decl', ns, declName: newDecl.name });
    }
  }

  function handleAddProperty(ns: string, declName: string) {
    const model = parsedModels[ns];
    if (!model) return;
    const newProp: Property = {
      name: `newProperty${Date.now() % 10000}`,
      type: 'String',
      isOptional: true,
      isArray: false,
      isRelationship: false,
      validators: {},
    };
    const updated: ConcertoModel = {
      ...model,
      declarations: model.declarations.map((d) =>
        d.name === declName ? { ...d, properties: [...d.properties, newProp] } : d
      ),
    };
    if (guardedModelChange(ns, declarationsToCto(updated))) {
      setSelection({ kind: 'prop', ns, declName, propName: newProp.name });
    }
  }

  function handleAddEnumValue(ns: string, declName: string) {
    const model = parsedModels[ns];
    if (!model) return;
    const newVal = `VALUE_${Date.now() % 10000}`;
    const updated: ConcertoModel = {
      ...model,
      declarations: model.declarations.map((d) =>
        d.name === declName ? { ...d, enumValues: [...d.enumValues, newVal] } : d
      ),
    };
    if (guardedModelChange(ns, declarationsToCto(updated))) {
      setSelection({ kind: 'enumVal', ns, declName, value: newVal });
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {parseErrors.length > 0 && (
        <div role="alert" className="error-banner error-banner-strip">
          <div className="error-banner-title">
            {parseErrors.length === 1
              ? 'One namespace has a syntax error and is hidden from the form:'
              : `${parseErrors.length} namespaces have syntax errors and are hidden from the form:`}
          </div>
          {parseErrors.map(({ ns, message, hint }) => (
            <div key={ns} className="error-banner-message">
              <strong>{ns}</strong>: {message}
              {hint && <div className="error-banner-hint">Hint: {hint}</div>}
            </div>
          ))}
          <div className="error-banner-note">
            Switch to the Graph or Code view to fix the schema text.
          </div>
        </div>
      )}
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <PropertyTree
          models={parsedModels}
          selection={selection}
          onSelect={handleSelect}
          onAddNamespace={onAddNamespace}
          onRemoveNamespace={onRemoveNamespace}
          onAddDeclaration={handleAddDeclaration}
          onAddProperty={handleAddProperty}
          onAddEnumValue={handleAddEnumValue}
        />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {saveError && (
            <div
              role="alert"
              style={{
                padding: '8px 16px',
                background: '#3b1f24',
                borderBottom: `1px solid ${COLOR.border}`,
                color: COLOR.red,
                fontSize: 12,
                lineHeight: 1.5,
              }}
            >
              Not saved, Concerto rejected the change: {saveError}
            </div>
          )}
          <PropertySheet
            selection={selection}
            models={parsedModels}
            onModelChange={guardedModelChange}
            onRemoveNamespace={onRemoveNamespace}
          />
        </div>
      </div>
    </div>
  );
}
