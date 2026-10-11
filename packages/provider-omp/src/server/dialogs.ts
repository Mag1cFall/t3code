import type {
  OrchestrationV2UserInputQuestion,
  ProviderApprovalDecision,
  ProviderRequestKind,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { field, number, text, type OmpRecord } from "./wire.ts";

export interface OmpDialogCancellation {
  readonly targetId: string;
  readonly response: OmpRecord;
}

// ompDialogCancellation 解析原生取消和超时所指向的原请求
export function ompDialogCancellation(event: OmpRecord): OmpDialogCancellation | undefined {
  if (event.method !== "cancel") return undefined;
  const targetId = text(event, "targetId");
  return targetId === undefined
    ? undefined
    : {
        targetId,
        response: { type: "extension_ui_response", id: targetId, cancelled: true },
      };
}

// ompIsApproval 识别原生确认和具有固定选项的工具审批
export function ompIsApproval(event: OmpRecord): boolean {
  return (
    event.method === "confirm" ||
    (event.method === "select" &&
      /^Allow tool: [^\r\n]+(?:\r?\n|$)/u.test(text(event, "title") ?? "") &&
      Array.isArray(event.options) &&
      event.options.length === 2 &&
      event.options[0] === "Approve" &&
      event.options[1] === "Deny")
  );
}

// ompApprovalKind 按原生工具名称选择共享审批类型
export function ompApprovalKind(event: OmpRecord): ProviderRequestKind {
  const tool = /^Allow tool: ([^\r\n]+)/u.exec(text(event, "title") ?? "")?.[1];
  if (tool === "bash" || tool === "python" || tool === "exec" || tool === "eval") return "command";
  if (tool === "write" || tool === "edit" || tool === "ast_edit") return "file-change";
  if (
    tool === "read" ||
    tool === "grep" ||
    tool === "glob" ||
    tool === "find" ||
    tool === "ast_grep"
  )
    return "file-read";
  return "permission";
}

// ompQuestions 将原生问题和选项元数据转换为共享问答卡片
export function ompQuestions(event: OmpRecord): OrchestrationV2UserInputQuestion[] {
  const method = text(event, "method");
  const id = text(event, "id");
  if (id === undefined) return [];
  if (method === "ask" && Array.isArray(event.questions)) {
    return event.questions.map((question: unknown) => {
      const questionId = text(question, "id")!;
      const questionText = text(question, "question")!;
      const options = field(question, "options");
      const recommended = number(question, "recommended");
      return {
        id: questionId,
        header: text(question, "header")?.trim() || questionText,
        question: questionText,
        options: Array.isArray(options)
          ? options.map((option: unknown, index: number) => {
              const label = text(option, "label")!;
              return {
                label: label.trim() || "(empty)",
                value: label,
                description:
                  [
                    index === recommended ? "Recommended" : undefined,
                    text(option, "description"),
                    text(option, "preview"),
                  ]
                    .filter((part) => part?.trim())
                    .join("\n") ||
                  label.trim() ||
                  "(empty)",
              };
            })
          : [],
        multiSelect: field(question, "multi") === true,
        allowCustomAnswer: true,
        required: field(question, "multi") !== true,
      };
    });
  }
  if (method !== "select" && method !== "input" && method !== "editor") return [];
  const title = text(event, "title")?.trim() || "OMP";
  const options = method === "select" && Array.isArray(event.options) ? event.options : [];
  const details = Array.isArray(event.optionDetails) ? event.optionDetails : [];
  return [
    {
      id,
      header: title,
      question: text(event, "message")?.trim() || text(event, "placeholder")?.trim() || title,
      options: options.map((option: string, index: number) => ({
        label: option.trim() || "(empty)",
        value: option,
        description: text(details[index], "description")?.trim() || option.trim() || "(empty)",
      })),
      multiSelect: false,
      allowCustomAnswer: method !== "select",
      ...(method === "editor" || method === "input"
        ? { initialAnswer: text(event, "prefill") ?? "", required: false }
        : {}),
    },
  ];
}

// ompDialogResponse 保留选项原值和自由输入并区分拒绝与取消
export function ompDialogResponse(
  event: OmpRecord,
  decision?: ProviderApprovalDecision,
  answers?: ProviderUserInputAnswers,
): OmpRecord {
  const cancellation = ompDialogCancellation(event);
  if (cancellation !== undefined) return cancellation.response;
  const base = { type: "extension_ui_response", id: event.id };
  if (decision === "cancel") return { ...base, cancelled: true };
  if (ompIsApproval(event)) {
    if (decision === undefined) return { ...base, cancelled: true };
    if (decision !== "accept" && decision !== "decline")
      throw new Error("OMP approvals only support allowing or denying this request.");
    return event.method === "confirm"
      ? { ...base, confirmed: decision === "accept" }
      : { ...base, value: decision === "accept" ? "Approve" : "Deny" };
  }
  if (answers === undefined) return { ...base, cancelled: true };
  if (event.method !== "ask") {
    const value = answers[String(event.id)];
    if (typeof value !== "string") throw new Error("OMP dialogs require a text answer.");
    if (
      event.method === "select" &&
      Array.isArray(event.options) &&
      !event.options.includes(value)
    ) {
      throw new Error("OMP selection answers must use a provided option.");
    }
    return { ...base, value };
  }
  const questions = ompQuestions(event);
  return {
    ...base,
    answers: questions.map((question) => {
      const answer = answers[question.id];
      if (answer !== undefined && typeof answer !== "string" && !Array.isArray(answer)) {
        throw new Error("OMP question answers must be text or a list of text options.");
      }
      const values: unknown[] = Array.isArray(answer)
        ? answer
        : typeof answer === "string"
          ? [answer]
          : [];
      const labels = new Set(question.options.map((option) => option.value ?? option.label));
      const selectedOptions: string[] = [];
      const custom: string[] = [];
      for (const value of values) {
        if (typeof value !== "string") throw new Error("OMP question options must be text.");
        if (labels.has(value)) selectedOptions.push(value);
        else if (value.trim()) custom.push(value);
      }
      if (!question.multiSelect && selectedOptions.length + custom.length > 1) {
        throw new Error("OMP single-select questions only accept one answer.");
      }
      return {
        id: question.id,
        selectedOptions,
        ...(custom.length > 0 ? { customInput: custom.join("\n") } : {}),
      };
    }),
  };
}
