import { HistoryIcon } from "lucide-react";

import { MiddleTruncate } from "./ui/middle-truncate";
import { tr } from "~/i18n";

export function PreviousWorktreeItemContent({ branch }: { branch: string | null }) {
  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <HistoryIcon className="mt-1 size-3" />
      <span className="flex min-w-0 flex-col">
        <span>{tr("Previous worktree")}</span>
        {branch ? (
          <span className="min-w-0 text-xs text-muted-foreground">
            <MiddleTruncate value={branch} />
          </span>
        ) : null}
      </span>
    </span>
  );
}
