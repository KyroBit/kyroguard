/**
 * Structural contract for the Prisma client the adapter runs against.
 *
 * `@prisma/client` is an OPTIONAL peer dependency whose concrete types are
 * generated per project, so nothing under src/ may import it. Instead the
 * adapter is typed against this minimal structural surface — exactly the
 * model delegates and methods `prismaAdapter` calls, nothing more. Any client
 * generated from the models in `prismaSchemaSnippet` (see
 * ./schema-snippet.ts) satisfies it structurally.
 *
 * Like the Drizzle adapter's `Db = any` boundary, the delegate argument and
 * result types are this module's single deliberate `any` boundary: Prisma's
 * generated signatures are generic over the exact select/include shape, which
 * a hand-written structural type cannot capture. The contract test suite
 * (S1–S20) is what pins the adapter's runtime behavior.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The subset of a Prisma model delegate the adapter uses. */
export interface PrismaModelDelegateLike {
  findMany(args?: any): Promise<any[]>
  findFirst(args?: any): Promise<any>
  findUnique(args?: any): Promise<any>
  create(args: any): Promise<any>
  createMany(args: any): Promise<any>
  update(args: any): Promise<any>
  updateMany(args: any): Promise<any>
  upsert(args: any): Promise<any>
  deleteMany(args?: any): Promise<any>
}

/**
 * The six RBAC model delegates. Property names are fixed by the model names
 * in `prismaSchemaSnippet` (model `RbacPolicy` → client property
 * `rbacPolicy`, and so on). Both the root client and the interactive
 * transaction client expose them.
 */
export interface PrismaRbacModelDelegates {
  readonly rbacPolicy: PrismaModelDelegateLike
  readonly rbacPolicyGroup: PrismaModelDelegateLike
  readonly rbacPolicyGroupPolicy: PrismaModelDelegateLike
  readonly rbacUserPolicyGroup: PrismaModelDelegateLike
  readonly rbacUserPolicy: PrismaModelDelegateLike
  readonly rbacResourceOwner: PrismaModelDelegateLike
}

/**
 * What `prismaAdapter` requires of the client: the six delegates plus the
 * interactive (callback) form of `$transaction`. A generated `PrismaClient`
 * whose schema contains the RBAC models satisfies this without casts.
 */
export interface PrismaClientLike extends PrismaRbacModelDelegates {
  $transaction<T>(fn: (tx: PrismaRbacModelDelegates) => Promise<T>): Promise<T>
}
