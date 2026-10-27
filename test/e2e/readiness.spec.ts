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
  passwordLogin: { email: string; password: string };
};
let f: Fixture;
test.beforeAll(async () => {
  f = JSON.parse(await readFile('spike-output/readiness/browser.json', 'utf8'));
});

test('acceso con contraseña, cambio de clave y sesión renovada en navegador', async ({
  context,
  page,
}) => {
  await context.clearCookies();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Ad Astra', exact: true })).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByLabel('Correo', { exact: true }).fill(f.passwordLogin.email);
  await page.getByLabel('Contraseña', { exact: true }).fill(f.passwordLogin.password);
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await page.getByRole('link', { name: 'Mi cuenta', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Mi cuenta', exact: true })).toBeVisible();
  await page.getByLabel('Contraseña actual', { exact: true }).fill(f.passwordLogin.password);
  await page
    .getByLabel('Nueva contraseña', { exact: true })
    .fill('contraseña-solo-prueba-e2e-2026');
  await page
    .getByLabel('Confirmar contraseña', { exact: true })
    .fill('contraseña-solo-prueba-e2e-2026');
  await page.getByRole('button', { name: 'Cambiar contraseña', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Contraseña actualizada');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Mi cuenta', exact: true })).toBeVisible();
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
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('buscador de vistas por teclado y restauración del foco', async ({ page }) => {
  await page.goto('/analitica');
  await expect(page.getByRole('heading', { name: 'Resumen de cartera' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('searchbox', { name: 'Buscar una vista', exact: true });
  await expect(search).toBeFocused();
  await search.fill('Estado técnico');
  await expect(page.getByRole('status')).toHaveText('1 vista disponible');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await search.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Estado técnico Organización' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/operaciones$/);
  await expect(page.locator('#main-content')).toBeFocused();
  const trigger = page.getByRole('button', { name: 'Buscar una vista', exact: true });
  await trigger.click();
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('navegación móvil mantiene el foco y permite abrir una vista', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/analitica');
  const open = page.getByRole('button', { name: 'Abrir menú', exact: true });
  const close = page.getByRole('button', { name: 'Cerrar menú', exact: true });
  await open.click();
  await expect(close).toBeFocused();
  await expect(page.locator('.workspace-main')).toHaveAttribute('inert', '');
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Salir', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  await open.click();
  await page.getByRole('link', { name: 'Monitoreo', exact: true }).click();
  await expect(page).toHaveURL(/\/monitoreo$/);
  await expect(page.locator('#main-content')).toBeFocused();
  await expect(open).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('cartera sin cuentas ofrece pasos reales sin inventar indicadores', async ({ page }) => {
  // Simula únicamente la ausencia de cuentas en la respuesta local; no altera la BD.
  await page.route('**/v1/analytics?*', async (route) => {
    const response = await route.fetch();
    const report = await response.json();
    report.freshness.accounts = 0;
    await route.fulfill({ response, json: report });
  });
  await page.goto('/analitica');
  await expect(page.getByRole('heading', { name: 'Prepara tu espacio' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Conectar Meta', exact: true })).toHaveAttribute(
    'href',
    '/conexiones',
  );
  await expect(page.getByRole('region', { name: 'Indicadores clave' })).toHaveCount(0);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
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
  await page.keyboard.press('ControlOrMeta+k');
  await page
    .getByRole('searchbox', { name: 'Buscar una vista', exact: true })
    .fill('Estado técnico');
  await expect(page.getByRole('status')).toHaveText('0 vistas disponibles');
  await expect(page.getByRole('button', { name: 'Estado técnico Organización' })).toHaveCount(0);
  expect(
    (
      await context.request.get('/v1/operations', { headers: { 'x-tenant-id': f.tenantId } })
    ).status(),
  ).toBe(403);
});
