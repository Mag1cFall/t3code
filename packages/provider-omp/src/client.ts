import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";
import { OmpSettings } from "./settings.ts";

// ompClient 定义桌面与移动界面共享的 OMP 入口
export const ompClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("omp"),
  label: "OMP",
  settingsSchema: OmpSettings,
  icon: {
    viewBox: "0 0 64 64",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    // paths 使用 https://omp.sh/favicon.svg 中的官方标识轮廓
    paths: [{ d: "M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z" }],
  },
});
