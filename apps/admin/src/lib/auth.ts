import { useQuery } from '@tanstack/react-query';
import type { Role } from '@vs/shared';
import { ApiError, get, setCsrf } from './api';

export interface Me {
  id: string;
  email: string;
  role: Role;
  stage: 'pending_totp' | 'enroll_required' | 'full';
  totpEnabled: boolean;
  totpRequired: boolean;
  csrfToken: string | null;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const me = await get<Me>('/me');
        setCsrf(me.csrfToken);
        return me;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

const LEVEL: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
export const can = (me: Me | null | undefined, min: Role) => !!me && LEVEL[me.role] >= LEVEL[min];
