import { useAtomValue } from "@effect/atom-react";

import { undoLatestThreadAction, useThreadUndoNotice } from "../../hooks/showThreadUndoNotice";
import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { Alert, AlertDescription } from "../ui/alert";
import { InlineButton } from "../ui/button";
import { tr } from "~/i18n";

export function SidebarThreadUndoNotice() {
  const notice = useThreadUndoNotice((state) => state.notice);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  if (!notice) return null;
  const shortcut = shortcutLabelForCommand(keybindings, "thread.undo");
  const values = { count: notice.count, s: notice.count === 1 ? "" : "s" };
  const summary =
    notice.action === "Settled"
      ? tr("Settled {{count}} thread{{s}},", values)
      : notice.action === "Snoozed"
        ? tr("Snoozed {{count}} thread{{s}},", values)
        : notice.action === "Unpinned"
          ? tr("Unpinned {{count}} thread{{s}},", values)
          : notice.action === "Archived"
            ? tr("Archived {{count}} thread{{s}},", values)
            : tr("Discarded {{count}} draft{{s}},", values);

  return (
    <Alert role="status" variant="sidebar">
      <AlertDescription>
        {summary}{" "}
        <InlineButton onClick={undoLatestThreadAction}>
          {shortcut ? tr("{{shortcut}} to undo", { shortcut }) : tr("Undo")}
        </InlineButton>
      </AlertDescription>
    </Alert>
  );
}
