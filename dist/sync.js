function resolveWithDeps(names, byName) {
    const resolved = new Set();
    function walk(name) {
        if (resolved.has(name))
            return;
        resolved.add(name);
        for (const dep of byName.get(name) ?? [])
            walk(dep);
    }
    for (const name of names)
        walk(name);
    return resolved;
}
export async function syncPolicies(adapter, resources, portal, label = '') {
    const all = resources.flatMap(r => r.policies);
    if (!all.length)
        return;
    const prefix = portal ? `${portal}.` : '';
    const codeNames = new Set(all.map(p => p.name));
    for (const p of all) {
        for (const dep of p.dependsOn) {
            if (!codeNames.has(dep)) {
                throw new Error(`[rbac] Policy "${p.name}" depends on "${dep}" which is not defined.`);
            }
        }
    }
    await adapter.upsertPolicies(all.map(p => ({
        name: `${prefix}${p.name}`,
        label: p.label,
        valid_scopes: p.scopes,
        depends_on: p.dependsOn.map(d => `${prefix}${d}`),
    })));
    const allDbPolicies = await adapter.listAllPolicies();
    const prefixedNames = new Set(all.map(p => `${prefix}${p.name}`));
    const scopedDbNames = portal
        ? allDbPolicies.filter(r => r.name.startsWith(prefix))
        : allDbPolicies.filter(r => !r.name.includes('.') || r.name.indexOf('.') === r.name.lastIndexOf('.'));
    const orphans = scopedDbNames.filter(r => !prefixedNames.has(r.name));
    if (orphans.length) {
        const orphanIds = orphans.map(r => r.id);
        await adapter.deleteGroupPolicies(orphanIds);
        await adapter.deleteUserPolicies(orphanIds);
        await adapter.deletePolicies(orphanIds);
        console.log(`[rbac] Removed ${orphans.length} orphaned policies: ${orphans.map(r => r.name).join(', ')}`);
    }
    const livePolicies = allDbPolicies.filter(r => prefixedNames.has(r.name));
    const depsByName = new Map(livePolicies.map(r => [r.name, r.depends_on]));
    const idByName = new Map(livePolicies.map(r => [r.name, r.id]));
    const groups = await adapter.listGroups();
    for (const group of groups) {
        const assigned = await adapter.getGroupPolicies(group.id);
        const assignedIds = new Set(assigned.map(r => r.policy_id));
        const assignedNames = livePolicies.filter(r => assignedIds.has(r.id)).map(r => r.name);
        const required = resolveWithDeps(assignedNames, depsByName);
        const missing = [...required].filter(name => {
            const id = idByName.get(name);
            return id && !assignedIds.has(id);
        });
        if (missing.length) {
            await adapter.insertGroupPolicies(missing.map(name => ({ policy_group_id: group.id, policy_id: idByName.get(name), scope: null })));
            console.log(`${label}[rbac] Filled ${missing.length} missing deps for group ${group.id}: ${missing.join(', ')}`);
        }
    }
    console.log(`${label}[rbac] Synced ${all.length} policies.`);
}
//# sourceMappingURL=sync.js.map