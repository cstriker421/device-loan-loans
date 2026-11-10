// Domain errors. Plain classes: no framework, no I/O.

/** Input broke a domain rule. `issues` lists every problem found. */
export class DomainValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid input: ${issues.join('; ')}`);
    this.name = 'DomainValidationError';
    this.issues = issues;
  }
}

/** An operation is not allowed from the entity's current status. */
export class InvalidTransitionError extends Error {
  readonly entity: string;
  readonly from: string;
  readonly to: string;

  constructor(entity: string, from: string, to: string) {
    super(`${entity} cannot move from "${from}" to "${to}"`);
    this.name = 'InvalidTransitionError';
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}
