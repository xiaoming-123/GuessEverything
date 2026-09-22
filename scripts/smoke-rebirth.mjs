/** 真实 HTTP / 加密 / DB 闭环。请连接独立验收库的本地生产服务。 */
import { webkit, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const baseURL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100";
if (!["127.0.0.1", "localhost"].includes(new URL(baseURL).hostname))
  throw new Error("真实冒烟仅允许本地隔离服务");
await mkdir(".artifacts/rebirth", { recursive: true });
const browser = await webkit.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 360, height: 640 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const capture = (name) =>
  page.screenshot({ path: `.artifacts/rebirth/real-${name}.png` });
try {
  await page.goto(baseURL, { waitUntil: "networkidle" });
  await capture("home");
  await page.getByRole("link", { name: /开启这一世|续写这一世/ }).click();
  await expect(page.getByRole("button", { name: "跳过序章" })).toBeVisible();
  await page.getByRole("button", { name: "跳过序章" }).click();
  await expect(page.getByRole("button", { name: /研习诗词/ })).toBeEnabled();
  await capture("rank");
  await page.getByRole("button", { name: /研习诗词/ }).click();
  await expect(page.getByTestId("choice-0")).toBeEnabled();
  await page.getByRole("button", { name: /问同窗/ }).click();
  await expect(
    page.getByRole("button", { name: "本局已问同窗" }),
  ).toBeDisabled();
  for (let i = 0; i < 10; i++) {
    if (i === 3) {
      await page.reload();
      await expect(page.locator(".quiz-hud")).toContainText("第 4 / 10 题");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    await expect(page.locator(".quiz-hud")).toContainText(
      `第 ${i + 1} / 10 题`,
    );
    if (i === 0) await capture("quiz");
    await page.locator(".quiz-choice:enabled").first().click();
    await page.getByRole("button", { name: "读一读解析" }).click();
    await expect(page.getByRole("dialog")).toContainText("正解");
    if (i === 0) await capture("explanation");
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page
      .getByRole("button", {
        name: i === 9 ? "查看收获" : "下一题 →",
        exact: true,
      })
      .click();
  }
  await expect(page.getByRole("button", { name: /分享这一世/ })).toBeVisible();
  await capture("settle");
  const result = await page.locator(".settle-stats").innerText();
  await page.getByRole("button", { name: /分享这一世/ }).click();
  await expect(page.getByRole("link", { name: "保存分享图" })).toBeVisible();
  await capture("share");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.getByRole("button", { name: "返回官途", exact: true }).click();
  await page.getByRole("link", { name: /诗词阁/ }).click();
  await expect(page.locator(".poem-row").first()).toBeVisible();
  await capture("gallery");
  await page.locator(".poem-row").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const fits = await page.evaluate(
    () =>
      document.documentElement.scrollHeight <= innerHeight + 1 &&
      document.documentElement.scrollWidth <= innerWidth + 1,
  );
  if (!fits || errors.length) throw new Error(JSON.stringify({ fits, errors }));
  await writeFile(
    ".artifacts/rebirth/real-smoke.json",
    JSON.stringify(
      {
        passed: true,
        rounds: 10,
        resumeAtRound: 4,
        hint: true,
        share: true,
        gallery: true,
        result,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(
    "真实冒烟通过：10 题 → 第 4 题刷新恢复 → 结算入账 → 分享图 → 诗词入阁。",
  );
  console.log(result.replaceAll("\n", " "));
} finally {
  await browser.close();
}
