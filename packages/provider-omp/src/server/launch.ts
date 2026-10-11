import type { RuntimeMode } from "@t3tools/contracts";
import type { OmpSettings } from "../settings.ts";

// ompProfileArgs 选择实例使用的 OMP 配置档案
export function ompProfileArgs(settings: OmpSettings): string[] {
  return settings.profile ? ["--profile", settings.profile] : [];
}

// ompLaunchArgs 将 T3 权限模式交给 OMP 原生策略执行
export function ompLaunchArgs(settings: OmpSettings, mode?: RuntimeMode): string[] {
  const args = [...ompProfileArgs(settings), "--mode", "rpc-ui"];
  if (mode !== undefined) {
    const approval =
      mode === "full-access" ? "yolo" : mode === "auto-accept-edits" ? "write" : "always-ask";
    args.push("--approval-mode", approval);
  }
  return args;
}

// ompProbeArgs 在无持久会话的进程中读取模型与状态
export function ompProbeArgs(settings: OmpSettings): string[] {
  return [...ompLaunchArgs(settings), "--no-session", "--no-tools", "--no-extensions", "--no-lsp"];
}
