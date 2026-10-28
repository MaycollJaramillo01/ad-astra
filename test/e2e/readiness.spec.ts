import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Finding } from '../../src/contracts.ts';

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
  const search = page.getByRole('searchbox', {
    name: 'Buscar clientes, cuentas o campañas',
    exact: true,
  });
  await expect(search).toBeFocused();
  await search.fill('Estado técnico');
  await expect(page.getByRole('status')).toHaveText('1 resultado disponible');
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await search.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Estado técnico Organización' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/operaciones$/);
  await expect(page.locator('#main-content')).toBeFocused();
  const trigger = page.getByRole('button', {
    name: 'Buscar clientes, cuentas o campañas',
    exact: true,
  });
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
  await page.getByRole('button', { name: 'Evaluar datos disponibles' }).click();
  expect((await evaluated).status()).toBe(200);
  await page.getByRole('button', { name: 'Incidentes', exact: true }).click();
  const incident = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: /conexión con Meta necesita atención/i }) });
  await expect(incident).toBeVisible();
  await incident.getByLabel('Decisión', { exact: true }).selectOption('snoozed');
  await incident
    .getByRole('textbox', { name: 'Motivo de la decisión' })
    .fill('Incidente sintético silenciado durante la prueba');
  const decided = page.waitForResponse((r) => r.url().endsWith('/decide'));
  await incident.getByRole('button', { name: 'Guardar decisión' }).click();
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

