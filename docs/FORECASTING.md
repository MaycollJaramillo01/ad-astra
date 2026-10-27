# Pronóstico y simulación presupuestaria (F6)

La producción mantiene `FORECASTING_ENABLED=false` por defecto. Su activación exige evidencia real de completitud y cobertura, además de aceptación de los límites de los totales correlacionados. Ver [auditoría de preparación](PRODUCTION_READINESS_2026-10-26.md).

Versión 2.0, 2026-10-26. Motores `forecast-1.2.0` y `simulate-2.0.0`. Código en `src/modules/forecasting/`, interfaz en `/prevision`, decisiones de base en [ADR-025](DECISIONS.md#adr-025--pronóstico-y-simulación-modelos-simples-validados-calculados-al-pedirlos).

La capa responde a dos preguntas: qué rango es compatible con el comportamiento reciente si nada cambia y qué resultados son compatibles con un plan de gasto por campaña bajo supuestos explícitos. Calcula gasto, leads y los eventos de conversión disponibles en Meta (p. ej., compras), impresiones, clics y costos derivados. No transforma leads en ventas de CRM ni mezcla eventos, monedas o ventanas de atribución.

Los intervalos tienen **nivel nominal del 80 %**. La cobertura observada se informa por separado. Un intervalo publicado no garantiza cobertura futura ni demuestra causalidad. Los escenarios de gasto son condicionales a la entrega del plan y a la forma de respuesta asumida.

## 1. Alcance

- Previsión por cuenta o campaña: horizonte de 7 a 56 días, desde mañana en la zona local de la cuenta.
- Simulación: horizonte de 7 a 91 días, gasto diario configurable por campaña, P10/P50/P90 de eventos, costos y cambio esperado respecto al gasto actual. La web ofrece horizontes predeterminados.
- Fichas con datos, modelos, errores, cobertura, efectos de eventos, supuestos, motivos de abstención, semilla y huella de entradas.
- Diseño y análisis local de experimentos de presupuesto. Guardar un diseño **no cambia presupuestos en Meta**.

## 2. Datos

### 2.1 Fuente y alcance

`insights_daily`, nivel cuenta o campaña, moneda y fecha local de la cuenta. La API lee hasta 400 días anteriores a `asOf`; por defecto `asOf` es ayer. Rechaza fechas futuras. El ajuste termina en `cut = asOf − maturityDays`, 3 días por defecto según la configuración de auditoría del cliente. Mantiene RLS, roles y alcance por cliente.

El motor interpreta un día sin fila después del inicio como cero de entrega. **Es un supuesto de ingesta completa, no una observación de cero**. Antes de usar una cuenta debe verificarse el backfill y la sincronización; los huecos por fallos se marcan como incidencias. No existe todavía un registro diario de cobertura que permita distinguir automáticamente una ausencia de ingesta de una pausa. Una métrica nula en una fila existente conserva su estado desconocido: se excluye del ajuste y la puntuación y aparece nula en el gráfico. Las semanas con métricas desconocidas se excluyen de la curva; gasto reciente desconocido bloquea la simulación.

### 2.2 Datos disponibles

El historial real local del spike se evalúa en E5, sin imprimir importes ni identificadores. Con 27 días no alcanza los mínimos y el resultado es `insufficient_data`. No se usan fixtures sintéticas como evidencia de rendimiento de clientes. La validación real con varios meses continúa pendiente.

### 2.3 Criterios mínimos

| Salida | Mínimo y condición |
|---|---|
| Serie diaria | `56 + g + H + 7·(J−1)` días de calendario desde el último corte; `J = 6 + ceil((g+H)/7) + 6`. Con g=3: 157, 171, 199 y 255 días para H=7,14,28,56 |
| Días normales | Al menos 56 observaciones finitas sin evento y 28 en los últimos 56 días; excluye incidencias y días de evento del ajuste base |
| Conteos diarios | Media de al menos 0,5 eventos/día en los últimos 56 días |
| Validación del pronóstico | 6 orígenes iniciales para selección; al menos 6 orígenes posteriores evaluables, con resultados de selección ya observados |
| Curva por campaña | 8 semanas con gasto y 10 eventos para ajustar; al menos 18 semanas con gasto para publicar (8 ajuste + 10 validación temporal) |
| Costos | Gasto y evento publicados, denominador positivo y al menos 6 orígenes de calibración evaluables |
| Experimento | Al menos 6 periodos analizables, dos niveles y primera etapa F≥10; interpretación causal solo bajo los supuestos de §6 |
| Markov | Historias individuales de estados/transiciones, definiciones estables, ausencia de censura ignorada, volumen por transición y validación temporal frente a un baseline de supervivencia. No están disponibles |

Estos umbrales son reglas operativas conservadoras, no teoremas que aseguren identificación o potencia. Las cifras de días cuentan tiempo, no observaciones independientes.

### 2.4 Tratamiento de la historia

| Situación | Tratamiento |
|---|---|
| Cambio observado de atribución | Corta toda la historia en el último cambio; conversiones anteriores y posteriores no se mezclan. No reconstruye retrospectivamente cambios no registrados |
| Pausa de ≥7 días sin gasto | Corta al reanudar. Si llega al corte, informa `paused`; no publica una proyección de reactivación fiable |
| Maduración | Mismo hueco g en entrenamiento, backtest y predicción. Los últimos días se muestran como inmaduros |
| Incidencia | Excluye sus días del ajuste y de la evaluación. Una incidencia futura no es un efecto estimado |
| Pico aislado | z robusta ≥5 con los 28 días anteriores y dos observaciones posteriores de vuelta a |z|<3; se acota solo para ajustar, se puntúa contra lo real |
| Fuga en limpieza | La confirmación del pico se recalcula dentro de cada corte T. Nunca usa observaciones de su holdout |
| Cambio sostenido | No se acota como pico; puede bajar la cobertura y bloquear la publicación. No se promete detectar todo cambio |
| Reexpresión del proveedor | Meta puede revisar datos recientes; el backtest usa la última versión almacenada, no snapshots históricos de lo que se sabía entonces |
| Estacionalidad | Semanal. No se estima un ciclo anual libre con unos meses de datos |

### 2.5 Eventos externos

El calendario opcional combina festivos y fechas comerciales de Honduras y quincenas con eventos propios: promociones, festivos, fechas comerciales, pagos e incidencias. En la interfaz está desactivado inicialmente; el usuario decide si corresponde a su cuenta. Las fechas por decreto se añaden manualmente. Un evento anual se repite en las fechas indicadas; eso no demuestra que se repita su efecto.

Un solo evento por día, con prioridad para eventos propios y, entre ellos, incidencias, promociones, festivos, comerciales y pagos. Solapamientos no se suman. Los rangos propios abarcan como máximo 62 días, 20 eventos por petición. Para evaluar retrospectivamente solo se deben incluir eventos conocidos al emitir el pronóstico: el sistema no conserva todavía un historial de cuándo fueron registrados.

## 3. Técnicas evaluadas

| Técnica | Decisión y evidencia |
|---|---|
| Ingenuo estacional semanal | Baseline obligatorio del pronóstico; comparación en fechas y horizontes comunes |
| Perfil semanal | Regresión implícita de nivel reciente y factores por día; candidato simple y auditable |
| ETS(A,Ad,A) | Candidato de serie temporal con tendencia amortiguada y efectos semanales aditivos; rejilla ajustada dentro de cada entrenamiento |
| Regresión Poisson bayesiana | Curva de escenarios con curvatura, tendencia, eventos y gasto de otras campañas; regularización y Laplace para pocos datos |
| Costo constante | Baseline de escenarios: gasto objetivo × eventos/gasto de las cuatro semanas anteriores; se informa MAE relativo |
| Bayes jerárquico para eventos | Contracción aproximada categoría → evento → ocurrencia; muestra cuánto procede de historia o del a priori |
| Monte Carlo | 10.000 extracciones reproducibles de parámetros, confusión supuesta y choques semanales conjuntos; más ruido Poisson |
| ARIMA/SARIMA/Prophet | No implementados ni comparados numéricamente. Requieren evidencia de mejora sobre candidatos simples y una decisión de dependencias; no se afirma que rindan peor |
| Markov | No aplicado: solo existen agregados diarios, sin trayectorias de entidades ni transiciones identificables. Un umbral global de entidades por sí solo no bastaría |

## 4. Pronóstico si nada cambia

### 4.1 Modelos y entrenamiento

Sea y la serie diaria y T el número de observaciones hasta el corte.

```text
Ingenuo estacional: repite el último valor disponible del mismo día semanal.
Perfil semanal:     y_hat(T+h) = media_28 · factor_día
                    factor_día = media de ese día / media global, últimos 56 días.
ETS:                e_t = y_t − (l + phi·b + s_día)
                    l <- l + phi·b + alpha·e_t
                    b <- phi·b + beta·e_t
                    s_día <- s_día + gamma·e_t
                    y_hat(T+h) = l_T + (phi + ... + phi^h)·b_T + s_día.
```

ETS elige parámetros por error cuadrático dentro de su entrenamiento, con alpha∈{0,03;0,07;0,15;0,3;0,5}, beta=alpha·beta*, beta*∈{0;0,05;0,2}, gamma∈{0,02;0,07;0,15;0,3}, gamma<1−alpha y phi∈{0,85;0,92;0,98}. Los días excluidos avanzan el estado sin corrección. Las predicciones se truncan a cero.

### 4.2 Separación temporal y backtesting

Orígenes semanales `T_k`, máximo 30. En cada uno: reconstruir limpieza con observaciones `<T_k`, ajustar con ese pasado, pronosticar `g+H` días y puntuar los H últimos con sus valores reales. Nada de partición aleatoria.

1. Selección: los seis primeros orígenes eligen entre perfil semanal y ETS por MAE relativo.
2. Espera: no se evalúa ese modelo hasta que todos los resultados usados para elegirlo ya se han observado (`T_eval ≥ T_último_selección + g + H`).
3. Evaluación: se congela la familia elegida; se informa el error sobre orígenes posteriores. No se escoge otra familia al ver ese error.
4. Calibración prequential: cada intervalo usa solo residuos de horizontes que ya terminaron antes de su origen. Los primeros orígenes sirven también para iniciar esta calibración; el conjunto de evaluación queda separado de la selección, no de las actualizaciones de calibración con pasado ya observado.
5. Ajuste final: la familia fijada se reentrena con toda la historia madura disponible.

La API distingue `selectionScores`, `selectionOrigins`, `scores` de evaluación y `evaluationOrigins`.

### 4.3 Métricas e intervalos

```text
MAE        = media |y − y_hat|
MASE       = media por origen [MAE / media_train |y_t − y_(t−7)|]
MAE rel.   = suma |error_modelo| / suma |error_baseline|, mismas fechas
WAPE total = suma_orígenes |suma_real − suma_pred| / suma_orígenes suma_real
Sesgo      = suma_orígenes (suma_pred − suma_real) / suma_orígenes suma_real
u          = (y − y_hat) / nivel_origen, nivel = media_28
Intervalo  = [y_hat + q_inf(u)·nivel, y_hat + q_sup(u)·nivel], truncado a 0
```

Residuos normales agrupados por semana de horizonte. Con m residuos se usa `p_sup=min(1;0,9·(m+1)/m)` y `p_inf=1−p_sup`, cuantiles interpolados. Es una corrección empírica inspirada en conformal, **sin garantía conformal exacta**: hay dependencia, orígenes solapados, selección, interpolación y no estacionariedad. Para la suma se calibran errores de sumas; no se suman cuantiles diarios. Los costos usan errores del log cociente de sumas.

### 4.4 Efectos de eventos

Para cada ocurrencia: `r=log((suma_real+0,5)/(suma_base+0,5))`, con base robusta del mismo día semanal en cuatro semanas previas. Su varianza combina dispersión normal y variación entre ocurrencias. Contracción normal por precisiones: categoría N(0;0,5²), desviación de evento sd=0,3 y de ocurrencia sd=0,15. Es una aproximación jerárquica, no una integración bayesiana exacta.

El multiplicador central es `exp(media_log)` y se informa su intervalo. En días de evento se amplía el intervalo con su incertidumbre. Para el total, los días del mismo evento comparten el efecto; distintos eventos se combinan en cuadratura. Sin ocurrencias hay a priori amplio, no evidencia específica. Se informa cobertura de días de evento y su tamaño muestral.

### 4.5 Publicación

- `insufficient_data`: incumple mínimos de historia, observaciones, volumen o calibración.
- `paused`: al menos siete días sin gasto hasta el corte.
- `not_published`: la familia elegida no supera al ingenuo en evaluación (MAE relativo≥1) o cobertura diaria fuera de [70 %,90 %].
- `published`: cumple las reglas. La cobertura del total se muestra pero no es una puerta independiente de publicación; puede diferir de la diaria.

Los costos requieren su propia calibración. Con pocos orígenes se permite [70 %,90 %] ampliado en `sqrt(0,8·0,2/n)`. Es tolerancia operativa, no un intervalo de confianza que corrija la dependencia temporal.

## 5. Escenarios de presupuesto

### 5.1 Regresión y ajuste bayesiano

Bloques completos de siete días hasta el corte, máximo 26 semanas, sin incidencias ni semanas de gasto cero, tras los cortes de atribución o pausa. El evento depende del objetivo de la campaña.

```text
log(mu_w) = a + b·x_w + q·x_w² + d·tau_w + c·o_w + suma_j eta_j·share_jw
x_w       = log(gasto propio semanal) − media(log gasto)
o_w       = log(max(gasto de pares, suelo)) − media(log gasto de pares)
share_jw  = fracción de días del evento de categoría j en la semana
Y_w       ~ cuasi-Poisson(mu_w, phi), phi ≥ 1
```

Pares: campañas de la cuenta con el mismo KPI. Tendencia usada para controlar evolución observada; no se extrapola como crecimiento futuro del escenario. Priors normales: b~N(0,7;0,25²), q sd=0,15, d sd=0,5, c sd=0,2 y eta sd=0,5; intercepto casi plano sd=10. `aprendido = 1−Var(b|datos)/0,25²` mide reducción de varianza marginal; no es identificación causal.

Modo por Newton con búsqueda de paso; covarianza por Hessiano inverso (Laplace). Dispersión Pearson con grados de libertad efectivos por regularización. La incertidumbre sigue siendo aproximada, especialmente con pocos eventos o colinealidad.

### 5.2 Validación y rango admisible

Un paso semanal: entrenar con semanas anteriores y predecir la siguiente dado su gasto **observado**, con 2.000 extracciones. Por tanto valida `eventos | gasto conocido`, no la capacidad de pronosticar el gasto ni el efecto de intervenir en él. PIT aleatorizado para conteos: `P(Y<y)+U·P(Y=y)`. Cobertura = proporción PIT entre 0,1 y 0,9. Se informa MAE frente al costo constante. Publicación exige al menos 10 semanas evaluadas y cobertura aceptable con tolerancia binomial.

Extremos: deja fuera las semanas de mayor y menor gasto y comprueba su cobertura. Es una prueba de estrés de forma, **no temporal**, porque puede usar semanas posteriores al bloque omitido. Nunca se presenta como validación prospectiva independiente. Solo amplía soporte hasta lo efectivamente probado. Si no supera extremos, restringe el plan al rango intercuartílico observado. Un plan distinto al actual fuera del rango validado se bloquea. Mantener el gasto actual conserva el escenario de referencia; cero gasto se simula como pausa. Cambios superiores a ±30 % se señalan por posible reinicio del aprendizaje.

### 5.3 Simulación Monte Carlo

Por extracción:

1. Muestrear parámetros normales multivariantes con Cholesky del Hessiano inverso.
2. Para cambios de gasto, usar elasticidad local observada `b+2q·x_actual` más un sesgo N(0;sigma_conf²), sigma_conf=0,2 por defecto. La correlación supuesta de este sesgo entre campañas es 0,5. Con experimentos concluyentes, sustituir por su estimación y error, sin combinarla ingenuamente con la asociación observacional.
3. Aplicar respuesta monótona propia (es una restricción del modelo, no una ley); el efecto de gasto de pares puede ser positivo o negativo.
4. Remuestrear choques log semanales por bloques conjuntos entre campañas. La persistencia estimada controla continuar el bloque. Si faltan fechas comunes, se usa el residual marginal de la campaña; la dependencia de campañas sin solapamiento no queda identificada.
5. Muestrear conteos Poisson por semana y sumar los del horizonte; una última semana parcial se escala proporcionalmente.

Se publican cuantiles de extracciones completas: los totales no suman P10 o P90 de campañas. La incertidumbre de nivel/tendencia usa además un factor de correlación empírico; no equivale a un posterior multivariante conjunto estimado. El PRNG mulberry32 y las semillas reproducen los resultados. Para lambda≥30, Poisson usa aproximación normal con redondeo; las colas son aproximadas.

`gasto = días × gasto_diario` es fijo por definición del plan; su incertidumbre de entrega no está modelada. El pronóstico sí ofrece un rango de gasto sin cambios. `costo = gasto/eventos`: P10 del costo corresponde a P90 de eventos y viceversa; con cero eventos se informa cota abierta y P(0). El cambio esperado comparte parámetros entre referencia y plan; su intervalo describe incertidumbre de la media, no la diferencia entre dos conteos futuros realizados.

## 6. Hipótesis y limitaciones

La asignación histórica del gasto es endógena: el anunciante y Meta gastan más donde esperan más demanda. Controlar tendencia, eventos y pares no elimina confusores omitidos. Un término de confusión ensancha intervalos bajo un supuesto; **no identifica causalidad**. E6 demuestra que sigma=0,2 puede seguir dando cobertura nula si el sesgo real es grande. No se interpreta su P50 como rendimiento incremental demostrado.

Los experimentos guardan periodos semanales y niveles aleatorizados por bloques, descartan días de transición y esperan conversiones maduras. Excluyen periodos con datos desconocidos, incidencias o días anteriores al último corte por atribución o pausa. Primera etapa OLS: log gasto real sobre log nivel asignado y tendencia; forma reducida Poisson para eventos; elasticidad aproximada `rho/pi`, error por método delta. F≥10 evita algunos instrumentos débiles pero no valida exclusión, ausencia de arrastre, interferencia, cumplimiento ni randomización ejecutada. La fórmula ignora covarianza entre etapas y no estima errores robustos por bloques: sus intervalos son exploratorios. El sistema no verifica que el presupuesto se aplicara como fue asignado y no ejecuta cambios publicitarios.

Los priors, saturación real, reinicios de aprendizaje, competencia, dependencia temporal, calendarios equivocados, falta de cobertura de ingesta y reexpresión histórica pueden invalidar los rangos. No hay garantía de extrapolación a otro canal, mercado u objetivo. No se afirma potencia estadística con pocas réplicas ni con horizontes solapados.

## 7. Integración y trazabilidad

- `POST /v1/forecasts`: entidad, horizonte, `asOf`, eventos y calendario opcional.
- `POST /v1/simulations`: cuenta, horizonte, calendario, semilla y gasto por campaña.
- `/v1/budget-experiments`: consulta, preview, creación y cancelación de diseños locales; escritura con permiso `experiments:manage`, auditoría y RLS. Migraciones 0009 y 0010 crean la tabla y sus políticas.
- No hay tablas de pronósticos o simulaciones: se calculan al pedirlos. La huella ayuda a comparar entradas, no sustituye un snapshot persistido del entrenamiento y de las revisiones del proveedor.
- La interfaz muestra abanico y tabla accesible, métricas y calibración, eventos, rangos por campaña, totales por tipo de evento, probabilidad de cero, gastos sin curva y cambios pendientes de simular. Expone supuestos y evidencia; no aplica cambios en Meta.

## 8. Experimentos

El [informe reproducible del 2026-10-26](FORECAST_EXPERIMENTS_2026-10-26.md) contiene las salidas completas E1–E8. Se genera con `pnpm forecast:experiments` (40 réplicas para series, 60 para Monte Carlo y los tamaños indicados en cada tabla; `REPS` y `REPS_MC` permiten variar esos dos tamaños). Semillas fijas, sin llamadas externas. E5 solo lee el CSV local si existe e informa suficiencia, sin valores de la cuenta.

| Experimento | Qué mide y límites |
|---|---|
| E1 | Series estables, tendencia, régimen, sin estacionalidad y bajo volumen; MAE/MASE posteriores a selección, cobertura prequential y horizonte oculto. Cobertura oculta condicionada a publicación |
| E2 | Mínimos por horizonte y cortes de historia |
| E3 | Recuperación de elasticidad con variación de gasto alta, baja y casi nula; dependencia del a priori |
| E4 | Forma potencia frente a saturación; cobertura de un paso/extremos y del escenario, incluyendo abstención fuera de soporte |
| E5 | Suficiencia de datos reales disponibles; no valida precisión real con 27 días |
| E6 | Confusión de demanda y gasto; fallo del intervalo observacional, incluso ensanchado, y comparación experimental |
| E7 | Cobertura del total con choques comunes frente a independencia impuesta |
| E8 | Calendario verdadero en datos sintéticos, frente a omitirlo; no valida un calendario real de clientes |

Los resultados del informe no se convierten en una promesa de error de producción. Con 40 réplicas, una cobertura de 80 % tiene error típico aproximado de 6 puntos; con 60, unos 5 puntos, incluso bajo independencia. No se retocan semillas ni umbrales para ocultar fallos. La calibración de escenarios a varios horizontes, el sesgo de selección por publicar y el rendimiento real requieren más evidencia.

Resultados destacados: en series estables E1 obtiene MAE relativo 0,78 para gasto y 0,76 para leads, con cobertura diaria 82 % y 83 %. Tras cambio de régimen el gasto cae a 66 % de cobertura y solo se publica en 18 % de las réplicas. E6 mantiene 0 % de cobertura causal con confusión fuerte incluso añadiendo sigma=0,2; E7 obtiene 65 % de cobertura de totales con campañas correlacionadas. Estos fallos delimitan el uso exploratorio del simulador; no se ocultan ni se consideran validación satisfactoria del 80 %.

## 9. Pruebas automatizadas

- `forecast.test.ts`: referencias conocidas, atribución, pausas, incidencias, calendario, priors, recuperación de efectos, mínimos, limpieza sin fuga temporal, separación selección/evaluación, comparación baseline, calibración y costos.
- `simulate.test.ts`: muestreo, ajuste bayesiano, variación insuficiente, curvatura y límites, validación, confusión, correlación, determinismo, diseño de experimentos, instrumento débil y análisis experimental sintético.
- `test/forecasting.test.ts`: API completa con Postgres, contrato, permisos, aislamiento, eventos, diseños auditados y bloqueo de extrapolación.
- Comprobaciones: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build:web`, `pnpm docs:check`.
- Revisión visual local con respuestas sintéticas producidas por la API real en el arnés de tests: escritorio 1440 px y móvil 390 px, escenario +20 %, bloqueo +300 %, sin errores de JavaScript ni desbordamiento horizontal. Intercepción solo en el navegador de prueba; no es una validación de login real.

## 10. Trabajo futuro

Registro diario de cobertura y valores desconocidos, snapshots del proveedor y de pronósticos emitidos, monitorización prospectiva de calibración, validación por horizonte de escenarios, efectos retardados y arrastre, experimentos con cumplimiento verificado y errores robustos, curvas jerárquicas entre campañas comparables, evaluación de ARIMA u otros candidatos si los simples fallan. Markov solo si aparecen trayectorias y una pregunta que requiera estados.

## Referencias

- Hyndman y Athanasopoulos, [validación temporal, errores y puntuación de intervalos](https://otexts.com/fpp3/toolbox.html), *Forecasting: Principles and Practice*, cap. 5.
- Hyndman y Athanasopoulos, [regresión, escenarios y límites causales](https://otexts.com/fpp3/regression.html), cap. 7.
- Hyndman y Athanasopoulos, [suavizado exponencial](https://otexts.com/fpp3/expsmooth.html), cap. 8.
- Hyndman y Koehler (2006), *Another look at measures of forecast accuracy*, International Journal of Forecasting 22(4).
- Lei et al. (2018), *Distribution-free predictive inference for regression*, JASA 113(523). Las garantías bajo intercambiabilidad no se trasladan automáticamente a estas series.
- Czado, Gneiting y Held (2009), *Predictive model assessment for count data*, Biometrics 65(4).
- Politis y Romano (1994), *The stationary bootstrap*, JASA 89(428).
