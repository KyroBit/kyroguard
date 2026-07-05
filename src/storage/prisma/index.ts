export { prismaAdapter, PRISMA_ID_LIST_CAP } from './adapter.js'
export { rbacPrismaExtension } from './extension.js'
export type {
  RbacPrismaExtension,
  RbacPrismaExtensionOptions,
  RbacPrismaResourceRegistration,
} from './extension.js'
export type {
  PrismaClientLike,
  PrismaModelDelegateLike,
  PrismaRbacModelDelegates,
} from './client-contract.js'
export { prismaSchemaSnippet } from './schema-snippet.js'
