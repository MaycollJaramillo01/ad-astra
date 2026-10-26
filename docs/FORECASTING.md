# Pronóstico y simulación presupuestaria (F6)

> Versión 1.0 · 2026-10-26 · Motores `forecast-1.0.0` y `simulate-1.0.0` · Código en `src/modules/forecasting/` · Decisión en [ADR-025](DECISIONS.md#adr-025--pronóstico-y-simulación-modelos-simples-validados-calculados-al-pedirlos) · Experimentos reproducibles con `pnpm forecast:experiments` (§8).

Esta capa estima **rangos probables** de gasto, resultados (impresiones, clics, visitas, clientes potenciales, conversaciones, compras, instalaciones) y costos para dos preguntas:

1. **Si nada cambia**, ¿qué cabe esperar en los próximos 7 a 56 días? (pronóstico, §4)
2. **Si cambio el gasto diario** de estas campañas, ¿qué rango de resultados y de costo por resultado es compatible con lo observado? (escenarios, §5)

Todo rango es un **intervalo del 80 %** validado con datos pasados y se presenta como **estimación, no garantía**. Lo que no supera su validación no se muestra y se dice por qué. Ninguna cifra se presenta como efecto causal (§6).

## 1. Alcance

| Responde | No responde |
|---|---|
| Rango de gasto y de resultados de una cuenta o campaña si se mantiene su comportamiento reciente | Por qué ocurren los resultados (causalidad) |
| Rango de eventos y de costo por evento con otro gasto diario por campaña, cerca del gasto observado | El efecto de cambiar creatividades, segmentación, objetivo o puja |
| Cambio esperado de eventos frente a mantener el gasto actual, con su incertidumbre | El efecto de promociones, festivos o cambios de presupuesto futuros |
| Qué historia hace falta para responder y cuánta falta | Interacciones entre campañas (canibalización, efectos retardados) |

## 2. Datos

### 2.1 Fuente y alcance

Filas diarias de `insights_daily` (ADR-009) del nivel de cuenta o de campaña, en el día local y la moneda de la cuenta, con RLS y el alcance por cliente del usuario. Se leen hasta 400 días antes del último día observado (`asOf`, por defecto ayer en la zona de la cuenta). Un día sin fila es un día sin entrega (0).

### 2.2 Datos disponibles hoy

| Fuente | Historia | Resultado |
|---|---|---|
| BD de desarrollo | Sin filas de Insights | — |
| Spike real (F0, `spike-output/`, fuera del repositorio) | 27 días de 1 cuenta | **Datos insuficientes**: faltan 172 días para un horizonte de 28 (E5, §8) |

Con la historia real disponible el sistema **no publica ningún pronóstico ni escenario**, y es lo correcto. Por eso la validación cuantitativa (§8) usa datos **sintéticos de parámetros conocidos** (`test/forecast-fixtures.ts`): solo con ellos se puede comprobar que un método recupera la verdad y que sus intervalos cubren lo que dicen. Con datos reales, la publicación depende del backtest de cada serie (§4.6).

### 2.3 Criterios mínimos

| Resultado | Criterio mínimo | Por qué |
|---|---|---|
| Pronóstico diario de una serie | n ≥ 56 + g + H + 7·(J − 1) días utilizables, con J = 6 + ⌈(g + H)/7⌉ + 6 orígenes semanales: **157, 171, 199 y 255 días** para H = 7, 14, 28 y 56 (g = 3) | 56 días de entrenamiento; 6 orígenes para calibrar, ⌈(g + H)/7⌉ de espera hasta que su resultado se observa y 6 para evaluar la cobertura (§4.4) |
| Serie de conteo | ≥ 0,5 eventos al día en los últimos 56 días | Con menos, una serie diaria es casi todo ceros y su pronóstico diario no es informativo |
| Costo derivado (CPM, CPL…) | Gasto y evento publicados y ≥ 6 orígenes con intervalo evaluable | El costo es un cociente de dos pronósticos |
| Curva de respuesta de una campaña | ≥ 8 semanas con gasto y ≥ 10 eventos | Dos parámetros y su sobredispersión |
| Escenario publicado | ≥ 18 semanas con gasto (8 para ajustar + 10 de validación de un paso) | Medir la cobertura de lo que se publica |
| Cadenas de Markov | ≥ 6 meses y ≥ 100 entidades, y superar a Kaplan-Meier | ARCHITECTURE §6.10; no se cumple (§3) |

### 2.4 Tratamiento de la historia

| Situación | Tratamiento |
|---|---|
| **Cambio de atribución** (`attribution_setting` distinto del anterior) | La historia empieza ese día: antes y después las conversiones no son comparables. Se muestra el corte |
| **Pausa** (≥ 7 días seguidos sin gasto) | La historia empieza al reanudar; si la pausa llega hasta hoy, el estado es "En pausa" (pronóstico 0) |
| **Huecos cortos** (< 7 días sin entrega) | Cuentan como 0: son parte del comportamiento |
| **Maduración de conversiones** | El ajuste usa hasta `asOf − g`, con g = `maturityDays` de la configuración de auditoría del cliente (3 por defecto). El backtest deja el mismo hueco entre el entrenamiento y lo que puntúa, así que mide exactamente el pronóstico que se publica. En el gráfico, esos días se sombrean "en maduración" |
| **Estacionalidad** | Semanal (los modelos la estiman). La anual, los festivos y los días de pago no se modelan: harían falta 2 años o más de historia por campaña |
| **Eventos externos** (promociones, caídas del seguimiento, festivos) | La persona marca rangos de fechas: no se ajustan ni se puntúan. Un evento **futuro** no se modela y el intervalo no lo cubre |
| **Picos aislados** | z robusta (mediana y MAD de los 28 días previos, Iglewicz-Hoaglin) ≥ 5 y los dos días siguientes con dato de vuelta a \|z\| < 3: se acota a mediana ± 5 MAD/0,6745 para ajustar, pero se puntúa con el valor real. Un cambio sostenido no es aislado y no se toca |
| **Cambio de régimen** (p. ej., duplicar el presupuesto) | Los modelos se adaptan, pero la calibración lo detecta: la cobertura cae y la serie deja de publicarse hasta recalibrarse (E1-S3) |
| **Reexpresión de Meta** (últimos 28 días) | Los datos recientes aún pueden cambiar un poco: limitación declarada |
| **Monedas** | Cada cuenta en la suya; no se suman cuentas (ADR-020) |

## 3. Técnicas evaluadas

| Técnica | Uso | Decisión |
|---|---|---|
| Ingenuo estacional (semanal) | Referencia obligatoria | **Usada**: todo modelo debe superarla en el backtest |
| Perfil semanal: nivel de 28 días × factor del día de la semana | Candidato (equivale a una regresión con efectos de día de la semana sobre el nivel reciente) | **Usada** |
| Holt-Winters amortiguado, ETS(A,Ad,A) | Candidato con tendencia | **Usada**. El spike de ADR-018 queda resuelto: rejilla de 140 combinaciones en TypeScript, ~20 ms por serie y backtest completo; no hace falta un worker de Python |
| ARIMA/SARIMA, Prophet | — | **Descartadas**: dependencia nueva o maquinaria de ajuste sin mejora esperada sobre ETS con estacionalidad semanal y pocos meses de datos. Se reevalúan si ETS no supera al baseline con datos reales |
| Regresión log-log `eventos = e^a · gasto^b` | Curva de respuesta de los escenarios | **Usada, en forma bayesiana** (§5): con poca variación del gasto, b no se identifica sin un a priori |
| Gamma-Poisson y Beta-Binomial | Costos y tasas con muestras pequeñas | Ya en F3 (auditoría y salud). Aquí la sobredispersión se modela con Gamma-Poisson (binomial negativa) |
| Bayesiano jerárquico (agrupar campañas) | — | **No**: aportaría con muchas campañas del mismo perfil y poca variación de gasto; queda como trabajo futuro (§10) |
| Monte Carlo | Escenarios: incertidumbre de parámetros + ruido de conteo | **Usado** (§5.5). El pronóstico no lo necesita: sus intervalos son empíricos |
| Cadenas de Markov / Kaplan-Meier | Vida útil creativa (aprendizaje → estable → fatigada) | **No aplicadas**: no se cumplen los criterios (6 meses y 100 entidades de historia propia) y no intervienen en el presupuesto |
| CUSUM | Cambios de nivel | **No implementado**: R-CHG-014 cubre los cambios bruscos y la calibración bloquea la publicación tras un cambio de régimen (§2.4) |

## 4. Pronóstico "si nada cambia"

### 4.1 Modelos

Notación: y₀ … y_{T−1} es la historia utilizable hasta el corte; ŷ(T+h) el pronóstico a h días.

```
Ingenuo estacional   ŷ(T+h) = y(T+h − 7·⌈h/7⌉)          (si falta ese día, la semana anterior)

Perfil semanal       ŷ(T+h) = ȳ₂₈ · f[(T+h) mod 7]
                     f[d] = media de y en el día d ÷ media de y, ambas en los últimos 56 días

ETS(A,Ad,A)          ŷ(t) = ℓ + φ·b + s[t mod 7]          e = y(t) − ŷ(t)
                     ℓ ← ℓ + φ·b + α·e      b ← φ·b + β·e      s[t mod 7] ← s[t mod 7] + γ·e
                     ŷ(T+h) = ℓ_T + (φ + φ² + … + φ^h)·b_T + s[(T+h) mod 7]
```

ETS en forma de corrección de errores (Hyndman y Athanasopoulos, *FPP3* §8.3), con estado inicial de las dos primeras semanas (nivel, pendiente entre semanas y desviación de cada día respecto a su semana, sin la pendiente). Parámetros en la rejilla α ∈ {0,03; 0,07; 0,15; 0,3; 0,5}, β = α·β\* con β\* ∈ {0; 0,05; 0,2}, γ ∈ {0,02; 0,07; 0,15; 0,3} con γ < 1 − α y φ ∈ {0,85; 0,92; 0,98}, eligiendo el mínimo de Σe² de un paso desde el día 21. Un día excluido avanza el estado sin corrección (e = 0). Los pronósticos negativos se truncan a 0.

### 4.2 Backtest de origen móvil

Orígenes semanales T_k = n − g − H − 7k (k = 0 … 29, T_k ≥ 56). En cada uno se entrena con y₀ … y_{T−1}, se pronostican g + H días y se puntúan los H últimos (el hueco g es la maduración). Métricas por modelo, sobre los mismos puntos:

```
MAE                = Σ|y − ŷ| / N
MASE               = media_k [ MAE_k / ( Σ_{t≥7} |y_t − y_{t−7}| / (T_k − 7) ) ]      (Hyndman y Koehler, 2006)
MAE relativo       = Σ|y − ŷ_modelo| / Σ|y − ŷ_ingenuo estacional|
Error del total    = Σ_k |ΣA_k − ΣP_k| / Σ_k ΣA_k          Sesgo del total = Σ_k (ΣP_k − ΣA_k) / Σ_k ΣA_k
```

**Criterio de publicación CA-F6-01: MAE relativo < 1.** El MASE se informa, pero escala con el error del ingenuo **de un paso dentro de la muestra**; a 28 días, un modelo puede superar al ingenuo estacional fuera de muestra y aun así tener MASE > 1. Ocurre en E1-S2 (tendencia): MASE 1,04 con MAE relativo 0,77. Comparar con el ingenuo en los mismos orígenes y horizontes es la lectura estricta de "superar al baseline".

**Elección del modelo:** el candidato (perfil semanal o ETS) con menor MAE relativo. Se elige y se evalúa con el mismo backtest: con dos candidatos el sesgo de selección es leve y se acepta (con más candidatos, habría que separar orígenes de selección y de evaluación).

### 4.3 Intervalos: predicción conforme en el tiempo

Los errores se normalizan por el nivel del origen, u = (y − ŷ)/ℓ_k con ℓ_k la media de los 28 días previos, para que valgan con niveles distintos, y se agrupan por semana del horizonte (el error crece con h). El intervalo de un día es

```
[ ŷ + q_inf(u) · ℓ ,  ŷ + q_sup(u) · ℓ ]          (truncado a 0)
p_sup = min(1, 0,9 · (m + 1)/m)      p_inf = 1 − p_sup
```

con m errores y la **corrección de muestra finita** de la predicción conforme (Vovk et al., 2005; Lei et al., 2018). Sin ella, con 6 a 20 orígenes, el total del horizonte cubría entre el 45 % y el 80 % en la exploración inicial; con ella, 76–80 % en el backtest (E1). El total del horizonte usa el error normalizado del total, v = (ΣA − ΣP)/(ℓ·m).

### 4.4 Calibración sin mirar el futuro

La cobertura se mide en orígenes posteriores a los que calibran: el intervalo del origen k usa solo los orígenes j cuyo horizonte ya se había observado, T_j + g + H ≤ T_k. Se informa la cobertura diaria y la del total. El intervalo que se publica usa todos los orígenes.

### 4.5 Costos derivados

CPM, CPC y costo por evento son cocientes de dos series publicadas. Su error es el del log-cociente, r = ln(ΣA_gasto/ΣA_evento) − ln(ΣP_gasto/ΣP_evento), calibrado igual que §4.4; el intervalo es cociente central · e^{q(r)}.

### 4.6 Criterios de publicación

| Estado | Condición |
|---|---|
| `insufficient_data` | No se cumple §2.3; dice cuántos días faltan |
| `paused` | ≥ 7 días sin gasto hasta hoy |
| `not_published` | MAE relativo ≥ 1 (CA-F6-01), o cobertura diaria del 80 % fuera de [70 %, 90 %] (CA-F6-02, literal: cientos de puntos) |
| `published` | Todo lo anterior se cumple |

Para los costos derivados y la validación de los escenarios, que se evalúan con 6 a 30 orígenes o semanas, el rango aceptable es [70 %, 90 %] **ampliado en un error típico binomial** √(0,8 · 0,2 / n). Con n = 18, un modelo perfectamente calibrado caería fuera de [70 %, 90 %] el 23 % de las veces por puro azar (P(X ≤ 12) + P(X ≥ 17) con X ~ Bin(18; 0,8)); con la tolerancia, el 3 %. Lo detectó la prueba con datos demo: una curva correcta se rechazaba con 17 de 18 semanas cubiertas.

## 5. Escenarios de presupuesto

### 5.1 Datos

Por campaña, bloques de 7 días que terminan en el corte (hasta 26 semanas, tras el último cambio de atribución o pausa), sin las semanas sin gasto ni las que tocan un evento excluido. El evento es el del perfil de la campaña (`kpiOf`, ARCHITECTURE §6.5): clientes potenciales, compras, conversaciones, instalaciones, visitas o clics, impresiones o resultados. Trabajar por semanas quita la estacionalidad semanal y reduce los ceros.

### 5.2 Modelo

```
Y_w ~ Poisson sobredispersa:   E[Y_w] = μ_w,   Var[Y_w] = φ·μ_w
log μ_w = a + b · (ln S_w − x̄)                (S_w: gasto semanal; x̄: media de ln S)
a ~ N(ln(ȳ + 0,5), 10²)                        (casi plano)
b ~ N(0,7; 0,25²)                              (elasticidad: +1 % de gasto ↔ +b % de eventos)
```

La elasticidad b < 1 expresa rendimientos decrecientes. El **a priori** de b es débil (95 % entre 0,21 y 1,19) e incluye el costo constante (b = 1) a 1,2 desviaciones: no es un benchmark de rendimiento sino un supuesto de forma, visible en la ficha. Hace falta porque el gasto real suele variar poco: sin a priori, b no se identifica y una regresión daría cualquier valor. Con variación suficiente, los datos lo dominan (E3).

### 5.3 Ajuste (aproximación de Laplace)

Log-posterior con la verosimilitud de cuasi-Poisson escalada por φ:

```
ℓ(a, b) = Σ_w [ Y_w·η_w − e^{η_w} ] / φ − (a − m_a)²/(2·10²) − (b − 0,7)²/(2·0,25²),     η_w = a + b·(ln S_w − x̄)
```

Modo por Newton con búsqueda de paso; covarianza a posteriori = (−∇²ℓ)⁻¹ en el modo. φ = max(1, χ²_Pearson/(n − 2)) del ajuste con φ = 1, y se reajusta con ese φ. **Aprendido de los datos** = 1 − Var(b | datos) / 0,25²: cerca de 0, b lo decide el a priori; cerca de 1, los datos.

### 5.4 Validación de un paso

Para cada semana w ≥ 8: se ajusta con las semanas anteriores y se predice Y_w dado su gasto S_w con 2.000 extracciones (§5.5). Se registra el **PIT aleatorizado** u = P(Y < y) + U·P(Y = y), con U uniforme (Czado, Gneiting y Held, 2009), que es uniforme si el modelo está calibrado aunque Y sea discreta; la cobertura es la fracción de semanas con u ∈ [0,1; 0,9]. También se compara el MAE con el de "costo constante" (gasto de la semana × eventos/gasto de las 4 anteriores). Publicación: ≥ 10 semanas evaluadas y cobertura en el rango de §4.6 con la tolerancia binomial.

### 5.5 Monte Carlo

Para i = 1 … 10.000, con semilla:

```
(a, b)ᵢ ~ N(θ̂, Σ)                                  (Cholesky 2 × 2)
μᵢ = (H/7) · exp(aᵢ + bᵢ·(ln(7·d) − x̄))          (d: gasto diario del plan)
λᵢ ~ Gamma(forma μᵢ/(φ − 1), escala φ − 1);   Yᵢ ~ Poisson(λᵢ)      (binomial negativa: media μ, varianza φ·μ)
```

Se publican P10, P50 y P90 de Y; el costo por evento es gasto/Y y, como es monótono, su P10 sale del P90 de Y (con Y = 0 el costo no tiene cota y se informa P(0 eventos)). El **cambio esperado** frente a mantener el gasto actual usa los mismos (a, b)ᵢ en los dos planes (números aleatorios comunes): μᵢ(plan) − μᵢ(actual) solo refleja la incertidumbre de los parámetros. Los totales por tipo de evento suman las extracciones de las campañas como independientes. Muestreadores propios y deterministas: mulberry32, Box-Muller, Gamma de Marsaglia y Tsang (2000) y Poisson de Knuth (λ < 30) o normal con corrección de continuidad (λ ≥ 30).

### 5.6 Marcas de fiabilidad

| Marca | Condición | Evidencia |
|---|---|---|
| **Extrapolación** | Gasto semanal del plan fuera del rango semanal observado [mín, máx] | El diseño inicial (ARCHITECTURE §6.10) toleraba ±50 % sobre el rango; E4 mostró que con +100 % de gasto solo se marcaba el 2 % de los escenarios mientras la cobertura real caía al 50–67 % |
| **Cambio grande** | Gasto diario del plan a más de ±30 % del actual | Hasta +30 % la cobertura real fue 65–75 %; con ±50 % o más, 28–85 % según la forma real de la respuesta (E4) |

## 6. Hipótesis y limitaciones

**Hipótesis del pronóstico:** presupuestos, segmentación, creatividades y entrega de Meta siguen como en la historia reciente; solo hay estacionalidad semanal; los errores pasados representan los futuros (intercambiabilidad aproximada de los orígenes).

**Hipótesis de los escenarios:** Meta entrega el gasto planificado; la forma `eventos ∝ gasto^b` vale cerca del gasto observado; las campañas son independientes y sin efectos retardados; un cambio de presupuesto no reinicia la fase de aprendizaje; pausar da 0 eventos.

**Limitaciones:**

- **Correlación, no causalidad.** El gasto histórico no se asignó al azar: lo deciden el anunciante (que sube el presupuesto de lo que funciona) y la entrega de Meta. La elasticidad b mezcla el efecto del presupuesto con esas decisiones (endogeneidad). Solo un experimento (prueba de conversión incremental de Meta, *holdout* geográfico o de presupuesto) estimaría el efecto causal.
- **Forma de la curva.** Si la respuesta real satura antes que una potencia, los escenarios lejos del gasto actual sobrestiman los eventos y el intervalo se queda corto (E4: 28 % de cobertura con +300 %). La validación de un paso **no** lo detecta, porque solo prueba cerca del gasto observado.
- **Dependencia temporal.** Los orígenes del backtest se solapan (H > 7 días): sus errores están correlacionados y la cobertura medida tiene más varianza de la que sugiere el número de orígenes.
- **Totales conservadores.** En series estables, el intervalo del total cubrió más de lo nominal en el horizonte oculto (hasta 97–98 %): es más ancho de lo necesario.
- **Eventos y competencia.** Festivos, promociones, cambios de la subasta y de la competencia no están en los modelos.
- **Reexpresión y atribución.** Meta reexpresa 28 días; las ventanas de atribución definen qué es una conversión.
- **Independencia entre campañas.** Si se mueven juntas (misma audiencia, misma estacionalidad), el rango real del total es más ancho.

## 7. Reproducibilidad y contrato

- `POST /v1/forecasts` `{level: account | campaign, id, horizonDays 7–56, asOf?, exclude[]}` y `POST /v1/simulations` `{adAccountId, horizonDays 7–91, asOf?, exclude[], changes[{campaignId, dailySpend}], seed}`. Ambos de solo lectura (permiso `insights:read`, RLS y alcance por cliente) y con POST porque llevan cuerpo.
- Cada respuesta lleva la versión del motor, los criterios, los supuestos y limitaciones, y `inputHash` = SHA-256 del JSON canónico de versión, petición (con `asOf` resuelto), hueco y filas leídas. Mismas entradas y semilla → misma respuesta (test).
- Sin tablas `forecasts`, `forecast_backtests` ni `simulations`: se calcula al pedirlo (≈ 20 ms por serie y unos cientos de ms por escenario). Se añadirán para guardar escenarios o para medir, frente a lo ocurrido, el error de los pronósticos ya publicados.

## 8. Experimentos

Ejecución del 2026-10-26 con `pnpm forecast:experiments` (≈ 20 s; semillas fijas; R = 40 por defecto, variables `REPS` y `REPS_MC`). Datos sintéticos de parámetros conocidos (`test/forecast-fixtures.ts`): gasto con estacionalidad semanal (factores 1,15 · 1,10 · 1,00 · 0,95 · 0,90 · 0,85 · 1,05), ruido log-normal (σ = 0,15), impresiones ~ Poisson(100 · gasto), clics ~ Poisson(1 % de las impresiones) y leads ~ Poisson(k · gasto^0,8).

### E1. Pronóstico: habilidad y calibración

300 días, H = 28, g = 3, 40 semillas. "Horizonte oculto": 31 días más que el modelo nunca ve; se comprueba si el total real cae en el intervalo publicado.

| Escenario | Serie | Publicado | Modelo más elegido | MAE rel. (mediana) | MASE (mediana) | Cobertura diaria (backtest) | Cobertura del total (backtest) | Cobertura del total en horizonte oculto |
|---|---|---|---|---|---|---|---|---|
| S1 Estable | Gasto | 98 % | ETS (22/40) | 0,75 | 0,77 | 81 % | 79 % | 97 % (n = 39) |
| S1 Estable | Leads | 100 % | ETS (30/40) | 0,74 | 0,73 | 81 % | 78 % | 98 % (n = 40) |
| S1 Estable | Costo por lead | 85 % | — | — | — | — | 79 % | 79 % (n = 34) |
| S2 Tendencia | Gasto | 100 % | ETS (39/40) | 0,77 | 1,04 | 81 % | 80 % | 90 % (n = 40) |
| S2 Tendencia | Leads | 98 % | ETS (26/40) | 0,77 | 0,90 | 84 % | 79 % | 85 % (n = 39) |
| S2 Tendencia | Costo por lead | 78 % | — | — | — | — | 85 % | 84 % (n = 31) |
| S3 Gasto × 2 el día 200 | Gasto | 13 % | ETS (31/40) | 0,88 | 1,45 | 67 % | 53 % | 80 % (n = 5) |
| S3 Gasto × 2 el día 200 | Leads | 85 % | ETS (32/40) | 0,82 | 1,03 | 73 % | 60 % | 82 % (n = 34) |
| S3 Gasto × 2 el día 200 | Costo por lead | 10 % | — | — | — | — | 79 % | 75 % (n = 4) |
| S4 Sin estacionalidad | Gasto | 100 % | ETS (30/40) | 0,74 | 0,77 | 80 % | 79 % | 93 % (n = 40) |
| S4 Sin estacionalidad | Leads | 98 % | ETS (28/40) | 0,75 | 0,75 | 81 % | 80 % | 82 % (n = 39) |
| S4 Sin estacionalidad | Costo por lead | 83 % | — | — | — | — | 78 % | 85 % (n = 33) |
| S5 Volumen bajo (≈ 1 lead/día) | Gasto | 100 % | ETS (28/40) | 0,75 | 0,74 | 81 % | 76 % | 80 % (n = 40) |
| S5 Volumen bajo | Leads | 95 % | ETS (29/40) | 0,81 | 0,80 | 81 % | 77 % | 84 % (n = 38) |
| S5 Volumen bajo | Costo por lead | 78 % | — | — | — | — | 78 % | 77 % (n = 31) |

**Lectura.** Los modelos superan al ingenuo estacional en 12–26 % de MAE y los intervalos diarios están calibrados (80–84 %) salvo tras un cambio de régimen (S3), donde la cobertura cae al 67 % y el gasto solo se publica en el 13 % de las semillas: el sistema se abstiene en lugar de dar un rango engañoso. Los intervalos del total cubren 76–80 % en el backtest y 80–98 % en el horizonte oculto: en series estables son conservadores. El costo por lead se publica en 78–85 % de las series y cubre 77–85 % fuera de muestra.

### E2. Criterios mínimos de datos

Días exigidos: H = 7 → 157 · 14 → 171 · 28 → 199 · 56 → 255. Con S1 y H = 28: 30, 90, 150 y 198 días → `insufficient_data` con los días que faltan (169, 109, 49 y 1); 199, 240 y 365 → publicado. Un cambio de atribución el día 250 de 300 deja 50 días utilizables; una pausa de 10 días, 190.

### E3. Curva de respuesta: recuperación de la elasticidad

26 semanas, 200 réplicas por celda, sobredispersión real (λ con ruido log-normal de cv ≈ 0,15).

| b real | Variación del gasto (sd de ln) | Media a posteriori de b | Cobertura del intervalo creíble del 80 % | Aprendido de los datos |
|---|---|---|---|---|
| 0,5 | 0,35 | 0,57 | 81 % | 73 % |
| 0,8 | 0,35 | 0,79 | 79 % | 87 % |
| 1,0 | 0,35 | 0,97 | 78 % | 88 % |
| 0,5 | 0,10 | 0,67 | 90 % | 19 % |
| 0,8 | 0,10 | 0,74 | 95 % | 37 % |
| 1,0 | 0,10 | 0,84 | 75 % | 41 % |
| 0,5 | 0,01 | 0,70 | 100 % | 0 % |
| 0,8 | 0,01 | 0,70 | 100 % | 1 % |
| 1,0 | 0,01 | 0,71 | 89 % | 1 % |

**Lectura.** Con variación real del gasto (±35 %), b se recupera y el intervalo creíble está calibrado. Con poca variación, b vuelve al a priori y la ficha lo dice ("aprendido" bajo): la cifra es un supuesto, no una medida.

### E4. Validación de un paso y cobertura real de los escenarios

60 réplicas por celda. Dos respuestas reales: la forma del modelo (potencia, b = 0,8) y una saturación de Michaelis-Menten con la misma media y elasticidad local 0,5 en el gasto típico.

| Respuesta real | Cobertura PIT de la validación (nominal 80 %) | MAE ÷ costo constante (mediana) | Publicable |
|---|---|---|---|
| Potencia (forma correcta) | 77 % | 0,89 | 93 % |
| Saturación (forma incorrecta) | 78 % | 0,69 | 93 % |

| Respuesta real | Cambio del gasto diario | Eventos reales de 4 semanas dentro de P10–P90 | Extrapolación | Cambio grande |
|---|---|---|---|---|
| Potencia | −50 % | 85 % | 50 % | 100 % |
| Potencia | 0 % | 75 % | 0 % | 0 % |
| Potencia | +30 % | 72 % | 0 % | 0 % |
| Potencia | +100 % | 67 % | 58 % | 100 % |
| Potencia | +300 % | 62 % | 100 % | 100 % |
| Saturación | −50 % | 80 % | 50 % | 100 % |
| Saturación | 0 % | 72 % | 0 % | 0 % |
| Saturación | +30 % | 65 % | 0 % | 0 % |
| Saturación | +100 % | 50 % | 58 % | 100 % |
| Saturación | +300 % | 28 % | 100 % | 100 % |

**Lectura.** La validación de un paso está calibrada y la curva supera al costo constante (11–31 % menos error), pero **no puede detectar** una forma equivocada lejos del gasto observado: con saturación, la cobertura real cae al 50 % con +100 % y al 28 % con +300 %. De ahí las marcas de §5.6: todo escenario con cobertura real por debajo del 65 % queda marcado. Incluso con la forma correcta, la cobertura baja con cambios grandes (el a priori y la aproximación normal pesan más al extrapolar).

### E5. Datos reales

27 filas diarias de 1 cuenta (spike de F0), historia utilizable de 27 días sin cortes. Gasto: `insufficient_data`, faltan 172 días para H = 28. No se imprime ningún valor de la cuenta.

### Prueba en el navegador

Datos sintéticos "Demo" (3 campañas: dos de 300 días con variación semanal del gasto y una de 45 días) cargados en la BD de desarrollo y borrados después. Las respuestas reales de la API, obtenidas con el arnés de tests, se mostraron en la SPA: gráfico de abanico con días en maduración, ficha del modelo, totales y costos, simulador con +30 %/−50 % (cambio esperado de +81 y −41 leads con su rango) y +200 % marcado como extrapolación; elasticidad estimada 0,75 (la real de los datos era 0,75); móvil sin desbordamiento.

## 9. Pruebas automatizadas

| Archivo | Tests | Qué cubre |
|---|---|---|
| `src/modules/forecasting/forecast.test.ts` | 13 | Modelos con series sin ruido; corrección de muestra finita; cortes por atribución y pausa; exclusiones; picos aislados frente a cambios sostenidos; días exigidos y motivo; publicación con MAE relativo < 1 y cobertura en rango (CA-F6-01 y 02); calibración media en 12 semillas; sin fuga de futuro; volumen bajo; costos derivados; tolerancia binomial |
| `src/modules/forecasting/simulate.test.ts` | 8 | Momentos de los muestreadores; recuperación de b con cobertura del intervalo creíble (CA-F6-04); vuelta al a priori sin variación; mínimos; calibración de la validación de un paso; determinismo con semilla; rendimientos decrecientes, pausa, extrapolación y cambio grande; totales por tipo de evento |
| `test/forecasting.test.ts` | 6 | API de punta a punta contra Postgres: publicación con ficha y huella reproducible, datos insuficientes, exclusiones y validación del cuerpo, aislamiento entre organizaciones y lectura por cualquier rol, escenarios con y sin cambio, semilla reproducible y campañas ajenas rechazadas |

## 10. Trabajo futuro

- Guardar los pronósticos publicados y medir su error real a medida que llegan los datos (la mejor prueba de calibración con datos reales).
- Herramienta de solo lectura para que el asistente de IA cite pronósticos y escenarios con su evidencia.
- Efectos de festivos y eventos recurrentes cuando haya 1–2 años de historia.
- Curvas jerárquicas (agrupar campañas del mismo perfil) para las campañas con poca variación de gasto.
- Prueba de Diebold-Mariano para saber si el MAE relativo < 1 es significativo.
- CUSUM de cambios de nivel para cortar la historia tras un cambio de régimen.
- Experimentos de presupuesto (incrementalidad) para pasar de relación observada a efecto causal.

## Referencias

- Hyndman, R. J. y Athanasopoulos, G. (2021). *Forecasting: Principles and Practice*, 3.ª ed. (§5.10 validación cruzada de series, §8 ETS).
- Hyndman, R. J. y Koehler, A. B. (2006). Another look at measures of forecast accuracy. *International Journal of Forecasting* 22(4).
- Vovk, V., Gammerman, A. y Shafer, G. (2005). *Algorithmic Learning in a Random World*. Springer.
- Lei, J., G'Sell, M., Rinaldo, A., Tibshirani, R. y Wasserman, L. (2018). Distribution-free predictive inference for regression. *JASA* 113(523).
- Czado, C., Gneiting, T. y Held, L. (2009). Predictive model assessment for count data. *Biometrics* 65(4).
- Marsaglia, G. y Tsang, W. W. (2000). A simple method for generating gamma variables. *ACM TOMS* 26(3).
- Iglewicz, B. y Hoaglin, D. (1993). *How to Detect and Handle Outliers*. ASQC.
