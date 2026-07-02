export class Policy {
    name;
    dependsOn;
    label;
    constructor(name, label, dependsOn = []) {
        this.name = name;
        this.dependsOn = dependsOn;
        this.label = label ?? name.split('.').pop().replace(/-/g, ' ');
    }
}
//# sourceMappingURL=policy.js.map