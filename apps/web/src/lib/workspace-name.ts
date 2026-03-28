export const WORKSPACE_NAME_MAX_LENGTH = 20;

export function normalizeWorkspaceName(rawName?: string | null) {
  const name = rawName?.trim() ?? '';

  if (!name) {
    return { error: 'name is required' } as const;
  }

  if (name.length > WORKSPACE_NAME_MAX_LENGTH) {
    return { error: `name must be at most ${WORKSPACE_NAME_MAX_LENGTH} characters` } as const;
  }

  return { name } as const;
}
