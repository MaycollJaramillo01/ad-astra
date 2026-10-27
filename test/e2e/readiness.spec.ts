import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

type Fixture = {
  tenantId: string;
  otherTenantId: string;
  accountId: string;
  campaignId: string;
  ownerId: string;
  viewerId: string;
  cookies: Record<string, string>;
};
let f: Fixture;
test.beforeAll(async () => {
  f = JSON.parse(await readFile('spike-output/readiness/browser.json', 'utf8'));
});
test.beforeEach(async ({ context, page }) => {
  await context.addCookies([
    {
      name: 'ad-astra.session_token',
      value: f.cookies[f.ownerId] ?? '',
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.addInitScript((id) => localStorage.setItem('ad-astra.tenant', id), f.tenantId);
});
test('autenticación, aislamiento y CSRF con HTTP real', async ({ request, context }) => {
  const unauth = await request.get('/v1/clients', {
    headers: { 'x-test-user': f.ownerId, 'x-tenant-id': f.tenantId },
  });
  expect(unauth.status()).toBe(401);
  const foreign = await context.request.get('/v1/clients', {
    headers: { 'x-tenant-id': f.otherTenantId },
  });
  expect(foreign.status()).toBe(403);
  expect(await foreign.text()).not.toContain('Cliente browser-b');
  const csrf = await context.request.post(`/v1/monitoring/${f.accountId}/evaluate`, {
    headers: { Origin: 'https://evil.invalid', 'x-tenant-id': f.tenantId },
  });
  expect(csrf.status()).toBe(403);
});
test('métricas no disponibles no se presentan como costo cero', async ({ page }) => {
  await page.goto(`/analitica/campana/${f.campaignId}`);
  await expect(page.getByRole('heading', { name: /Campaña browser-a/ })).toBeVisible();
  await expect(page.getByText('No disponible', { exact: false }).first()).toBeVisible();
});
test('configuración, evaluación, decisión e informes en navegador', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/monitoreo/${f.accountId}`);
  await page.getByRole('button', { name: 'Reglas y canales', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Motivo de autorización' })
    .fill('Autorización de prueba sintética para configuración');
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/policy') && r.request().method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Guardar y autorizar configuración' }).click();
  expect((await saved).status()).toBe(200);
  const evaluated = page.waitForResponse((r) => r.url().endsWith('/evaluate'));
  await page.getByRole('button', { name: 'Evaluar ahora' }).click();
  expect((await evaluated).status()).toBe(200);
  await page.getByRole('button', { name: 'Incidentes', exact: true }).click();
  const incident = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: /Conexión/ }) });
  await expect(incident).toBeVisible();
  await incident.getByLabel('Decisión', { exact: true }).selectOption('snoozed');
  await incident
    .getByRole('textbox', { name: 'Motivo de la decisión' })
    .fill('Incidente sintético silenciado durante la prueba');
  const decided = page.waitForResponse((r) => r.url().endsWith('/decide'));
  await incident.getByRole('button', { name: 'Registrar' }).click();
  expect((await decided).status()).toBe(200);
  await expect(incident.getByText(/Crítica · Silenciado/)).toBeVisible();
  await page.getByRole('button', { name: 'Informes', exact: true }).click();
  await page.getByRole('button', { name: 'Generar informe', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Informe ejecutivo/ })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar técnico JSON' }).click();
  expect((await download).suggestedFilename()).toMatch(/^informe-tecnico-.*\.json$/);
  await page.goto('/operaciones');
  await expect(page.getByRole('heading', { name: 'Estado técnico' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Alertas técnicas' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Reservas pendientes (USD)' })).toBeVisible();
  expect(errors).toEqual([]);
});
test('accesibilidad y móvil en el panel', async ({ page }) => {
  await page.goto(`/monitoreo/${f.accountId}`);
  await expect(page.getByRole('heading', { name: 'Monitoreo y seguimiento' })).toBeVisible();
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
    .analyze();
  expect(result.violations).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
test('viewer puede leer pero no configurar ni consultar operaciones', async ({ context, page }) => {
  await context.addCookies([
    {
      name: 'ad-astra.session_token',
      value: f.cookies[f.viewerId] ?? '',
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  await page.goto(`/monitoreo/${f.accountId}`);
  await expect(page.getByRole('heading', { name: 'Monitoreo y seguimiento' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Evaluar ahora' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Estado técnico' })).toHaveCount(0);
  expect(
    (
      await context.request.get('/v1/operations', { headers: { 'x-tenant-id': f.tenantId } })
    ).status(),
  ).toBe(403);
});
