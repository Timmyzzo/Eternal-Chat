import { expect, test } from "@playwright/test";

test("the shell fits the configured desktop window and switches theme", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "No conversation selected" })).toBeVisible();

  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(hasOverflow).toBe(false);

  await page.getByRole("button", { name: "Open appearance settings" }).click();
  await expect(page.getByRole("dialog", { name: "Appearance" })).toBeVisible();
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.getByRole("button", { name: "Close appearance settings" }).click();
  await expect(page.getByRole("dialog", { name: "Appearance" })).toBeHidden();
});

test("reduced motion keeps the sheet usable without a large slide", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");

  await page.getByRole("button", { name: "Open appearance settings" }).click();

  const sheet = page.getByRole("dialog", { name: "Appearance" });
  await expect(sheet).toHaveAttribute("data-motion-reduced", "true");
  await expect(sheet).toBeVisible();
});
