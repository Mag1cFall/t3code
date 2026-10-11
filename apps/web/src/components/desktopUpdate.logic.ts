import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import { tr } from "~/i18n";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const DESKTOP_RELEASE_HISTORY_URL = "https://github.com/pingdotgg/t3code/releases";
const DESKTOP_RELEASE_TAG_URL = `${DESKTOP_RELEASE_HISTORY_URL}/tag`;

/**
 * The main process fills `downloadedVersion` from the updater's `update-downloaded`
 * event, which is dispatched on its own fiber. A download RPC can therefore resolve
 * before that write lands, so fall back to the version the download was started for.
 */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

/** Release notes for an exact downloaded build; nightly suffixes are part of the tag. */
export function getDesktopUpdateReleaseUrl(version: string | null): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${DESKTOP_RELEASE_TAG_URL}/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(): string {
  return DESKTOP_RELEASE_HISTORY_URL;
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return tr("This install is using the correct architecture.");
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return tr(
      "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.",
    );
  }
  if (action === "install") {
    return tr(
      "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.",
    );
  }
  return tr(
    "This Mac has Apple Silicon, but T3 Code is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.",
  );
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "available") {
    return tr("Update {{value}} ready to download", {
      value: state.availableVersion ?? "available",
    });
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return tr("Downloading update{{progress}}", { progress });
  }
  if (state.status === "downloaded") {
    return tr("Update {{value}} downloaded. Click to restart and install.", {
      value: state.downloadedVersion ?? state.availableVersion ?? "ready",
    });
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return tr("Download failed for {{availableVersion}}. Click to retry.", {
        availableVersion: state.availableVersion,
      });
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return tr("Install failed for {{downloadedVersion}}. Click to retry.", {
        downloadedVersion: state.downloadedVersion,
      });
    }
    if (state.downloadedVersion) {
      return tr("Update {{downloadedVersion}} downloaded. Click to restart and install.", {
        downloadedVersion: state.downloadedVersion,
      });
    }
    return state.message ?? tr("Update failed");
  }
  return tr("Up to date");
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return tr(
    "Install update{{value}} and restart T3 Code?\n\nAny running tasks will be interrupted. Make sure you're ready before continuing.",
    { value: version ? ` ${version}` : "" },
  );
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}
