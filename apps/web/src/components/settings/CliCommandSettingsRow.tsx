import type { DesktopCliCommandState } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { tr } from "~/i18n";

/**
 * Settings → `t3` command: puts the desktop app's bundled CLI on PATH, or takes
 * it off again. Hidden where the desktop build has no launcher to install.
 */
export function CliCommandSettingsRow() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.cliCommand;
  const [state, setState] = useState<DesktopCliCommandState | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .getState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const change = useCallback(
    (action: "install" | "uninstall") => {
      if (!bridge || pending) return;
      setPending(true);
      void bridge[action]()
        .then(setState)
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: action === "install" ? tr("Could not install t3") : tr("Could not remove t3"),
              description: error instanceof Error ? error.message : tr("Something went wrong."),
            }),
          );
        })
        .finally(() => setPending(false));
    },
    [bridge, pending],
  );

  if (!bridge || !state?.supported) return null;
  const installed = state.installedPath !== null;
  const description = state.shadowedBy
    ? tr("Another t3 at {{shadowedBy}} runs first in a new terminal. Remove it to use T3 Code's.", {
        shadowedBy: state.shadowedBy,
      })
    : !installed
      ? tr("Run T3 Code's CLI as `t3` from any terminal.")
      : state.onPath
        ? tr("Installed at {{installedPath}}. Open a new terminal to use it.", {
            installedPath: state.installedPath,
          })
        : tr(
            "Installed at {{installedPath}}, which is not on your PATH yet. Add its folder to your PATH to run `t3`.",
            { installedPath: state.installedPath },
          );

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => change(installed ? "uninstall" : "install")}
        >
          {installed ? tr("Remove") : tr("Install")}
        </Button>
      }
    />
  );
}
