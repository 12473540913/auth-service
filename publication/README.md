# Publication: A Shared Auth Service Without a Shared Data Model

## Summary

This technical note describes a way to share authentication across multiple
applications without requiring them to share a database engine or a domain
model. The service centralizes common identity flows, resolves each request
through server-side tenant configuration, and hides database differences
behind a storage interface. It also draws a boundary around app data: when
the service only needs to persist client-encrypted state, it can store that
state without interpreting its contents.

The main lesson is to share the cross-app capability, keep tenant-specific
infrastructure behind configuration and adapters, and keep app-specific data
ownership explicit.

## Read the note

The publication is in [`index.md`](./index.md). GitHub Pages renders it as the
site home page.