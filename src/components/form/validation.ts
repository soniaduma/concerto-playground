// Name-format validation for the Form view. Saving an invalid name would
// generate CTO that no longer parses, making the namespace vanish from the
// tree, so every rename is checked here first and rejected with a message
// explaining the expected format.
//
// The accept/reject decision is Concerto's own: ID_REGEX comes from
// @accordproject/concerto-util, so a name is rejected here exactly when
// concerto-core would reject it. The messages are only a friendlier layer
// on top; they never change the validation semantics.

import { Identifiers } from '@accordproject/concerto-util';

const { ID_REGEX } = Identifiers;

// Namespace version format. Concerto adopts the SemVer.org grammar for
// namespace versions, so we use the official regular expression published at
// https://semver.org (the "suggested regular expression" from its FAQ). It
// accepts major.minor.patch with an optional -prerelease and +build metadata,
// which is exactly what the Concerto parser/validator accepts. A hand-rolled
// pattern drifts from the spec (e.g. it wrongly rejected "1.0.0+build").
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Returns an error message if `name` is not a valid Concerto identifier
 * (declaration name, property name, enum value), or null if it is valid.
 */
export function identifierError(name: string): string | null {
  if (!name) return 'Name is required.';
  if (/\s/.test(name)) {
    return `Names cannot contain spaces. Write "${suggestIdentifier(name)}" instead of "${name}".`;
  }
  if (!ID_REGEX.test(name)) {
    return 'Names must be a single word starting with a letter, "_" or "$" (e.g. "myCarName").';
  }
  return null;
}

/**
 * Returns an error message if `ns` is not a valid Concerto namespace
 * (dot-separated identifiers plus a required @semver version), or null if it
 * is valid. Concerto rejects unversioned namespaces, so the version is
 * required here too.
 */
export function namespaceError(ns: string): string | null {
  if (!ns) return 'Namespace is required.';
  const at = ns.indexOf('@');
  const name = at === -1 ? ns : ns.slice(0, at);
  const version = at === -1 ? null : ns.slice(at + 1);
  // Validate the name first, so a namespace like "org.my space" reports the
  // space rather than the missing version.
  const segmentsValid = name.length > 0 && name.split('.').every((segment) => ID_REGEX.test(segment));
  if (!segmentsValid) {
    return 'A namespace is dot-separated words with no spaces, e.g. "org.example@1.0.0".';
  }
  if (version === null) {
    return 'A namespace needs a version, e.g. "org.example@1.0.0".';
  }
  if (!SEMVER_RE.test(version)) {
    return 'The version after "@" must be a semantic version, e.g. "1.0.0", "2.1.0-beta.1" or "1.0.0+build".';
  }
  return null;
}

/** Turns "masina mea" into "masinaMea" for the error message's suggestion. */
export function suggestIdentifier(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts
    .map((p, i) => (i === 0 ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('');
}
