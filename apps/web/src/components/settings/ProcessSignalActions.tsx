import type { ServerProcessSignal } from "@t3tools/contracts";

import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { tr } from "~/i18n";

/** Process ownership and confirmation stay with the diagnostics view. */
export function ProcessSignalActions({
  disabled,
  onSignal,
}: {
  disabled: boolean;
  onSignal: (signal: ServerProcessSignal) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              disabled={disabled}
              aria-label={tr("Send SIGINT")}
              tone="muted"
              onClick={() => onSignal("SIGINT")}
            >
              {tr("INT")}
            </InlineButton>
          }
        />
        <TooltipPopup side="top">{tr("Send SIGINT")}</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <InlineButton
              disabled={disabled}
              aria-label={tr("Send SIGKILL")}
              tone="destructive"
              onClick={() => onSignal("SIGKILL")}
            >
              {tr("KILL")}
            </InlineButton>
          }
        />
        <TooltipPopup side="top">{tr("Send SIGKILL")}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
