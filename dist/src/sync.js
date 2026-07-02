import { inArray } from 'drizzle-orm';
import { policies } from './schema.js';
export async function syncPolicies(db, resources) {
    const all = resources.flatMap(r => r.policies);
    if (!all.length)
        return;
    // Validate depends_on references exist
    const names = new Set(all.map(p => p.name));
    for (const p of all) {
        for (const dep of p.dependsOn) {
            if (!names.has(dep)) {
                throw new Error(`[rbac] Policy "${p.name}" depends on "${dep}" which is not defined.`);
            }
        }
    }
    // Upsert all policies
    await db
        .insert(policies)
        .values(all.map(p => ({
        name: p.name,
        label: p.label,
        depends_on: p.dependsOn,
    })))
        .onConflictDoUpdate({
        target: policies.name,
        set: {
            label: policies.label,
            depends_on: policies.depends_on,
            updated_at: new Date(),
        },
    });
    // Delete orphaned policies no longer in code — same as CashWing's sync command
    const defined = all.map(p => p.name);
    const existing = await db.select({ name: policies.name }).from(policies);
    const orphans = existing.map((r) => r.name).filter((n) => !defined.includes(n));
    if (orphans.length) {
        await db.delete(policies).where(inArray(policies.name, orphans));
        console.log(`[rbac] Removed ${orphans.length} orphaned policies: ${orphans.join(', ')}`);
    }
    console.log(`[rbac] Synced ${all.length} policies.`);
}
//# sourceMappingURL=sync.js.map