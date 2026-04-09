import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { normalizeProviderId } from "../provider-id.js";
import {
  ensureAuthProfileStoreForLocalUpdate,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

export function dedupeProfileIds(profileIds: string[]): string[] {
  return [...new Set(profileIds)];
}

export async function setAuthProfileOrder(params: {
  agentDir?: string;
  provider: string;
  order?: string[] | null;
}): Promise<AuthProfileStore | null> {
  const providerKey = normalizeProviderId(params.provider);
  const sanitized =
    params.order && Array.isArray(params.order) ? normalizeStringEntries(params.order) : [];
  const deduped = dedupeProfileIds(sanitized);

  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      store.order = store.order ?? {};
      if (deduped.length === 0) {
        if (!store.order[providerKey]) {
          return false;
        }
        delete store.order[providerKey];
        if (Object.keys(store.order).length === 0) {
          store.order = undefined;
        }
        return true;
      }
      store.order[providerKey] = deduped;
      return true;
    },
  });
}

export function upsertAuthProfile(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): void {
  const credential = sanitizeAuthProfileCredential(params.credential);
  const store = ensureAuthProfileStoreForLocalUpdate(params.agentDir);
  store.profiles[params.profileId] = credential;
  saveAuthProfileStore(store, params.agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

export async function upsertAuthProfileWithLock(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
  throwOnError?: boolean;
}): Promise<AuthProfileStore | null> {
  const credential = sanitizeAuthProfileCredential(params.credential);
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    throwOnError: params.throwOnError,
    updater: (store) => {
      store.profiles[params.profileId] = credential;
      return true;
    },
  });
}

function sanitizeAuthProfileCredential(credential: AuthProfileCredential): AuthProfileCredential {
  if (credential.type === "api_key") {
    return {
      ...credential,
      ...(typeof credential.key === "string" ? { key: normalizeSecretInput(credential.key) } : {}),
    };
  }
  if (credential.type === "token") {
    return {
      ...credential,
      token: normalizeSecretInput(credential.token),
    };
  }
  return credential;
}

export function listProfilesForProvider(store: AuthProfileStore, provider: string): string[] {
  const providerKey = resolveProviderIdForAuth(provider);
  return Object.entries(store.profiles)
    .filter(([, cred]) => resolveProviderIdForAuth(cred.provider) === providerKey)
    .map(([id]) => id);
}

export async function markAuthProfileGood(params: {
  store: AuthProfileStore;
  provider: string;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, provider, profileId, agentDir } = params;
  const providerKey = resolveProviderIdForAuth(provider);
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profile = freshStore.profiles[profileId];
      if (!profile || resolveProviderIdForAuth(profile.provider) !== providerKey) {
        return false;
      }
      freshStore.lastGood = { ...freshStore.lastGood, [providerKey]: profileId };
      return true;
    },
  });
  if (updated) {
    store.lastGood = updated.lastGood;
    return;
  }
  const profile = store.profiles[profileId];
  if (!profile || resolveProviderIdForAuth(profile.provider) !== providerKey) {
    return;
  }
  store.lastGood = { ...store.lastGood, [providerKey]: profileId };
  saveAuthProfileStore(store, agentDir);
}
