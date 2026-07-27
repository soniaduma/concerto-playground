import { test, expect } from '@playwright/test';

test.describe('Canvas performance', () => {
  test('viewport culling removes off-screen nodes from the DOM', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Vehicles' })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Vehicles' }).click();

    // The Vehicles example has 8 declarations. With onlyRenderVisibleElements
    // active, only nodes intersecting the viewport are mounted; the count in
    // the DOM must never exceed the model size and settles at the fitted view.
    const nodeLocator = page.locator('.react-flow__node');
    await expect.poll(() => nodeLocator.count(), { timeout: 15000 }).toBeGreaterThanOrEqual(2);
    const fittedCount = await nodeLocator.count();
    expect(fittedCount).toBeLessThanOrEqual(8);

    // Zoom all the way in: most nodes leave the viewport, and the culling
    // must unmount them instead of painting them off-screen.
    const zoomIn = page.locator('.react-flow__controls-zoomin');
    await expect(zoomIn).toBeVisible();
    for (let i = 0; i < 20; i++) {
      if (await zoomIn.isDisabled()) break;
      await zoomIn.click();
    }

    await expect
      .poll(() => nodeLocator.count(), { timeout: 10000 })
      .toBeLessThan(fittedCount);
  });
});
