# 106. Domain Candidate Manual Merge Spec

## Problem

Domain discovery can intentionally split close signals into separate candidates. In monolith/SOA codebases this can produce candidates such as `장바구니` and `장바구니조회`, even when a reviewer wants to approve them as one domain.

Before this spec, the discovery UX only allowed approving or rejecting each candidate independently. Reviewers had no safe way to merge candidates before approval.

## Requirements

- Users can select two or more discovered candidates and merge them into one candidate before approval.
- Merging must preserve all unique members from the selected candidates.
- If the same object appears in multiple selected candidates, the merged member keeps:
  - the maximum affinity,
  - the maximum relation cohesion,
  - the union of seed sources,
  - boolean signal matches promoted by OR.
- The merge operation must validate member object ownership by workspace.
- `domain` and `service` objects must not be accepted as merged domain members, matching `/api/domains/approve`.
- The merged candidate must remain approvable through the existing `/api/domains/approve` API.

## API

### `POST /api/domains/candidates/merge`

Request:

```json
{
  "workspaceId": "ws-1",
  "name": "장바구니",
  "candidates": [
    { "id": "cart", "autoName": "장바구니", "members": [] },
    { "id": "cart-query", "autoName": "장바구니조회", "members": [] }
  ]
}
```

Response:

```json
{
  "success": true,
  "data": {
    "candidate": {
      "id": "merged-cart-cart-query",
      "autoName": "장바구니",
      "members": [],
      "origin": "manual_merge"
    }
  }
}
```

Validation failures:

- `400 BAD_REQUEST`: invalid body, invalid name, fewer than two candidates, empty merged members.
- `400 INVALID_MEMBER_PAYLOAD`: malformed member shape or score outside `0..1`.
- `403 FORBIDDEN_MEMBER`: a member object is not in the requested workspace.
- `400 INVALID_MEMBER_TYPE`: a selected candidate contains `domain` or `service` object members.

## UX

- Each discovered candidate card has a selection checkbox.
- The discovery toolbar shows the selected count and enables `선택 병합` when at least two candidates are selected.
- The merged candidate replaces the selected candidates in the preview list.
- The merged candidate name is editable like any discovered candidate.
- Approval uses the existing approval flow and payload.

## Non-Goals

- This does not merge already-approved domain objects. Approved-domain merge needs separate persistence semantics because existing affinities and rollups must be migrated.
- This does not ask the LLM to re-review the merged candidate. The merged candidate is marked as manual.
