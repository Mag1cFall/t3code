import { assert, describe, it } from "@effect/vitest";
import { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  ompApprovalKind,
  ompDialogCancellation,
  ompDialogResponse,
  ompIsApproval,
  ompQuestions,
} from "./dialogs.ts";

const ask = {
  type: "extension_ui_request",
  id: "ask-1",
  method: "ask",
  questions: [
    {
      id: "color",
      question: "请选择颜色",
      header: "颜色",
      options: [{ label: "红色" }, { label: "蓝色" }],
      multi: false,
    },
    {
      id: "letters",
      question: "请选择字母",
      header: "字母",
      options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      multi: true,
    },
    {
      id: "note",
      question: "请选择备注，或自由输入",
      header: "备注",
      options: [{ label: "默认" }, { label: "空白" }],
      multi: false,
    },
  ],
};

describe("OMP 原生交互映射", () => {
  it("三问题卡片同时保留单选、多选、自由文本和原生问题ID", () => {
    const decodeQuestion = Schema.decodeSync(OrchestrationV2UserInputQuestion);
    const questions = ompQuestions(ask).map((question) => decodeQuestion(question));
    assert.deepEqual(
      questions.map((question) => [question.id, question.multiSelect, question.allowCustomAnswer]),
      [
        ["color", false, true],
        ["letters", true, true],
        ["note", false, true],
      ],
    );
    assert.deepEqual(
      ompDialogResponse(ask, undefined, {
        color: "蓝色",
        letters: ["A", "C"],
        note: "自定义验收值",
      }),
      {
        type: "extension_ui_response",
        id: "ask-1",
        answers: [
          { id: "color", selectedOptions: ["蓝色"] },
          { id: "letters", selectedOptions: ["A", "C"] },
          { id: "note", selectedOptions: [], customInput: "自定义验收值" },
        ],
      },
    );
  });

  it("多选允许已选项与自定义输入混合且空多选不是取消", () => {
    const multi = { ...ask, questions: [ask.questions[1]!] };
    assert.deepEqual(ompDialogResponse(multi, undefined, { letters: ["C", " 自定义\n文本 "] }), {
      type: "extension_ui_response",
      id: "ask-1",
      answers: [{ id: "letters", selectedOptions: ["C"], customInput: " 自定义\n文本 " }],
    });
    assert.deepEqual(ompDialogResponse(multi, undefined, { letters: [] }), {
      type: "extension_ui_response",
      id: "ask-1",
      answers: [{ id: "letters", selectedOptions: [] }],
    });
  });

  it("推荐、描述与预览仅影响显示，回应使用原生label", () => {
    const event = {
      ...ask,
      questions: [
        {
          id: "q",
          question: "选择",
          recommended: 0,
          options: [{ label: " 原值 ", description: "说明", preview: "预览" }],
        },
      ],
    };
    const questions = ompQuestions(event);
    assert.equal(questions[0]?.options[0]?.description, "Recommended\n说明\n预览");
    assert.deepEqual(ompDialogResponse(event, undefined, { q: " 原值 " }).answers, [
      { id: "q", selectedOptions: [" 原值 "] },
    ]);
  });

  it("工具审批严格区分普通select并只提供本次同意或拒绝", () => {
    const approval = {
      id: "approval",
      method: "select",
      title: "Allow tool: write\nPath: example.txt\nContent:\nhello",
      options: ["Approve", "Deny"],
    };
    assert.isTrue(ompIsApproval(approval));
    assert.equal(ompApprovalKind(approval), "file-change");
    assert.deepEqual(ompDialogResponse(approval, "accept"), {
      type: "extension_ui_response",
      id: "approval",
      value: "Approve",
    });
    assert.deepEqual(ompDialogResponse(approval, "decline"), {
      type: "extension_ui_response",
      id: "approval",
      value: "Deny",
    });
    assert.isFalse(ompIsApproval({ ...approval, title: "请选择回答" }));
    assert.isFalse(ompIsApproval({ ...approval, options: ["Approve", "Deny", "Always"] }));
    assert.throws(
      () => ompDialogResponse(approval, "acceptForSession"),
      /only support allowing or denying/u,
    );
  });

  it("确认拒绝是false而用户取消和原生超时指向原请求", () => {
    const confirm = { id: "confirm-1", method: "confirm", title: "确认", message: "是否继续" };
    assert.deepEqual(ompDialogResponse(confirm, "decline"), {
      type: "extension_ui_response",
      id: "confirm-1",
      confirmed: false,
    });
    assert.deepEqual(ompDialogResponse(confirm, "cancel"), {
      type: "extension_ui_response",
      id: "confirm-1",
      cancelled: true,
    });
    const nativeCancel = {
      type: "extension_ui_request",
      id: "cancel-frame",
      method: "cancel",
      targetId: "confirm-1",
    };
    assert.deepEqual(ompDialogCancellation(nativeCancel), {
      targetId: "confirm-1",
      response: { type: "extension_ui_response", id: "confirm-1", cancelled: true },
    });
    assert.deepEqual(ompQuestions(nativeCancel), []);
  });

  it("编辑器保留初始和提交空白，单选拒绝任意未列举值", () => {
    const editor = { id: "editor", method: "editor", title: "编辑", prefill: " 第一行\n第二行 " };
    assert.equal(ompQuestions(editor)[0]?.initialAnswer, " 第一行\n第二行 ");
    assert.deepEqual(ompDialogResponse(editor, undefined, { editor: "" }), {
      type: "extension_ui_response",
      id: "editor",
      value: "",
    });
    const select = { id: "select", method: "select", title: "选择", options: ["x", "y"] };
    assert.throws(() => ompDialogResponse(select, undefined, { select: "z" }), /provided option/u);
    assert.throws(
      () => ompDialogResponse(ask, undefined, { color: ["红色", "蓝色"] }),
      /one answer/u,
    );
  });
});
