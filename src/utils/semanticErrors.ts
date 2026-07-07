// Collects ALL semantic problems in a parsed model at once, with personalized
// messages and line numbers. The official Concerto validator (validateCto)
// stops at the first error; this sweep runs after it fails and enumerates the
// common cases so the user sees every problem in one banner instead of
// fixing them one by one. The official validator remains the authority: this
// list supplements it and never suppresses it.

import type { ConcertoModel, Declaration } from './graph/types';
import { PRIMITIVE_TYPES } from './graph/types';

export interface SemanticIssue {
  /** 1-based line of the problem in the source, or null if not found. */
  line: number | null;
  /** The identifier the issue is about, for marker placement. */
  name: string;
  /** Personalized, actionable description. */
  text: string;
}

function escapeName(name: string): string {
  return name.replace(/\$/g, '\\$');
}

function findLine(lines: string[], from: number, ...words: string[]): number | null {
  const patterns = words.map((w) => new RegExp(`\\b${escapeName(w)}\\b`));
  for (let i = from; i < lines.length; i++) {
    if (patterns.every((p) => p.test(lines[i]))) return i + 1;
  }
  return null;
}

function declarationLine(lines: string[], decl: Declaration, from = 0): number | null {
  const pattern = new RegExp(`^\\s*(?:abstract\\s+)?\\w+\\s+${escapeName(decl.name)}\\b`);
  for (let i = from; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1;
  }
  return null;
}

export function collectSemanticIssues(model: ConcertoModel, source: string): SemanticIssue[] {
  const issues: SemanticIssue[] = [];
  const lines = source.split(/\r?\n/);
  const declared = new Set(model.declarations.map((d) => d.name));

  // Types satisfied by imports cannot be checked without resolving the peer
  // namespaces, so anything imported (and everything, under an import-all)
  // is treated as known. The official validator still catches those cases.
  const imported = new Set<string>();
  let importAll = false;
  for (const imp of model.imports) {
    for (const t of imp.types) {
      if (t === '*') importAll = true;
      else imported.add(t);
    }
  }
  const known = (type: string) =>
    PRIMITIVE_TYPES.has(type) || declared.has(type) || imported.has(type) || importAll;

  // Duplicate declaration names: report every declaration after the first.
  const seen = new Map<string, number>();
  for (const decl of model.declarations) {
    const count = (seen.get(decl.name) ?? 0) + 1;
    seen.set(decl.name, count);
    if (count > 1) {
      const firstLine = declarationLine(lines, decl) ?? 0;
      const line = declarationLine(lines, decl, firstLine);
      issues.push({
        line,
        name: decl.name,
        text: `"${decl.name}" is declared more than once. Rename one of them.`,
      });
    }
  }

  for (const decl of model.declarations) {
    const declLine = declarationLine(lines, decl) ?? 1;

    if (decl.superType && !known(decl.superType)) {
      issues.push({
        line: findLine(lines, declLine - 1, decl.name, decl.superType) ?? declLine,
        name: decl.superType,
        text: `"${decl.name}" extends "${decl.superType}", which does not exist. Declare or import it, or remove the extends.`,
      });
    }

    if (decl.type === 'map' && decl.mapDeclaration) {
      for (const t of [decl.mapDeclaration.keyType, decl.mapDeclaration.valueType]) {
        if (!known(t)) {
          issues.push({
            line: findLine(lines, declLine - 1, t) ?? declLine,
            name: t,
            text: `Map "${decl.name}" uses type "${t}", which does not exist.`,
          });
        }
      }
      continue;
    }

    for (const prop of decl.properties) {
      if (known(prop.type)) continue;
      issues.push({
        line: findLine(lines, declLine - 1, prop.type, prop.name) ?? declLine,
        name: prop.type,
        text: `Type "${prop.type}" does not exist, but property "${prop.name}" of "${decl.name}" uses it. Declare the type or remove the property.`,
      });
    }
  }

  return issues;
}
