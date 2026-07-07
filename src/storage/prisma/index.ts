export { prismaAdapter, PRISMA_ID_LIST_CAP } from './adapter.js'
export { kyroguardPrismaExtension } from './extension.js'
export type {
  KyroguardPrismaExtension,
  KyroguardPrismaExtensionOptions,
  KyroguardPrismaResourceRegistration,
} from './extension.js'
export type {
  PrismaClientLike,
  PrismaModelDelegateLike,
  PrismaRbacModelDelegates,
} from './client-contract.js'
export { prismaSchemaSnippet } from './schema-snippet.js'
