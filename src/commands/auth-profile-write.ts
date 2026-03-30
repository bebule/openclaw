import { type AuthProfileCredential, upsertAuthProfileWithLock } from "../agents/auth-profiles.js";

export async function upsertAuthProfileOrThrow(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): Promise<void> {
  try {
    const updated = await upsertAuthProfileWithLock({
      ...params,
      throwOnError: true,
    });
    if (!updated) {
      throw new Error("Auth profile store did not report a successful update.");
    }
  } catch (error) {
    throw new Error(`Failed to update auth profile "${params.profileId}".`, { cause: error });
  }
}
