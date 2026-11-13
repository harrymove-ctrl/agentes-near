-- Rules people gave an agent (ADR 0120 addendum 2026-11-04): a memory kind every run it acts for them reads.
ALTER TYPE "public"."context_kind" ADD VALUE 'rule';