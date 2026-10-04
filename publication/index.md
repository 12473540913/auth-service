---
layout: default
title: "A Shared Auth Service Without a Shared Data Model"
description: "Tenant routing, storage adapters, and opaque encrypted state in a multi-application auth service."
---

# A Shared Auth Service Without a Shared Data Model

## Tenant routing, storage adapters, and opaque encrypted state

### Summary

Several applications often need the same identity capabilities—sign-up,
sign-in, session management, and account recovery—while differing in their
data stores, clients, and product-specific features. Duplicating those flows
means maintaining the same security-sensitive behavior in several places.
Putting every application behind one shared data model, however, can couple
their products and infrastructure unnecessarily.

This note describes a middle path: share the identity service, route each
request using server-side tenant configuration, and keep database differences
behind a storage interface. The service can also persist client-encrypted
application state as opaque data, without becoming the authority on what that
data means.

The design is useful when applications share a small set of platform
capabilities but should retain independent data stores or domain models. It is
not a claim that a tenant header alone provides isolation, nor that a shared
service eliminates the need for application-specific security boundaries.

## The design problem

A multi-application service has to answer several related questions:

- How does a request select the right application's configuration and data?
- How can the same route behavior work over different database engines?
- Which differences belong in configuration, and which deserve distinct
  implementations?
- How can the service support useful account or sync behavior without taking
  ownership of every application's domain data?

The implementation discussed here makes those boundaries explicit. An
`X-App-Id` header selects a registered app, but the value is only a routing
input. The server checks it against its configured app registry and resolves
the associated store and settings. Unregistered IDs are rejected. The
database URI, allowed origins, token mode, cookie settings, and enabled
features come from server-side configuration rather than being trusted from
the request.

The deployment stage is also server-side configuration. Development and
production run as separately configured services, so a caller cannot choose
which environment's database to access by changing a request header.

## Put the database behind a port

Routes use the `TenantStore` interface rather than issuing MongoDB or
PostgreSQL operations themselves. Its stores describe the operations the
service needs—such as finding and updating users, looking up one user's blob,
and managing settings. MongoDB and PostgreSQL adapters implement those
operations.

This gives the route layer one vocabulary for its work. For example, the
sign-in flow asks the selected user store to find an account and verify its
password; it does not need branches for each database's query API or ID type.
IDs are treated as opaque strings, allowing an adapter to use its native ID
representation without leaking that choice into the route contract.

This is a practical application of dependency inversion: the use-case layer
depends on a small interface describing the persistence it needs, while
concrete adapters depend on particular database technologies. The interface
is not a promise that every database behaves identically in every respect.
Database-specific capabilities still need to be made explicit. For example,
an optional capability may only be supported by one adapter, so an
incompatible tenant configuration should fail during startup rather than
appearing to work until a request reaches the feature.

### What this buys—and what it costs

The adapters make it possible to share route behavior across tenants using
different database engines. They also create ongoing work: each adapter must
preserve the interface's semantics, and features that cannot be implemented
consistently must be documented, limited, or redesigned.

The interface should therefore stay close to actual use cases. It should not
become a generic database abstraction intended to hide every difference
between engines. A small, explicit contract is easier to test and reason
about.

## Configure tenant differences; don't fork the service

Some differences are choices about how a common capability is delivered.
Browser applications can receive an HttpOnly cookie, while native clients
that do not have a usable browser cookie jar can use a bearer token. These
are two delivery modes for the same session concept, configured per app.

Likewise, app-specific features can be explicitly enabled. The service
validates registered app configuration at startup—including whether the
selected database adapter supports an enabled feature. Failing early turns a
misconfiguration into a deployment-time problem rather than a confusing
runtime surprise.

This approach works when the difference is genuinely configuration: the
underlying operation and its security properties remain shared. If the
behavior or ownership differs materially, adding another flag may only hide
the growing complexity. A separate service or an application-owned endpoint
may then be the clearer boundary.

## Authentication context is part of the tenant boundary

