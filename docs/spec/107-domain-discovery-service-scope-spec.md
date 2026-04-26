# 107. Domain Discovery Service Scope Spec

## Problem

Domain discovery previously used all workspace objects and signals. In large monolith/SOA workspaces, users often need to focus discovery on a subset of physical services. Without a scope control, unrelated service signals can influence candidate names, memberships, and split decisions.

## Requirements

- Users can optionally select physical services before running domain discovery.
- If no service is selected, discovery keeps the existing whole-workspace behavior.
- If one or more services are selected, discovery uses only signals extracted from those services.
- The API must validate that selected ids belong to `service` objects in the requested workspace.
- The selected scope includes:
  - selected service objects as signal-only objects,
  - direct and nested child objects of selected services,
  - approved relation targets connected to scoped objects, so storage/channel evidence already approved for those services can still participate.
- `interaction_intents`, `code_artifacts`, endpoint-derived inbound intents, and relation inputs must be filtered to the selected scope.

## API

`POST /api/domains/discover`

Request body:

```json
{
  "workspaceId": "ws-1",
  "selectedServiceIds": ["svc-cart", "svc-checkout"]
}
```

Validation:

- `selectedServiceIds` is optional.
- If present, it must be an array of non-empty strings.
- Every selected id must be a `service` object in the same workspace.

Response:

- Same as the existing discovery response.
- Candidate results are computed from the scoped input set.

## UX

- The domain discovery section shows a `발견 범위` service checklist.
- Empty selection means `전체 서비스`.
- Users can select all or clear all.
- The discover button sends `selectedServiceIds` only when the selection is non-empty.

## Non-Goals

- This does not change inference extraction. It filters already extracted signals at discovery time.
- This does not persist scope presets.
