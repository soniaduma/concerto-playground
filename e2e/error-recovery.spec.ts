import { test, expect } from '@playwright/test';

// Replaces the CTO editor content through the Monaco API. Typing the text
// key by key is flaky: Monaco's suggestion widget swallows Enter presses.
async function setEditorText(page: import('@playwright/test').Page, text: string) {
  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toBeVisible({ timeout: 15000 });
  await page.evaluate((t) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const monaco = (window as any).monaco;
    monaco.editor.getEditors()[0].getModel().setValue(t);
  }, text);
}

// A schema with a syntax error: concept declaration without a name
const BROKEN_CTO = 'namespace org.broken@1.0.0\nconcept {\n}\n';
const FIXED_CTO = 'namespace org.fixed@1.0.0\nconcept Person {\n  o String name\n}\n';

test.describe('Graph parse error banner', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Concerto Schema')).toBeVisible({ timeout: 15000 });
  });

  test('shows an error banner with line information instead of dropping the update', async ({ page }) => {
    // The NDA example renders a graph first
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 15000 });

    await setEditorText(page, BROKEN_CTO);

    // Monaco renders its own hidden role=alert elements, so match ours by text
    const banner = page.getByRole('alert').filter({ hasText: 'Schema parse error' });
    await expect(banner).toBeVisible({ timeout: 5000 });
    // The Concerto parser reports the position of the syntax error
    await expect(banner).toContainText(/[Ll]ine \d+/);

    // The last valid graph must stay on screen behind the banner
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
  });

  test('clears the banner once the schema parses again', async ({ page }) => {
    const banner = page.getByRole('alert').filter({ hasText: 'Schema parse error' });
    await setEditorText(page, BROKEN_CTO);
    await expect(banner).toBeVisible({ timeout: 5000 });

    await setEditorText(page, FIXED_CTO);

    await expect(banner).toBeHidden({ timeout: 5000 });
    await expect(page.locator('.react-flow__node', { hasText: 'Person' })).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Graph semantic error banner', () => {
  test('shows validator errors when the text parses but the model is invalid', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Concerto Schema')).toBeVisible({ timeout: 15000 });

    await setEditorText(page, 'namespace org.x@1.0.0\nconcept Person {\n  o Address home\n}\n');

    const banner = page.getByRole('alert').filter({ hasText: 'Undeclared type' });
    await expect(banner).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Form view parse error banner', () => {
  test('lists namespaces that fail to parse instead of hiding them silently', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Concerto Schema')).toBeVisible({ timeout: 15000 });

    await setEditorText(page, BROKEN_CTO);
    await page.getByRole('button', { name: 'Form' }).click();

    const banner = page.getByRole('alert').filter({ hasText: 'syntax error' });
    await expect(banner).toBeVisible({ timeout: 5000 });
    await expect(banner).toContainText('org.broken@1.0.0');
  });
});