Tenant resolution selects a store, but authentication must also be valid in
the context of the selected app. In this design, issued tokens carry an app
identifier, and validation checks that identifier against the app handling
the request. The authenticated subject is then looked up in that tenant's
user store.

The result is a layered check: the app ID must be registered, the token must
be valid for that app, and the user must exist in the selected store. The
header is not a credential and should never be treated as one. Authorization
still depends on validating the session and enforcing user-level access in
each operation.

Password changes and resets also increment a user's token version. Requests
compare the version in the signed token with the current user record, which
allows previously issued tokens to be invalidated without waiting for their
expiration. This costs a user lookup during guarded requests, but makes
revocation a server-enforced decision rather than a client convention.

## Store app state without owning its meaning

The service can store progress data that the client encrypts before sending
it. It persists the ciphertext and the metadata needed to retrieve it, but
does not need to parse or understand the application's internal progress
model.

That boundary is useful when the service's responsibility is durable,
per-user storage—not interpreting or merging product-specific state. It
reduces coupling between the auth service and app schemas, and leaves the
application in control of its own data format.

Opaque storage is not a complete security design by itself. The client-side
encryption scheme, key derivation, key storage, nonce/IV requirements,
integrity checks, format versioning, and recovery behavior still need
deliberate design and review. Ciphertext metadata can also reveal information
such as update timing and payload size. The service should describe exactly
what it stores and avoid claiming that opacity alone guarantees
confidentiality or integrity.

## Keep product data ownership visible

A shared auth service is most sustainable when its scope stays recognizable:
identity, sessions, and a small number of cross-app capabilities. A feature
that exists for one product can be fenced off behind explicit configuration
while its long-term ownership is reconsidered.

An optional capability that serves only one application's workflow is a
product-shaped concern alongside the generic identity and encrypted-blob
flows. Feature gating limits accidental exposure to other tenants, but it
does not make such a capability universally generic. If application-owned
domain data grows, moving it to that application's backend may create a
cleaner ownership boundary. The auth service can then remain responsible for
identity rather than accumulating unrelated product APIs.

## Operational behavior is part of the architecture

Multi-tenant routing is only as reliable as its configuration. Every
registered app needs a valid database connection and compatible feature
settings. Validating those requirements at startup makes bad deployments
fail visibly before real traffic depends on them.

Separate development and production deployments also reduce ambiguity: each
service receives credentials for its own stage, rather than asking clients
or individual requests to select an environment. Secrets belong in a
dedicated secret-management system, and database connectivity and shutdown
behavior should be treated as part of operating the service—not details
hidden by the adapter interface.

## When this pattern fits

This design is a good fit when:

- several applications need the same identity flows;
- the applications can share a stable, limited persistence contract;
- tenants may use different database engines or independent databases;
- client and feature differences can be expressed as validated configuration;
- app-specific data can stay owned by its app, even when the service stores
  it opaquely.

It is a poor fit when tenants require fundamentally different identity
policies, when the shared interface becomes dominated by special cases, or
when a central service becomes a bottleneck or an unwanted owner of product
data. In those cases, separate services or app-owned APIs may be simpler and
safer.

## Takeaway

The useful abstraction is not “one database for every app” or “one universal
model.” It is a small shared capability with explicit tenant selection,
server-owned configuration, and replaceable persistence adapters. Keep
application data opaque when interpretation is not the service's job, and
keep ownership boundaries honest when a feature is product-specific.

That combination lets applications share the work that benefits from being
centralized—without pretending their storage, clients, and product models
must all be the same.

## Implementation references

- [Tenant resolution](https://github.com/1247350913/auth-service/blob/main/src/middleware/tenant.ts)
- [App configuration and startup validation](https://github.com/1247350913/auth-service/blob/main/src/config.ts)
- [Storage contracts](https://github.com/1247350913/auth-service/blob/main/src/store/types.ts)
- [Authentication and account routes](https://github.com/1247350913/auth-service/blob/main/src/routes/auth.ts)
- [Service README](https://github.com/1247350913/auth-service/blob/main/README.md)
