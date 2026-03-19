import { type AuthProfileCredential, upsertAuthProfileWithLock } from "../agents/auth-profiles.js";

export async function upsertAuthProfileOrThrow(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): Promise<void> {
  const updated = await upsertAuthProfileWithLock(params);
  if (!updated) {
    throw new Error(`Failed to update auth profile "${params.profileId}" with a file lock.`);
  }
}
