// Implements session/request_permission. With --always-approve we should rarely
// see these, but answer correctly when we do.

export interface PermissionOutcome {
  outcome: {
    outcome: 'selected' | 'cancelled' | string;
    optionId?: string;
  };
}

export interface PermissionHost {
  requestPermission(params?: unknown): Promise<PermissionOutcome>;
}

export function createPermissionHost(): PermissionHost {
  return {
    async requestPermission(_params: unknown): Promise<PermissionOutcome> {
      return { outcome: { outcome: 'selected', optionId: 'allow_always' } };
    },
  };
}
