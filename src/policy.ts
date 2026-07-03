export class Policy {
  public readonly label: string

  constructor(
    public readonly name:      string,
    label?:                    string,
    public readonly dependsOn: string[] = [],
  ) {
    this.label = label ?? name.split('.').pop()!.replace(/-/g, ' ')
  }
}

// What one resource exports alongside its table
export interface ResourceDefinition {
  table:    unknown                          // Drizzle table reference
  type:     string                          // e.g. 'blog', 'invoice'
  policies: Policy[]
  context?: Record<string, ContextPolicies> // context → policy → scope names
}

// context → { 'blogs.read': ['BranchOwned'] }
export type ContextPolicies = Record<string, string[]>

// Scope = plain function: subject + db → SQL condition string
export type ScopeCondition = (subject: Subject, db: unknown) => unknown

export interface Subject {
  id: string
  [key: string]: unknown
}
