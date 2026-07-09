import { describe, expect, it } from "vitest"
import {
  createDefaultAnswerPromptTemplatePreviews,
} from "@/lib/interview-settings"

describe("prompt template panel model", () => {
  it("uses five editable default answer templates", () => {
    const previews = createDefaultAnswerPromptTemplatePreviews()

    expect(previews.map((item) => item.questionType)).toEqual([
      "项目经历概览类",
      "项目方法方案类",
      "项目细节深挖类",
      "知识八股类",
      "手撕代码类",
    ])
    expect(previews[0].text).toContain("（识别/继承的项目）")
    expect(previews[3].text).toContain("没有相关笔记")
    expect(previews[4].text).toContain("无需查询知识库")
  })
})
