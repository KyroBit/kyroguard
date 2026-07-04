export interface PolicyRow {
  name:         string
  label:        string
  scopeOptions: string[]  // extracted scope names
  depends_on:   string[]
}

export interface PolicyRecord {
  id:         string
  name:       string
  depends_on: string[]
}

export interface GroupPolicyRecord {
  policy_id: string
}

export interface GroupPolicyInsert {
  policy_group_id: string
  policy_id:       string
  scope:           string | null
}

export interface RbacAdapter {
  upsertPolicies(rows: PolicyRow[]): Promise<void>
  listAllPolicies(): Promise<PolicyRecord[]>
  deleteGroupPolicies(policyIds: string[]): Promise<void>
  deleteUserPolicies(policyIds: string[]): Promise<void>
  deletePolicies(ids: string[]): Promise<void>
  listGroups(): Promise<{ id: string }[]>
  getGroupPolicies(groupId: string): Promise<GroupPolicyRecord[]>
  insertGroupPolicies(rows: GroupPolicyInsert[]): Promise<void>
  getSubjectGroupPolicies(subjectId: string, portal?: string | null, contextId?: string | null): Promise<{ name: string; scope: string | null }[]>
  getSubjectDirectPolicies(subjectId: string):                           Promise<{ name: string; scope: string | null }[]>
}
