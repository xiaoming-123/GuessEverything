import { test, expect, type Page } from "@playwright/test";
import { mockGame } from "./fixtures";

async function fits(page: Page) {
  await page.waitForTimeout(250);
  const issues = await page.evaluate(() => {
    const issues: string[] = [];
    const viewport = { width: innerWidth, height: innerHeight };
    if (
      document.documentElement.scrollHeight > viewport.height + 1 ||
      document.documentElement.scrollWidth > viewport.width + 1
    )
      issues.push("页面产生滚动");
    const scope =
      document.querySelector("dialog[open]") ?? document.querySelector("main");
    scope
      ?.querySelectorAll<HTMLElement>(
        "button,a,.text-visible,.quiz-choice,.page-items,.settle-actions,.rank-actions,.calendar-week,.poem-row",
      )
      .forEach((el) => {
        if (
          el.closest("[aria-hidden=true],[inert]") ||
          !el.getClientRects().length
        )
          return;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;
        const label = `${el.className}: ${el.textContent?.slice(0, 30)}`;
        if (
          r.bottom > viewport.height + 1 ||
          r.top < -1 ||
          r.right > viewport.width + 1 ||
          r.left < -1
        )
          issues.push(`超出屏幕 ${label}`);
        if (
          el.scrollHeight > el.clientHeight + 2 &&
          !el.querySelector(".choice-measure") &&
          !el.classList.contains("poem-row")
        )
          issues.push(
            `内容溢出 ${label}: ${el.scrollHeight}/${el.clientHeight}`,
          );
        if (el.matches("button,a") && !el.hasAttribute("disabled")) {
          const hit = document.elementFromPoint(
            r.x + r.width / 2,
            r.y + r.height / 2,
          );
          if (hit && hit !== el && !el.contains(hit))
            issues.push(`操作被遮挡 ${label}`);
        }
      });
    return issues;
  });
  expect(issues).toEqual([]);
}

