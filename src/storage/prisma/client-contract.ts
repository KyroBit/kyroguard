/**
 * Structural contract for the Prisma client. `@prisma/client` is an optional
 * peer with per-project generated types, so nothing under src/ may import it.
 * The `any`s are deliberate: Prisma's generated signatures are generic over
 * the select shape, which a structural type cannot capture; the S1–S23 suite
 * pins runtime behavior.
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

/** The six kyroguard model delegates; property names are fixed by the `prismaSchemaSnippet` model names. */
export interface PrismaKyroguardModelDelegates {
  readonly kyroguardPolicy: PrismaModelDelegateLike
  readonly kyroguardPolicyGroup: PrismaModelDelegateLike
  readonly kyroguardPolicyGroupPolicy: PrismaModelDelegateLike
  readonly kyroguardUserPolicyGroup: PrismaModelDelegateLike
  readonly kyroguardUserPolicy: PrismaModelDelegateLike
  readonly kyroguardResourceOwner: PrismaModelDelegateLike
}

/** What `prismaAdapter` requires: the six delegates, interactive `$transaction` and `$disconnect`. */
export interface PrismaClientLike extends PrismaKyroguardModelDelegates {
  $transaction<T>(fn: (tx: PrismaKyroguardModelDelegates) => Promise<T>): Promise<T>
  $disconnect(): Promise<void>
}
