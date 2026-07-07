// One-click repairs offered in the editor for recognised Concerto errors.
// Pure functions: given the error message and the source, produce concrete
// text edits. Editor.tsx exposes them as Monaco quick fixes (the lightbulb).

import {
  DECLARATION_START,
  enclosingDeclaration,
  suggestJoinedName,
} from './errorHints';

export interface QuickFixEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

export interface QuickFix {
  title: string;
  edit: QuickFixEdit;
}

function escapeName(name: string): string {
  return name.replace(/\$/g, '\\$');
}

function atEndOfFile(lines: string[], text: string): QuickFixEdit {
  const last = lines.length;
  const col = (lines[last - 1] ?? '').length + 1;
  return { startLine: last, startColumn: col, endLine: last, endColumn: col, text };
}

function replaceLine(lines: string[], line: number, text: string): QuickFixEdit {
  return {
    startLine: line,
    startColumn: 1,
    endLine: line,
    endColumn: (lines[line - 1] ?? '').length + 1,
    text,
  };
}

function deleteLine(lines: string[], line: number): QuickFixEdit {
  if (line < lines.length) {
    return { startLine: line, startColumn: 1, endLine: line + 1, endColumn: 1, text: '' };
  }
  return replaceLine(lines, line, '');
}

export function computeQuickFixes(message: string, source: string): QuickFix[] {
  const fixes: QuickFix[] = [];
  const lines = source.split(/\r?\n/);
  const pos = message.match(/line\s+(\d+)\s+col(?:umn)?\s+(\d+)/i);
  const errorLine = pos ? parseInt(pos[1], 10) : 0;
  const lineText = errorLine ? lines[errorLine - 1] ?? '' : '';

  // The file ends while a declaration is still open
  if (message.includes('but end of input found') && message.includes('"}"')) {
    fixes.push({
      title: 'Insert the missing "}" at the end of the file',
      edit: atEndOfFile(lines, '\n}'),
    });
  }

  if (errorLine) {
    const context = enclosingDeclaration(lines, errorLine);

    // A new declaration starts while the previous one is still open
    if (context && DECLARATION_START.test(lineText)) {
      fixes.push({
        title: context.name
          ? `Close ${context.kind} "${context.name}" with "}" before this line`
          : 'Close the open declaration with "}" before this line',
        edit: { startLine: errorLine, startColumn: 1, endLine: errorLine, endColumn: 1, text: '}\n\n' },
      });
    }

    // Enum value written with a type: "o String ACTIVE"
    if (context?.kind === 'enum') {
      const m = lineText.match(/^(\s*)o\s+[\w$]+\s+([\w$]+)/);
      if (m) {
        fixes.push({
          title: `Change to "o ${m[2]}"`,
          edit: replaceLine(lines, errorLine, `${m[1]}o ${m[2]}`),
        });
      }
    }

    // Declaration name containing spaces
    if (message.startsWith('Expected "{",')) {
      const s = suggestJoinedName(lineText);
      if (s) {
        fixes.push({
          title: `Rename to "${s.joined}"`,
          edit: {
            startLine: errorLine,
            startColumn: s.column,
            endLine: errorLine,
            endColumn: s.column + s.original.length,
            text: s.joined,
          },
        });
      }
    }

    // Property line without the "o" marker
    if (
      message.includes('"-->"') &&
      message.includes('"o"') &&
      !message.includes('end of input') &&
      lineText.trim()
    ) {
      const indent = lineText.match(/^\s*/)![0];
      fixes.push({
        title: `Change to "o ${lineText.trim()}"`,
        edit: replaceLine(lines, errorLine, `${indent}o ${lineText.trim()}`),
      });
    }
  }

  // A type that does not exist: offer to declare it or drop the property.
  // Matches both the official validator message ('Undeclared type "X" in
  // "property ns.Decl.prop"') and the sweep text ('Type "X" does not exist,
  // but property "prop" of "Decl" uses it').
  const typeMatch = message.match(/(?:Undeclared type|Type) "([A-Za-z_$][\w$]*)"/);
  if (typeMatch) {
    const type = typeMatch[1];
    fixes.push({
      title: `Declare "concept ${type}" at the end of the file`,
      edit: atEndOfFile(lines, `\n\nconcept ${type} {\n}`),
    });
    const prop =
      message.match(/property "([\w$]+)"/)?.[1] ??
      message.match(/property [\w.@$-]*\.([\w$]+)"/)?.[1];
    if (prop) {
      const typePattern = new RegExp(`\\b${escapeName(type)}\\b`);
      const propPattern = new RegExp(`\\b${escapeName(prop)}\\b`);
      const index = lines.findIndex((l) => typePattern.test(l) && propPattern.test(l));
      if (index >= 0) {
        fixes.push({
          title: `Remove property "${prop}"`,
          edit: deleteLine(lines, index + 1),
        });
      }
    }
  }

  return fixes;
}
