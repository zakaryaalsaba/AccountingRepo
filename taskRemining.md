# Remaining Tasks (Post Audit)

Audit sources used:
- `tasks.md`
- `tasksRealAccounting.md`
- `taskListAccounting.md`
- `tasksReview.md`
- `taskDocSign.md`
- Screenshots sampled from `/Users/zakaryaalsaba/Desktop/screenAccounting/` (fiscal year form, cheque form, card statement report views)

---

## A) Open checklist items still not done

### 1) Advanced reporting (dimension-based)
- [ ] Implement/finish **dimension-based reporting** in the advanced reports set (`project/department/etc.`) as marked open in `tasks.md`.

### 2) DocSign optional split endpoints
- [ ] Add optional split endpoints for DocSign draft editing:
  - `POST /api/documents/:id/recipients`
  - `POST /api/documents/:id/fields`
  (currently covered by `PATCH /api/documents/:id`, but explicitly left unchecked in `taskDocSign.md`).

---

## B) Process/rollout items — **CLOSED**

- [x] Phases 1–5 marked complete in `tasksRealAccounting.md` (aligned with §1–§17 completion).
- [x] Rollout sign-off anchor and per-env checklist: **`docs/rollout-phase-signoff.md`** (migration order, feature flags, env smoke, sign-off table).

---

## C) Screenshot parity status

- [x] No additional concrete feature gaps were found from the sampled screenshot views beyond the checklist items above.
- [ ] If you want a strict one-by-one photo audit (all images in `/screenAccounting`) with a mapping table per image, create a follow-up task for a full screenshot inventory pass.
