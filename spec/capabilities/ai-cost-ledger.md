# Capability: AI cost ledger

Recording starts in Phase 1 (every generation row + per-generation line in the TLDR tab); the
dashboard view arrives in Phase 4.

## What It Does
Shows what every AI call cost — per generation and as a site-wide month-to-date total — so the
team can keep AI spend minimal.

## Inputs
| Input | Type | Source | Required |
|---|---|---|---|
| Generation records | model, prompt version, tokens, cost, who, when, status, article | database | yes |
| Month | YYYY-MM (site timezone) | AI usage page | no (default current) |

## Outputs
| Output | Type | Destination |
|---|---|---|
| Month total | sum of cost (USD, 4 dp) + count | desk header, AI usage page |
| Table | one row per generation, newest first, with article link | AI usage page |

## External Calls
| System | Operation | On Failure |
|---|---|---|
| Database | aggregate query | inline error + retry |

## Business Rules
- Failed generations are listed (their cost counts if the provider reported one).
- Rows with unknown cost show "n/a" and are excluded from the sum, with a note "N calls without
  reported cost".
- Totals are computed from rows (no separate counter), so they always reconcile.

## Success Criteria
- [ ] With 3 generations costing 0.0012, 0.0008 and null in October, the October total is $0.0020, count 3, note "1 call without reported cost".
- [ ] A generation on 1 Nov 00:30 IST is counted in November (site timezone).
- [ ] The desk header month-to-date figure equals the AI usage page total.
