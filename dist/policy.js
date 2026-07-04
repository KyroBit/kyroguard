export class Policy {
    name;
    dependsOn;
    scopes;
    label;
    constructor(name, label, dependsOn = [], scopes = []) {
        this.name = name;
        this.dependsOn = dependsOn;
        this.scopes = scopes;
        this.label = label ?? name.split('.').pop().replace(/-/g, ' ');
    }
}
//# sourceMappingURL=policy.js.map