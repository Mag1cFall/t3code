import { describe, expect, it } from "vite-plus/test";
import { ompAuthStatus, ompCommands, ompModels } from "./status.ts";

describe("OMP 原生能力发现", () => {
  it("预算推理保留原生等级并遵守强制推理，标签沿用共享选择器", () => {
    const [model] = ompModels(
      {
        models: [
          {
            provider: "vendor",
            id: "family/budget",
            name: "Budget",
            reasoning: true,
            thinking: {
              mode: "budget",
              efforts: ["low", "high"],
              requiresEffort: true,
              effortBudgets: { low: 1024, high: 8192 },
            },
          },
        ],
      },
      { model: { provider: "vendor", id: "family/budget" }, thinkingLevel: "high" },
    );
    expect(model?.slug).toBe("vendor/family/budget");
    expect(model?.capabilities?.optionDescriptors).toEqual([
      {
        id: "thinking",
        label: "Thinking",
        type: "select",
        options: [
          { id: "low", label: "Low" },
          { id: "high", label: "High", isDefault: true },
        ],
      },
    ]);
  });

  it("原生允许关闭推理时显示 off 并保留最高推理等级", () => {
    const [model] = ompModels(
      {
        models: [
          {
            provider: "vendor",
            id: "adaptive",
            reasoning: true,
            thinking: {
              mode: "anthropic-adaptive",
              efforts: ["high", "max"],
              requiresEffort: true,
              suppressWhenOff: true,
              defaultLevel: "max",
            },
          },
        ],
      },
      {},
    );
    const descriptor = model?.capabilities?.optionDescriptors?.[0];
    expect(
      descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [],
    ).toEqual(["off", "high", "max"]);
  });

  it("无会话模型目录只显示原生提供的等级，不猜测关闭能力", () => {
    const [model] = ompModels(
      {
        models: [
          { provider: "vendor", id: "cli", reasoning: true, thinking: ["minimal", "xhigh"] },
        ],
      },
      undefined,
    );
    expect(model?.capabilities?.optionDescriptors).toEqual([
      {
        id: "thinking",
        label: "Thinking",
        type: "select",
        options: [
          { id: "minimal", label: "Minimal" },
          { id: "xhigh", label: "Extra High" },
        ],
      },
    ]);
  });

  it("不为不可控推理模型编造等级", () => {
    const [model] = ompModels(
      {
        models: [
          { provider: "vendor", id: "plain", reasoning: false, thinking: { efforts: ["high"] } },
        ],
      },
      {},
    );
    expect(model?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("命令和技能均使用原生名字与参数提示", () => {
    const result = ompCommands({
      commands: [
        { name: "compact", source: "builtin", input: { hint: "instructions" } },
        {
          name: "skill:review",
          description: "审阅",
          source: "skill",
          input: { hint: "arguments" },
        },
        { name: "team-task", source: "extension" },
      ],
    });
    expect(result.slashCommands.map((command) => command.name)).toEqual(["compact", "team-task"]);
    expect(result.skills).toEqual([
      { name: "review", path: "omp:skill:review", enabled: true, description: "审阅" },
    ]);
    expect(result.slashCommands[0]?.input).toEqual({ hint: "instructions" });
  });

  it("模型可用不等于 OAuth 已登录", () => {
    expect(
      ompAuthStatus(
        { providers: [{ id: "vendor", name: "Vendor", authenticated: false }] },
        "work",
      ),
    ).toEqual({ status: "unknown", profileId: "work", canLogout: false });
    expect(
      ompAuthStatus({ providers: [{ id: "vendor", name: "Vendor", authenticated: true }] }, "work"),
    ).toMatchObject({ status: "authenticated", label: "Vendor", profileId: "work" });
  });
});