for (const viewport of [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  test(`首页、官途和浏览页适配 ${viewport.width}×${viewport.height}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await mockGame(page, { event: true });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await expect(
      page.getByRole("link", { name: /开启这一世|续写这一世/ }),
    ).toBeVisible();
    await fits(page);
    if (info.project.name === "webkit")
      await page.screenshot({
        path: `.artifacts/rebirth/home-${viewport.width}.png`,
      });
    await page.getByRole("link", { name: /开启这一世|续写这一世/ }).click();
    await expect(page.getByRole("button", { name: /研习诗词/ })).toBeVisible();
    await fits(page);
    if (info.project.name === "webkit")
      await page.screenshot({
        path: `.artifacts/rebirth/rank-${viewport.width}.png`,
      });
    await page.getByRole("button", { name: /更多/ }).click();
    await fits(page);
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    for (const route of ["gallery", "ledger", "leaderboard", "wardrobe"]) {
      await page.goto(`/play/poetry-rank/${route}`);
      await expect(page.getByRole("status")).toHaveCount(
        route === "wardrobe" ? 1 : 0,
      );
      await fits(page);
      if (route === "ledger") {
        await page.getByRole("button", { name: "月历", exact: true }).click();
        await fits(page);
        await page.getByRole("button", { name: "成就", exact: true }).click();
        await fits(page);
        await expect(page.locator(".page-items")).not.toContainText("皇帝");
      }
      if (route === "gallery") {
        await page.locator(".poem-row").first().click();
        await fits(page);
        const next = page
          .getByRole("dialog")
          .getByRole("button", { name: "下一页" });
        await expect(next).toBeEnabled();
        await next.click();
        await fits(page);
        await page.getByRole("button", { name: "关闭", exact: true }).click();
        await page.getByRole("button", { name: "下一页" }).click();
        await expect(page.locator(".poem-row").first()).not.toContainText(
          "酬乐天",
        );
        await page.getByRole("button", { name: "上一页" }).click();
        await expect(page.locator(".poem-row").first()).toContainText("酬乐天");
      }
    }
    expect(errors).toEqual([]);
  });
}

for (const width of [320, 360, 390, 844]) {
  test(`完整对局、解析与分享 ${width}`, async ({ page }, info) => {
    await page.setViewportSize({
      width,
      height:
        width === 320 ? 568 : width === 360 ? 640 : width === 844 ? 390 : 844,
    });
    await mockGame(page, { longQuestion: true, promoted: true });
    await page.goto("/play/poetry-rank");
    await page.getByRole("button", { name: /研习诗词/ }).click();
    await expect(page.getByTestId("choice-0")).toBeEnabled();
    await fits(page);
    if (info.project.name === "webkit")
      await page.screenshot({
        path: `.artifacts/rebirth/quiz-long-${width}.png`,
      });
    await expect(
      page.locator(".question-card").getByRole("button", { name: "下一页" }),
    ).toBeEnabled();
    await page
      .locator(".question-card")
      .getByRole("button", { name: "下一页" })
      .click();
    for (let i = 0; i < 3; i++) {
      await page.getByTestId("choice-0").click();
      await page.getByRole("button", { name: "读一读解析" }).click();
      await fits(page);
      await page.waitForTimeout(1700);
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: "关闭", exact: true }).click();
      await fits(page);
      await page
        .getByRole("button", {
          name: i === 2 ? "查看收获" : "下一题 →",
          exact: true,
        })
        .click();
    }
    await expect(
      page.getByRole("button", { name: /分享这一世/ }),
    ).toBeVisible();
    await fits(page);
    if (info.project.name === "webkit")
      await page.screenshot({ path: `.artifacts/rebirth/settle-${width}.png` });
    await page.getByRole("button", { name: /分享这一世/ }).click();
    await expect(page.getByRole("link", { name: "保存分享图" })).toBeVisible();
    await fits(page);
  });
}

for (const rankId of [8, 9, 10]) {
  test(`官阶 ${rankId} 显隐与衣冠`, async ({ page }) => {
    await mockGame(page, { rankId, event: true });
    await page.goto("/play/poetry-rank");
    await page.getByRole("button", { name: /更多/ }).click();
    await expect(page.getByRole("button", { name: /猜官衔/ })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /衣冠/ })).toHaveCount(
      rankId >= 9 ? 1 : 0,
    );
    await fits(page);
    await page.goto("/play/poetry-rank/wardrobe");
    if (rankId >= 9)
      await expect(
        page.getByRole("button", { name: "尚未解锁" }),
      ).toBeVisible();
    else await expect(page.getByRole("status")).toContainText("尚未开启");
    await fits(page);
  });
}

test("密钥交换失败可重试，恢复中对局不再显示序章", async ({ page }) => {
  await mockGame(page, { failKeyOnce: true, resume: true });
  await page.goto("/play/poetry-rank");
  await expect(page.getByRole("button", { name: "重新载入" })).toBeVisible();
  await page.getByRole("button", { name: "重新载入" }).click();
  await expect(page.getByTestId("choice-0")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await fits(page);
});

test("服务异常呈现重试，不无限加载", async ({ page }) => {
  await mockGame(page, { failRank: true });
  await page.goto("/play/poetry-rank");
  await expect(page.locator("main").getByRole("alert")).toContainText("重试");
  await fits(page);
});

test("极长选项完整阅读后确认，展开不误提交", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const { requests } = await mockGame(page, { longOptions: true });
  await page.goto("/play/poetry-rank");
  await page.getByRole("button", { name: /研习诗词/ }).click();
  await expect(page.getByTestId("choice-0")).toContainText("展开全文");
  await fits(page);
  await page.getByTestId("choice-0").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(requests.filter((path) => path.endsWith("/answer"))).toHaveLength(0);
  await fits(page);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "下一页" })
    .click();
  await page.getByRole("button", { name: "选择这一项" }).click();
  await expect(page.getByRole("button", { name: "读一读解析" })).toBeVisible();
});
