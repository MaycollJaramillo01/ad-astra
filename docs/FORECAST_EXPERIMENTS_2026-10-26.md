# Experimentos 2026-10-26 · criterios {"period":7,"minTrain":56,"step":7,"maxOrigins":30,"minCalibration":6,"minEvaluated":6,"pauseDays":7,"minDailyEvents":0.5,"level":0.8,"coverage":[0.7,0.9],"anomalyZ":5}

## E1. Pronóstico con el calendario incorporado (300 días, horizonte 28 + hueco 3, R = 40)

| Escenario | Serie | Publicado | Modelo más elegido | MAE rel. (mediana) | MASE (mediana) | Cobertura diaria (backtest) | Cobertura del total (backtest) | Cobertura del total en horizonte oculto |
|---|---|---|---|---|---|---|---|---|
| S1 Estable con estacionalidad semanal | Gasto | 100 % | weekday (27/40) | 0.78 | 0.79 | 82 % | 87 % | 80 % (n = 40) |
| S1 Estable con estacionalidad semanal | Leads | 98 % | weekday (23/40) | 0.76 | 0.74 | 83 % | 86 % | 87 % (n = 39) |
| S1 Estable con estacionalidad semanal | Costo por lead | 75 % | — | n/d | n/d | — | 79 % | 77 % (n = 30) |
| S2 Tendencia creciente | Gasto | 100 % | ets (23/40) | 0.80 | 1.07 | 84 % | 84 % | 85 % (n = 40) |
| S2 Tendencia creciente | Leads | 100 % | weekday (28/40) | 0.79 | 0.93 | 85 % | 83 % | 80 % (n = 40) |
| S2 Tendencia creciente | Costo por lead | 83 % | — | n/d | n/d | — | 80 % | 85 % (n = 33) |
| S3 Cambio de régimen (×2 el día 200) | Gasto | 18 % | weekday (28/40) | 0.95 | 1.90 | 66 % | 61 % | 86 % (n = 7) |
| S3 Cambio de régimen (×2 el día 200) | Leads | 78 % | ets (20/40) | 0.86 | 1.24 | 73 % | 60 % | 94 % (n = 31) |
| S3 Cambio de régimen (×2 el día 200) | Costo por lead | 13 % | — | n/d | n/d | — | 73 % | 100 % (n = 5) |
| S4 Sin estacionalidad | Gasto | 98 % | weekday (21/40) | 0.77 | 0.79 | 83 % | 90 % | 97 % (n = 39) |
| S4 Sin estacionalidad | Leads | 100 % | weekday (23/40) | 0.77 | 0.78 | 83 % | 84 % | 88 % (n = 40) |
| S4 Sin estacionalidad | Costo por lead | 78 % | — | n/d | n/d | — | 77 % | 84 % (n = 31) |
| S5 Volumen bajo (≈ 1 lead/día) | Gasto | 100 % | weekday (24/40) | 0.77 | 0.75 | 83 % | 89 % | 78 % (n = 40) |
| S5 Volumen bajo (≈ 1 lead/día) | Leads | 98 % | weekday (20/40) | 0.83 | 0.81 | 81 % | 78 % | 85 % (n = 39) |
| S5 Volumen bajo (≈ 1 lead/día) | Costo por lead | 80 % | — | n/d | n/d | — | 76 % | 75 % (n = 32) |

## E2. Criterios mínimos de datos (gasto, escenario S1, semilla 1)

Días exigidos: horizonte 7 → 157 · 14 → 171 · 28 → 199 · 56 → 255

| Días de historia | Estado | Motivo |
|---|---|---|
| 30 | insufficient_data | Hay 30 días utilizables desde 2026-09-21; este horizonte exige 199 (56 de entrenamiento y orígenes semanales suficientes para validar y calibrar). Faltan 169. |
| 90 | insufficient_data | Hay 90 días utilizables desde 2026-07-23; este horizonte exige 199 (56 de entrenamiento y orígenes semanales suficientes para validar y calibrar). Faltan 109. |
| 150 | insufficient_data | Hay 150 días utilizables desde 2026-05-24; este horizonte exige 199 (56 de entrenamiento y orígenes semanales suficientes para validar y calibrar). Faltan 49. |
| 198 | insufficient_data | Hay 198 días utilizables desde 2026-04-06; este horizonte exige 199 (56 de entrenamiento y orígenes semanales suficientes para validar y calibrar). Faltan 1. |
| 199 | published | — |
| 240 | published | — |
| 365 | published | — |

Cambio de atribución el día 250 → historia utilizable de 50 días (cortes: attribution). Pausa de 10 días → 190 días.

## E3. Curva de respuesta v2: recuperación de b (26 semanas, 200 réplicas; a priori N(0.7; 0.25²); curvatura N(0; 0.15²))

