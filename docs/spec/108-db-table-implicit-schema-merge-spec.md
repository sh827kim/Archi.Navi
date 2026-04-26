# 108. DB Table Implicit Schema Merge SPEC

## Problem

SQL and MyBatis extraction can observe the same physical table as both a schema-qualified name
(`schema_a.table_a`) and an unqualified name (`table_a`). The system must not auto-merge these
because implicit schema context can be ambiguous, but reviewers need a direct way to merge the
objects when they confirm the match.

## Scope

- Create review candidates for unqualified and schema-qualified `db_table` objects under the same
  database object.
- Provide a hard-merge API for a pending `same_db_table` candidate.
- Surface the candidate and merge action in the Approval UI.
- Do not add database schema changes.

## Candidate Contract

After DB relation inference, when a database parent contains both an unqualified table and one or
more schema-qualified tables with the same base table name, create pending relation candidates:

- `relationType`: `same_db_table`
- `subjectObjectId`: unqualified `db_table`
- `objectId`: schema-qualified `db_table`
- `metadata.reason`: `implicit_schema_match`
- confidence:
  - `0.65` when there is exactly one schema-qualified target for that base table
  - `0.4` when multiple schema-qualified targets exist

The candidate is only created inside the same workspace and same database parent. Rejected
candidates are respected and are not recreated for the same source/target pair.

## Merge Contract

`POST /api/db-tables/merge-candidate`

Request:

```json
{
  "workspaceId": "uuid",
  "candidateId": "uuid"
}
```

Validation:

- Candidate must exist in the workspace.
- Candidate must be `PENDING` and `relationType='same_db_table'`.
- Both sides must be `db_table` objects in the same workspace and same database parent.
- Source must be unqualified and target must be schema-qualified.
- Source and target base table names must match.

Hard merge behavior:

- Target is always the schema-qualified table.
- Source references in `object_relations`, `relation_candidates`, `object_domain_affinities`, and
  `code_call_edges.callee_owner_object_id` are migrated to target.
- Duplicate relation/candidate/affinity conflicts keep one row and raise confidence/affinity to
  the maximum value.
- Self relations/candidates produced by the migration are removed or marked stale.
- Target metadata records `mergedObjectIds`, `implicitTableAliases`, and the union of
  `observedByServiceIds`.
- Source `objects` row is deleted after references move.
- The merge candidate is marked `APPROVED`; other `same_db_table` candidates involving the source
  or target are marked `REJECTED` with stale metadata.

## UX Contract

Approval list shows `same_db_table` candidates with:

- Label: `암묵 schema 테이블 후보`
- Direction: `table_a -> schema_a.table_a`
- Database key, base table, target schema, and ambiguity warning when applicable.
- Actions: `병합`, `거부`

The normal approve action and bulk approve selection do not apply to this candidate type.

Confirmation text:

> `table_a` 객체의 관계, 후보, 도메인 소속을 `schema_a.table_a`로 이관하고 `table_a`
> 객체를 삭제합니다.

When the candidate has multiple schema targets, the dialog also warns the reviewer to confirm the
selected target.

## Tests

- Candidate generation creates `same_db_table` only within one database parent.
- Multiple schema-qualified matches produce low-confidence candidates.
- Merge API deletes source and leaves target.
- Source relation candidates, approved object relations, and domain affinities migrate to target.
- Duplicate conflicts do not create duplicate rows.
- Invalid workspace, database parent, object type, or relation type is rejected.
- Approval UI renders the special label and calls the merge API after confirmation.
