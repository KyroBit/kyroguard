import { Schema } from 'mongoose'
import type { Connection, Model, Types } from 'mongoose'

export interface KyroguardPolicyDoc {
  name: string
  domain: string
  label: string
  scopeOptions: string[]
  dependsOn: string[]
}

export interface KyroguardPolicyGroupDoc {
  name: string
  label: string
  description: string
  isSystem: boolean
  isActive: boolean
}

export interface KyroguardPolicyGroupPolicyDoc {
  policyGroupId: Types.ObjectId
  policyId: Types.ObjectId
  scope: string | null
}

export interface KyroguardUserPolicyGroupDoc {
  subjectId: string
  policyGroupId: Types.ObjectId
  domain: string
  tenantId: string
}

export interface KyroguardUserPolicyDoc {
  subjectId: string
  policyId: Types.ObjectId
  domain: string
  tenantId: string
  scope: string | null
}

export interface KyroguardResourceOwnerDoc {
  resourceType: string
  resourceId: string
  ownerId: string
  relation: string
  domain: string
  tenantId: string
}

export interface KyroguardModels {
  policy: Model<KyroguardPolicyDoc>
  policyGroup: Model<KyroguardPolicyGroupDoc>
  policyGroupPolicy: Model<KyroguardPolicyGroupPolicyDoc>
  userPolicyGroup: Model<KyroguardUserPolicyGroupDoc>
  userPolicy: Model<KyroguardUserPolicyDoc>
  resourceOwner: Model<KyroguardResourceOwnerDoc>
}

const policySchema = new Schema<KyroguardPolicyDoc>(
  {
    name: { type: String, required: true, unique: true },
    domain: { type: String, required: true, default: '' },
    label: { type: String, required: true, default: '' },
    scopeOptions: { type: [String], required: true, default: [] },
    dependsOn: { type: [String], required: true, default: [] },
  },
  { timestamps: true },
)

const policyGroupSchema = new Schema<KyroguardPolicyGroupDoc>(
  {
    name: { type: String, required: true, unique: true },
    label: { type: String, required: true, default: '' },
    description: { type: String, required: true, default: '' },
    isSystem: { type: Boolean, required: true, default: false },
    isActive: { type: Boolean, required: true, default: true },
  },
  { timestamps: true },
)

const policyGroupPolicySchema = new Schema<KyroguardPolicyGroupPolicyDoc>({
  policyGroupId: { type: Schema.Types.ObjectId, required: true },
  policyId: { type: Schema.Types.ObjectId, required: true },
  scope: { type: String, default: null },
})
policyGroupPolicySchema.index({ policyGroupId: 1, policyId: 1 }, { unique: true })

const userPolicyGroupSchema = new Schema<KyroguardUserPolicyGroupDoc>({
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

const userPolicySchema = new Schema<KyroguardUserPolicyDoc>({
  subjectId: { type: String, required: true },
  policyId: { type: Schema.Types.ObjectId, required: true },
  domain: { type: String, required: true, default: '' },
  tenantId: { type: String, required: true, default: '' },
  scope: { type: String, default: null },
})
userPolicySchema.index({ subjectId: 1, policyId: 1, domain: 1, tenantId: 1 }, { unique: true })
userPolicySchema.index({ subjectId: 1 })

const resourceOwnerSchema = new Schema<KyroguardResourceOwnerDoc>({
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
export function kyroguardModels(connection: Connection): KyroguardModels {
  return {
    policy: scopedModel(connection, 'KyroguardPolicy', policySchema),
    policyGroup: scopedModel(connection, 'KyroguardPolicyGroup', policyGroupSchema),
    policyGroupPolicy: scopedModel(connection, 'KyroguardPolicyGroupPolicy', policyGroupPolicySchema),
    userPolicyGroup: scopedModel(connection, 'KyroguardUserPolicyGroup', userPolicyGroupSchema),
    userPolicy: scopedModel(connection, 'KyroguardUserPolicy', userPolicySchema),
    resourceOwner: scopedModel(connection, 'KyroguardResourceOwner', resourceOwnerSchema),
  }
}
