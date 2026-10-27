# Diseño del espacio de trabajo

Ad Astra usa una navegación lateral agrupada y un área de trabajo clara. La referencia es la organización de espacios de [Slack](https://slack.com/help/articles/360059928654-How-to-use-Slack--your-quick-start-guide/) y la separación entre navegación, encabezado y contenido de [Asana](https://help.asana.com/s/article/navigating-asana). La marca, los componentes y las ilustraciones son propios; no se incorporan sus logos ni sus interfaces.

## Sistema visual

| Elemento | Decisión |
| --- | --- |
| Tipografía | DM Sans variable, pesos 400–700, alojada en el mismo dominio con licencia OFL en `web/public/fonts/OFL.txt` |
| Navegación | Ciruela `#2c2330`; grupos «Tu espacio» y «Organización»; sección activa y organización visibles |
| Lienzo | Fondo cálido `#f7f6f3`, superficies blancas y bordes suaves |
| Acción principal | Coral `#bc4d3b`; estados de error, advertencia y éxito usan colores semánticos independientes |
| Analítica | Cuatro indicadores principales, indicadores secundarios compactos, tendencia y tabla de detalle |
| Contexto | Sincronización y madurez visibles; moneda, atribución y zona horaria en un desplegable |
| Entrada sin cuentas | Guía con enlaces a clientes, conexión y sincronización; sin indicadores ni resultados inventados |

Los tokens y reglas compartidas están en `web/src/index.css` y `web/src/workspace.css`. El shell está en `web/src/workspace.tsx`; la guía inicial en `web/src/onboarding.tsx`. Se mantienen React, React Router, TanStack Query y Tailwind. No se añade una biblioteca de componentes o animación.

## Interacción y adaptación

El buscador de vistas se abre con el botón superior o Ctrl/Cmd K. Filtra las rutas disponibles para el rol actual, permite recorrerlas con las flechas y abrirlas con Enter. El diálogo nativo gestiona el foco y Escape. Buscar no realiza operaciones sobre campañas.

Por debajo de 900 px la navegación se presenta como un panel lateral. El fondo queda inerte mientras está abierto, el foco permanece en el panel y Escape devuelve el foco al botón de apertura. Al abrir una vista, el foco pasa al contenido. En móviles pequeños los indicadores se distribuyen en dos columnas y las tablas conservan su desplazamiento horizontal interno.

La interfaz mantiene un lienzo claro con navegación oscura independientemente del tema del sistema. Respeta `prefers-reduced-motion`; las cargas muestran un esqueleto y los errores conservan su mensaje real y la semántica de alerta. Las rutas y controles siguen sujetos a los permisos del servidor.

## Integridad de los datos y verificación

El rediseño conserva los cálculos, periodos en la URL, comparaciones, exportaciones, ausencia de datos, madurez y advertencias existentes. Las minigráficas usan las series del informe, respetando los huecos de datos. La ilustración inicial es decorativa y no muestra cifras de rendimiento.

Se revisan capturas de escritorio y móvil y se ejecutan los flujos E2E de autenticación, permisos, monitoreo e informes. Las comprobaciones automáticas con axe cubren WCAG 2 A/AA y 2.1 AA en las vistas de entrada, analítica, inicio sin cuentas y navegación. Estas comprobaciones no sustituyen una auditoría manual completa con tecnologías de asistencia.

## Asistente y prioridades de revisión

El asistente abre con «Qué revisar primero», seguido del espacio para preparar consultas. La
lista reutiliza la prioridad del motor de auditoría, agrupa la misma regla por cuenta y muestra
un máximo de cinco temas con mayor prioridad del alcance autorizado. La agrupación se realiza
en el servidor antes de aplicar el límite; las repeticiones no desplazan otros temas. El contexto de cuenta filtra la selección; las otras vistas indican que
la selección corresponde a la cartera. Los permisos y el aislamiento se aplican antes del límite.

Cada tema muestra severidad, cuenta, siguiente paso, motivo, confianza, periodo y enlace a su
evidencia. Un hallazgo con más de una semana desde su última detección avisa que debe confirmarse
su vigencia. No se suman monedas ni se estiman ahorros. Las prioridades no se presentan como mejoras
causales. El recuento de señales describe la selección, no una cifra global oculta por el límite.

Cuando no hay hallazgos abiertos, la guía propone revisar medición, gasto y entrega, en ese orden,
identificándolos como sugerencias generales. Una carga fallida muestra su propio estado y permite
reintentar; no se presenta como ausencia de problemas. Estas lecturas no requieren una llamada LLM.

El historial está a la derecha en escritorio y después del contenido en móvil. Modelo, presupuesto
y estado técnico se consultan en un desplegable. «Preparar consulta» rellena y enfoca el borrador,
sin enviar datos. En modo de solo lectura se puede preparar texto y abrir evidencias; el botón
de envío y Ctrl/Cmd Enter respetan el bloqueo. Las pruebas de navegador comprueban agrupación,
enlaces, borradores, pausa, estados vacíos y errores, WCAG AA y ausencia de desbordamiento móvil.
