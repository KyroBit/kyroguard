import type { Subject } from './policy.js'

export type ScopeCheckFn = (
  subject:  Subject,
  resource: { type: string; id: string },
  db:       any,
) => Promise<boolean> | boolean

export class Scope {
  constructor(
    public readonly name:  string,
    public readonly label: string,
    public readonly check: ScopeCheckFn,
  ) {}
}
