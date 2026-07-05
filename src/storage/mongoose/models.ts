import { Schema } from 'mongoose'
import type { Connection, Model, Types } from 'mongoose'

export interface RbacPolicyDoc {
  name: string
  domain: string
  label: string
  scopeOptions: string[]
  dependsOn: string[]
}

export interface RbacPolicyGroupDoc {
  name: string
  label: string
  description: string
  isSystem: boolean
  isActive: boolean
}

export interface RbacPolicyGroupPolicyDoc {
  policyGroupId: Types.ObjectId
  policyId: Types.ObjectId
  scope: string | null
}

export interface RbacUserPolicyGroupDoc {
  subjectId: string
  policyGroupId: Types.ObjectId
  domain: string
  tenantId: string
}

export interface RbacUserPolicyDoc {
  subjectId: string
  policyId: Types.ObjectId
  domain: string
  tenantId: string
  scope: string | null
}

export interface RbacResourceOwnerDoc {
  resourceType: string
  resourceId: string
  ownerId: string
  relation: string
  domain: string
  tenantId: string
}

export interface RbacModels {
  policy: Model<RbacPolicyDoc>
  policyGroup: Model<RbacPolicyGroupDoc>
  policyGroupPolicy: Model<RbacPolicyGroupPolicyDoc>
  userPolicyGroup: Model<RbacUserPolicyGroupDoc>
  userPolicy: Model<RbacUserPolicyDoc>
  resourceOwner: Model<RbacResourceOwnerDoc>
}

const policySchema = new Schema<RbacPolicyDoc>(
  {
    name: { type: String, required: true, unique: true },
    domain: { type: String, required: true, default: '' },
    label: { type: String, required: true, default: '' },
    scopeOptions: { type: [String], required: true, default: [] },
    dependsOn: { type: [String], required: true, default: [] },
  },
  { timestamps: true },
)

const policyGroupSchema = new Schema<RbacPolicyGroupDoc>(
  {
    name: { type: String, required: true, unique: true },
    label: { type: String, required: true, default: '' },
    description: { type: String, required: true, default: '' },
    isSystem: { type: Boolean, required: true, default: false },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
)

const policyGroupPolicySchema = new Schema<RbacPolicyGroupPolicyDoc>({
  policyGroupId: { type: Schema.Types.ObjectId, required: true },
  policyId: { type: Schema.Types.ObjectId, required: true },
  scope: { type: String, default: null },
})
policyGroupPolicySchema.index({ policyGroupId: 1, policyId: 1 }, { unique: true })

const userPolicyGroupSchema = new Schema<RbacUserPolicyGroupDoc>({
  subjectId: { type: String, required: true },
  policyGroupId: { type: Schema.Types.ObjectId, required: true },
  domain: { type: String, required: true, default: '' },
  tenantId: { type: String, required: true, default: '' },
})
userPolicyGroupSchema.index(
  { subjectId: 1, policyGroupId: 1, domain: 1, tenantId: 1 },
  { unique: true },
)
userPolicyGroupSchema.index({ subjectId: 1 })

const userPolicySchema = new Schema<RbacUserPolicyDoc>({
  subjectId: { type: String, required: true },
  policyId: { type: Schema.Types.ObjectId, required: true },
  domain: { type: String, required: true, default: '' },
  tenantId: { type: String, required: true, default: '' },
  scope: { type: String, default: null },
})
userPolicySchema.index({ subjectId: 1, policyId: 1, domain: 1, tenantId: 1 }, { unique: true })
userPolicySchema.index({ subjectId: 1 })

const resourceOwnerSchema = new Schema<RbacResourceOwnerDoc>({
  resourceType: { type: String, required: true },
  resourceId: { type: String, required: true },
  ownerId: { type: String, required: true },
  relation: { type: String, required: true, default: 'owner' },
  domain: { type: String, required: true, default: '' },
  tenantId: { type: String, required: true, default: '' },
})
resourceOwnerSchema.index(
  { resourceType: 1, resourceId: 1, ownerId: 1, relation: 1 },
  { unique: true },
)
resourceOwnerSchema.index({ resourceType: 1, resourceId: 1 })
resourceOwnerSchema.index({ resourceType: 1, ownerId: 1, relation: 1 })
resourceOwnerSchema.index({ resourceType: 1, tenantId: 1 })

function scopedModel<T>(connection: Connection, name: string, schema: Schema<T>): Model<T> {
  const existing = connection.models[name] as Model<T> | undefined
  return existing ?? connection.model<T>(name, schema)
}

/** Connection-scoped model factory — safe to call repeatedly on one connection. */
export function rbacModels(connection: Connection): RbacModels {
  return {
    policy: scopedModel(connection, 'RbacPolicy', policySchema),
    policyGroup: scopedModel(connection, 'RbacPolicyGroup', policyGroupSchema),
    policyGroupPolicy: scopedModel(connection, 'RbacPolicyGroupPolicy', policyGroupPolicySchema),
    userPolicyGroup: scopedModel(connection, 'RbacUserPolicyGroup', userPolicyGroupSchema),
    userPolicy: scopedModel(connection, 'RbacUserPolicy', userPolicySchema),
    resourceOwner: scopedModel(connection, 'RbacResourceOwner', resourceOwnerSchema),
  }
}
