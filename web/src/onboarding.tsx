import { Link } from 'react-router';
import type { Role } from '../../src/domain.ts';
import { BrandMark, Icon } from './icons.tsx';

export function PortfolioWelcome({ role }: { role: Role }) {
  const admin = ['owner', 'admin'].includes(role);
  const steps = [
    {
      to: '/clientes',
      title: 'Organiza tu cartera',
      text: 'Reúne las cuentas de cada cliente en su propio espacio.',
    },
    {
      to: admin ? '/conexiones' : '/cuentas',
      title: admin ? 'Conecta tus cuentas de Meta' : 'Revisa las cuentas de tu equipo',
      text: 'Con permisos y autorización de cada cliente.',
    },
    {
      to: '/cuentas',
      title: 'Empieza con datos reales',
      text: 'Activa la sincronización para consultar el histórico.',
    },
  ];
  return (
    <div className="space-y-6">
      <section className="welcome-panel" aria-labelledby="welcome-title">
        <div>
          <span className="page-eyebrow">UN BUEN PUNTO DE PARTIDA</span>
          <h2 id="welcome-title">
            Todas tus campañas.
            <br />
            Un espacio para verlas mejor.
          </h2>
          <p>
            {admin
              ? 'Conecta tu primera cuenta y convierte los datos de tu cartera en decisiones con contexto.'
              : 'Tu equipo todavía no ha añadido cuentas a esta vista. Aquí podrás consultar su rendimiento cuando estén disponibles.'}
          </p>
          <div className="view-actions">
            <Link to={admin ? '/conexiones' : '/cuentas'} className="button-primary">
              <Icon name={admin ? 'plus' : 'accounts'} size={15} />
              {admin ? 'Conectar Meta' : 'Ver cuentas'}
            </Link>
            <Link to="/clientes" className="button-secondary">
              Ver clientes
              <Icon name="arrow" size={14} />
            </Link>
          </div>
        </div>
        <div className="welcome-art" aria-hidden="true">
          <div className="orbit" />
          <div className="orbit-center">
            <BrandMark />
          </div>
          <span className="orbit-card">
            <Icon name="accounts" size={17} /> Tus campañas
          </span>
          <span className="orbit-card">
            <Icon name="action" size={17} /> Decisiones claras
          </span>
          <span className="orbit-card">
            <Icon name="trend" size={17} /> Una perspectiva común
          </span>
        </div>
      </section>
      <div className="getting-started">
        <section className="start-steps" aria-labelledby="start-title">
          <h2 id="start-title">Prepara tu espacio</h2>
          {steps.map((step, index) => (
            <Link className="start-step" to={step.to} key={step.title}>
              <span className="step-number">0{index + 1}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.text}</p>
              </div>
              <Icon name="arrow" size={17} />
            </Link>
          ))}
        </section>
        <aside className="workspace-tip">
          <Icon name="action" size={25} />
          <div>
            <h3>La decisión siempre es tuya.</h3>
            <p>
              Las recomendaciones se revisan y aprueban antes de convertirse en cambios sobre tus
              campañas.
            </p>
          </div>
          <Link to="/acciones">
            Conoce Action Center
            <Icon name="arrow" size={15} />
          </Link>
        </aside>
      </div>
      <div className="empty-capabilities">
        <span>
          <Icon name="lock" size={13} /> Datos separados por cliente
        </span>
        <span>
          <Icon name="check" size={13} /> Acciones con aprobación
        </span>
        <span>
          <Icon name="trend" size={13} /> Análisis con contexto
        </span>
      </div>
    </div>
  );
}