| b real | Variación del gasto (sd log) | Media a posteriori de b | Cobertura del intervalo creíble del 80 % | Aprendido de los datos (media) |
|---|---|---|---|---|
| 0.5 | 0.35 | 0.57 | 82 % | 72 % |
| 0.8 | 0.35 | 0.79 | 82 % | 86 % |
| 1 | 0.35 | 0.97 | 79 % | 87 % |
| 0.5 | 0.1 | 0.67 | 89 % | 19 % |
| 0.8 | 0.1 | 0.74 | 93 % | 36 % |
| 1 | 0.1 | 0.84 | 74 % | 40 % |
| 0.5 | 0.01 | 0.70 | 100 % | 0 % |
| 0.8 | 0.01 | 0.70 | 100 % | 1 % |
| 1 | 0.01 | 0.71 | 87 % | 1 % |

## E4. Validación y escenarios v2 (60 réplicas por celda)

| Respuesta real | Cobertura PIT de un paso (nominal 80 %) | MAE ÷ costo constante (mediana) | Cobertura PIT de extremos | Extremos calibrados |
|---|---|---|---|---|
| Potencia b = 0,8 (forma correcta) | 76 % | 0.95 | 81 % | 97 % |
| Saturación Michaelis-Menten (forma incorrecta) | 77 % | 0.71 | 80 % | 97 % |

| Respuesta real | Sesgo de confusión σ | Cambio del gasto diario | Publicado | Eventos reales de 4 semanas dentro de P10–P90 (publicados) |
|---|---|---|---|---|
| Potencia b = 0,8 (forma correcta) | 0.2 | -50 % | 90 % | 96 % |
| Potencia b = 0,8 (forma correcta) | 0.2 | +0 % | 100 % | 80 % |
| Potencia b = 0,8 (forma correcta) | 0.2 | +30 % | 100 % | 82 % |
| Potencia b = 0,8 (forma correcta) | 0.2 | +100 % | 85 % | 94 % |
| Potencia b = 0,8 (forma correcta) | 0.2 | +300 % | 17 % | 100 % |
| Potencia b = 0,8 (forma correcta) | 0 | -50 % | 90 % | 85 % |
| Potencia b = 0,8 (forma correcta) | 0 | +0 % | 100 % | 80 % |
| Potencia b = 0,8 (forma correcta) | 0 | +30 % | 100 % | 78 % |
| Potencia b = 0,8 (forma correcta) | 0 | +100 % | 85 % | 76 % |
| Potencia b = 0,8 (forma correcta) | 0 | +300 % | 17 % | 60 % |
| Saturación Michaelis-Menten (forma incorrecta) | 0.2 | -50 % | 90 % | 96 % |
| Saturación Michaelis-Menten (forma incorrecta) | 0.2 | +0 % | 100 % | 82 % |
| Saturación Michaelis-Menten (forma incorrecta) | 0.2 | +30 % | 100 % | 85 % |
| Saturación Michaelis-Menten (forma incorrecta) | 0.2 | +100 % | 85 % | 90 % |
| Saturación Michaelis-Menten (forma incorrecta) | 0.2 | +300 % | 17 % | 100 % |
| Saturación Michaelis-Menten (forma incorrecta) | 0 | -50 % | 90 % | 85 % |
| Saturación Michaelis-Menten (forma incorrecta) | 0 | +0 % | 100 % | 82 % |
| Saturación Michaelis-Menten (forma incorrecta) | 0 | +30 % | 100 % | 75 % |
| Saturación Michaelis-Menten (forma incorrecta) | 0 | +100 % | 85 % | 71 % |
| Saturación Michaelis-Menten (forma incorrecta) | 0 | +300 % | 17 % | 60 % |

## E5. Datos reales disponibles

27 filas diarias de 1 cuenta; historia utilizable 27 días (cortes: ninguno). Gasto: insufficient_data — Hay 27 días utilizables desde 2026-09-24; este horizonte exige 199 (56 de entrenamiento y orígenes semanales suficientes para validar y calibrar). Faltan 172.

## E6. Confusión y experimentos (elasticidad causal 0.6; 60 réplicas; 26 semanas observacionales y un experimento de 9 periodos, niveles 0,6 · 1 · 1,6)

| Estimación | Cobertura de la elasticidad causal con su intervalo del 80 % |
|---|---|
| Observacional sin término de confusión (media 1.15) | 0 % |
| Observacional + confusión N(0; 0.2²) | 0 % |
| Experimento aleatorizado (variable instrumental; concluyente en 60/60) | 75 % |
| Sustituir la elasticidad observacional por la experimental | 75 % |

## E7. Dependencia entre campañas (dos campañas con choques semanales comunes; 60 réplicas)

| Correlación de los choques | Cobertura del total (remuestreo conjunto por bloques) | Cobertura del total (campañas independientes, v1) |
|---|---|---|
| 0 | 82 % | 75 % |
| 0.5 | 65 % | 60 % |
| 0.9 | 65 % | 58 % |

## E8. Días de pago (+40 %) y fiestas patrias (−40 %) con y sin el calendario (R = 40; leads, horizonte oculto de 28 días)

| Calendario | Publicado | MAE rel. (mediana) | Cobertura en días de pago (horizonte oculto) | Cobertura del total (horizonte oculto) |
|---|---|---|---|---|
| Incorporado | 95 % | 0.73 | 90 % (n = 152) | 87 % (n = 38) |
| Sin calendario | 98 % | 0.75 | 54 % (n = 156) | 85 % (n = 39) |
