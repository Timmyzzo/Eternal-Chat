import type { ProtocolProfile } from "@/domain/provider";
import {
  createOfficialProtocolPresets,
  OFFICIAL_PRESET_REVISION,
  OPENAI_CHAT_PROFILE_ID as OFFICIAL_OPENAI_CHAT_PROFILE_ID,
  OPENAI_RESPONSES_PROFILE_ID as OFFICIAL_OPENAI_RESPONSES_PROFILE_ID,
} from "@/infrastructure/providers/officialPresetRegistry";

export const OPENAI_CHAT_COMPLETIONS_CODEC = "openai_chat_completions";
export const OPENAI_RESPONSES_CODEC = "openai_responses";

export const OPENAI_CHAT_COMPLETIONS_PROFILE_ID = OFFICIAL_OPENAI_CHAT_PROFILE_ID;
export const OPENAI_RESPONSES_PROFILE_ID = OFFICIAL_OPENAI_RESPONSES_PROFILE_ID;

export const OPENAI_PROFILE_REVISION = OFFICIAL_PRESET_REVISION;

export function createOpenAIProtocolPresets(now: number): ProtocolProfile[] {
  return createOfficialProtocolPresets(now).filter(
    (profile) =>
      profile.codecId === OPENAI_CHAT_COMPLETIONS_CODEC ||
      profile.codecId === OPENAI_RESPONSES_CODEC,
  );
}
