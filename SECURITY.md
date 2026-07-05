# Security Policy

@kyrobit/rbac is an authorization library: bugs in it can become data leaks in
every application that uses it. Treat any suspected isolation failure
(a subject seeing another domain's or tenant's data, a policy check passing
that should not) as a security issue, not a regular bug.

## Reporting a vulnerability

Do **not** open a public GitHub issue for security problems.

Report privately via GitHub's private vulnerability reporting on this
repository (Security → Report a vulnerability), or email the maintainers
directly. Include:

- the version affected
- a minimal reproduction (policies, assignments, and the request that
  produces the wrong decision)
- the impact you believe it has

You will get an acknowledgement within 2 business days.

## Scope

In scope:

- domain or tenant isolation failures
- policy cache returning another subject's or tenant's policy map
- scope checks being bypassed
- ownership records attributed to the wrong subject
- the CLI writing schema or types that weaken any of the above

Out of scope:

- vulnerabilities in your application's subject resolution (`getSubject`) —
  the library trusts what you resolve
- denial of service through deliberately enormous policy sets

## Supported versions

Only the latest minor release receives security fixes.
