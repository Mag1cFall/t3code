import type { RuntimeMode } from "@t3tools/contracts";
import { type LucideIcon, LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon } from "lucide-react";
import { tr } from "~/i18n";

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: tr("Supervised"),
    description: tr("Ask before commands and file changes."),
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: tr("Auto-accept edits"),
    description: tr("Auto-approve edits, ask before other actions."),
    icon: PenLineIcon,
  },
  auto: {
    label: tr("Auto"),
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: tr("Full access"),
    description: tr("Allow commands and edits without prompts."),
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
