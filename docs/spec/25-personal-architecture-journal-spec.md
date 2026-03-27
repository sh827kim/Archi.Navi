# 25. Personal Architecture Journal (SPEC) (Roadmap 5-3)

상태: Draft
작성일: 2026-03-08

## 1. 목적

서비스/관계에 **개인 메모/태그 연결** → 암묵지 체계화.

## 2. 범위

### 포함
- object_notes CRUD, 카테고리 (warning/tip/todo/context/decision)
- Object Mapping 메모 아이콘, 검색/필터 페이지, export/import

### 제외: 팀 공유/댓글, AI 보강, 알림

## 3. 데이터 모델

```sql
CREATE TABLE object_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  object_id UUID NOT NULL REFERENCES objects(id),
  relation_id UUID REFERENCES object_relations(id),
  content TEXT NOT NULL,
  category VARCHAR(50) NOT NULL DEFAULT 'context',
  pinned BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);
```

## 4. API

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/notes?objectId=&category=` | 메모 목록 |
| POST | `/api/notes` | 생성 |
| PATCH | `/api/notes/:id` | 수정 |
| DELETE | `/api/notes/:id` | 삭제 |
| GET | `/api/notes/search?q=` | 검색 |

## 5. 수용 기준

| ID | 기준 |
|----|------|
| T1 | 서비스 Object에 메모 CRUD |
| T2 | 특정 관계에 메모 연결 |
| T3 | 카테고리별 필터 |
| T4 | Object Mapping에 메모 아이콘 |
| T5 | 전문 검색 동작 |
| T6 | export에 메모 포함, import로 복원 |
