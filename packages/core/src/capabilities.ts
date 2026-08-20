import {
  credentialTransportsForPlatform,
  type HarnessCapabilityProfile,
  type HarnessPlatform,
} from "@claudexor/schema";

function supportedPlatform(platform: NodeJS.Platform): HarnessPlatform | null {
  return platform === "darwin" || platform === "linux" || platform === "win32" ? platform : null;
}

export function needsScopedHomeKeychainBridge(
  profile: HarnessCapabilityProfile,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const hostPlatform = supportedPlatform(platform);
  if (!hostPlatform) return false;
  return (
    profile.isolation.supported_containment.includes("scoped_home_keychain_bridge") &&
    credentialTransportsForPlatform(profile.auth, hostPlatform).some(
      (t) => t.kind === "os_keychain" && t.relocatable_by.includes("HOME"),
    )
  );
}