test('cartera y cuenta conservan contexto, orientan la resolución y funcionan en móvil', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Qué necesita atención' })).toBeVisible();
  await page.getByRole('link', { name: 'Cuenta browser-a', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cuenta browser-a', exact: true })).toBeVisible();
  await expect(page.getByLabel('Estado de los datos', { exact: true })).toContainText(
    'No podemos confirmar',
  );
  await page.getByLabel('Período de analítica de la cuenta').selectOption('last_30d');
  const tabs = page.getByRole('navigation', { name: 'Secciones de la cuenta' });
  await tabs.getByRole('link', { name: /^Problemas/ }).click();
  await expect(page).toHaveURL(/periodo=last_30d/);
  await expect(
    page.getByRole('heading', { name: /conexión con Meta necesita atención/i }),
  ).toBeVisible();
  const incident = page
    .locator('.incident-card')
    .filter({ has: page.getByRole('heading', { name: /conexión con Meta necesita atención/i }) });
  await expect(incident.getByRole('link', { name: 'Revisar datos y conexión' })).toHaveAttribute(
    'href',
    new RegExp(`/cuentas/${f.accountId}\\?periodo=last_30d&vista=ajustes`),
  );
  await incident.getByRole('link', { name: 'Revisar datos y conexión' }).click();
  await expect(page.getByRole('heading', { name: 'Datos y conexión', exact: true })).toBeVisible();
  await tabs.getByRole('link', { name: 'Historial', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Historial de la cuenta', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Decisión sobre un incidente', { exact: true }).first(),
  ).toBeVisible();
  await tabs.getByRole('link', { name: 'Campañas', exact: true }).click();
  await page.getByRole('link', { name: 'Campaña browser-a', exact: true }).click();
  await expect(page).toHaveURL(
    new RegExp(`cuentas/${f.accountId}.*vista=campanas.*entidad=${f.campaignId}`),
  );
  await expect(page.getByRole('heading', { name: 'Campaña browser-a', exact: true })).toBeVisible();
  await expect(page.getByLabel('Período de analítica de la cuenta')).toHaveValue('last_30d');
  await page.setViewportSize({ width: 390, height: 844 });
  await tabs.getByRole('link', { name: /^Problemas/ }).click();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'spike-output/readiness/account-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'spike-output/readiness/account-desktop.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('búsqueda encuentra cuentas y campañas y abre su espacio con teclado', async ({ page }) => {
  await page.goto('/cuentas');
  await expect(page.getByRole('heading', { name: 'Qué necesita atención' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  const search = page.getByRole('searchbox', { name: 'Buscar clientes, cuentas o campañas' });
  await search.fill('Cuenta browser-a');
  const account = page.getByRole('button', { name: /Cuenta browser-a Cuenta/ });
  await expect(account).toBeVisible();
  await search.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/cuentas/${f.accountId}`));
  await page.keyboard.press('ControlOrMeta+k');
  await search.fill('Campaña browser-a');
  await expect(page.getByRole('button', { name: /Campaña browser-a Campaña/ })).toBeVisible();
  await search.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`cuentas/${f.accountId}.*entidad=${f.campaignId}`));
});

test('una recomendación se convierte en propuesta conservando la cuenta y la aprobación humana', async ({
  page,
}) => {
  await page.goto(
    `/cuentas/${f.accountId}?periodo=last_30d&vista=acciones&entidad=${f.campaignId}&nivel=campaign`,
  );
  const rec = page
    .locator('form')
    .filter({ has: page.getByRole('button', { name: 'Aceptar recomendación', exact: true }) });
  await expect(rec).toBeVisible();
  await expect(rec).toContainText('Campaña browser-a');
  await rec
    .getByLabel('Motivo de la propuesta')
    .fill('Revisar gasto sin resultados con los datos sintéticos');
  await rec.getByRole('button', { name: 'Aceptar recomendación', exact: true }).click();
  await page.getByRole('button', { name: 'Crear propuesta', exact: true }).click();
  await expect(page.locator('.action-card')).toBeVisible();
  await expect(page.locator('.action-card')).toContainText('Campaña browser-a');
  await expect(
    page.locator('.action-card').getByRole('link', { name: 'Ver entidad', exact: true }),
  ).toHaveAttribute('href', new RegExp(`periodo=last_30d&vista=campanas&entidad=${f.campaignId}`));
  await expect(
    page
      .getByRole('list', { name: 'Progreso de la acción' })
      .getByRole('listitem')
      .filter({ hasText: 'Propuesta' }),
  ).toHaveAttribute('aria-current', 'step');
  await expect(page.getByRole('button', { name: 'Aprobar y autorizar', exact: true })).toHaveCount(
    0,
  );
  await expect(page).toHaveURL(new RegExp(`cuentas/${f.accountId}.*vista=acciones`));
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
  await expect(page.getByRole('button', { name: 'Evaluar datos disponibles' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Estado técnico' })).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');
  await page
    .getByRole('searchbox', { name: 'Buscar clientes, cuentas o campañas', exact: true })
    .fill('Estado técnico');
  await expect(page.getByRole('status')).toHaveText('0 resultados disponibles');
  await expect(page.getByRole('button', { name: 'Estado técnico Organización' })).toHaveCount(0);
  expect(
    (
      await context.request.get('/v1/operations', { headers: { 'x-tenant-id': f.tenantId } })
    ).status(),
  ).toBe(403);
  await page.keyboard.press('Escape');
  await page.goto(`/cuentas/${f.accountId}?vista=ajustes`);
  await expect(page.getByRole('heading', { name: 'Datos y conexión', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Guardar cliente', exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Activar sincronización|Desactivar sincronización/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Registrar autorización de lectura', exact: true }),
  ).toHaveCount(0);
});

test('la configuración de cuenta activa y desactiva sincronización con autorización vigente', async ({
  page,
}) => {
  await page.goto(`/cuentas/${f.accountId}?vista=ajustes`);
  await expect(page.getByRole('heading', { name: 'Datos y conexión', exact: true })).toBeVisible();
  const enabled = page.waitForResponse(
    (r) => r.url().endsWith(`/ad-accounts/${f.accountId}`) && r.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: 'Activar sincronización', exact: true }).click();
  expect((await enabled).status()).toBe(200);
  await expect(
    page.getByRole('button', { name: 'Desactivar sincronización', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Desactivar sincronización', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Activar sincronización', exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
});

test('asistente prioriza hallazgos y permite preparar preguntas con la IA en pausa', async ({
  page,
}) => {
  let submitted = 0;
  await page.route('**/v1/ai/ask', async (route) => {
    submitted++;
    await route.abort();
  });
  await page.route('**/v1/ai/status', (route) =>
    route.fulfill({
      json: {
        enabled: false,
        configured: true,
        provider: 'nvidia',
        model: 'nvidia/nemotron-3.5-super-vl-120b-a12b',
        effort: 'low',
        costBasis: 'budget_estimate',
        unavailableReason: 'Detalle técnico de solo lectura.',
        budgets: {
          monthlyUsd: 100,
          spentMonthUsd: 0,
          userDailyUsd: 10,
          spentTodayUsd: 0,
          perQuestionUsd: 1,
        },
      },
    }),
  );
  const row: Finding = {
    id: crypto.randomUUID(),
    adAccountId: f.accountId,
    kind: 'audit',
    ruleId: 'R-EFF-002',
    ruleVersion: 1,
    entityLevel: 'campaign',
    entityMetaId: f.campaignId,
    severity: 'high',
    confidence: '.94',
    priority: '.95',
    impact: null,
    evidence: null,
    recommendationKey: 'review',
    status: 'open',
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    decisionReason: null,
    category: 'efficiency',
    profile: 'leads',
    explanation:
      'La señal aparece en el periodo observado. Comprueba la medición antes de cambiar la inversión.',
    recommendationText:
      'Comprueba el gasto y los resultados de esta campaña antes de ajustar el presupuesto.',
    engineVersion: 'test',
    windowStart: '2026-10-14',
    windowEnd: '2026-10-20',
    resolvedAt: null,
  };
  await page.route('**/v1/findings?*', (route) =>
    route.fulfill({
      json: [
        row,
        { ...row, id: crypto.randomUUID(), priority: '.8' },
        {
          ...row,
          id: crypto.randomUUID(),
          ruleId: 'R-TRACK-001',
          priority: '.6',
          severity: 'medium',
          recommendationText:
            'Contrasta los eventos registrados con la fuente de leads antes de comparar.',
        },
      ],
    }),
  );
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto('/asistente');
  await expect(page.getByRole('heading', { name: 'Qué revisar primero' })).toBeVisible();
  await expect(page.getByText('Consultas en pausa', { exact: true })).toBeVisible();
  const topics = page.getByRole('list', { name: 'Temas por prioridad' }).locator(':scope > li');
  await expect(topics).toHaveCount(2);
  await expect(topics.first()).toContainText('2 señales agrupadas');
  await expect(topics.first()).toContainText(row.recommendationText as string);
  await expect(topics.first().getByRole('link', { name: 'Revisar evidencia' })).toHaveAttribute(
    'href',
    `/analitica/campana/${f.campaignId}`,
  );
  await expect(
    page.getByText('Detalle técnico de solo lectura.', { exact: false }),
  ).not.toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: 'spike-output/readiness/assistant-desktop.png', fullPage: true });
  await topics.first().getByRole('button', { name: 'Preparar consulta' }).click();
  const input = page.getByRole('textbox', { name: 'Pregunta para el asistente' });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(/Revisa los hallazgos/);
  await expect(page.getByRole('button', { name: 'Consultar', exact: true })).toBeDisabled();
  await input.press('ControlOrMeta+Enter');
  expect(submitted).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({ path: 'spike-output/readiness/assistant-mobile.png', fullPage: true });
});

test('asistente diferencia guía, ausencia de hallazgos y error de consulta', async ({ page }) => {
  await page.route('**/v1/findings?*', (route) => route.fulfill({ json: [] }));
  await page.goto('/asistente');
  await expect(
    page.getByText('Guía de revisión sugerida · no son problemas detectados'),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Medición y calidad de datos' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Gasto y costo por resultado' })).toBeVisible();
  await page.getByRole('button', { name: 'Resumen de rendimiento' }).click();
  await expect(page.getByRole('textbox', { name: 'Pregunta para el asistente' })).toHaveValue(
    /Resume el rendimiento/,
  );
  await page.route('**/v1/findings?*', (route) =>
    route.fulfill({ status: 503, json: { title: 'No disponible' } }),
  );
  await page.reload();
  await expect(page.getByText('No pudimos cargar las prioridades.', { exact: true })).toBeVisible();
  await expect(
    page.getByText('No hay hallazgos abiertos en esta selección.', { exact: true }),
  ).toHaveCount(0);
});
