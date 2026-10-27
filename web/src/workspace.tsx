import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import type { Me } from '../../src/contracts.ts';
import { authClient, setActiveTenant } from './api.ts';
import { BrandMark, Icon, type IconName } from './icons.tsx';

type Destination = { to: string; name: string; icon: IconName; group: string };
export function Shell({
  me,
  activeTenantId,
  children,
}: {
  me: Me;
  activeTenantId: string;
  children: ReactNode;
}) {
  const cache = useQueryClient(),
    location = useLocation(),
    navigate = useNavigate();
  const active = me.memberships.find((m) => m.tenantId === activeTenantId);
  const admin = !!active && ['owner', 'admin'].includes(active.role);
  const items: Destination[] = [
    { to: '/analitica', name: 'Analítica', icon: 'overview', group: 'Tu espacio' },
    { to: '/monitoreo', name: 'Monitoreo', icon: 'monitor', group: 'Tu espacio' },
    { to: '/acciones', name: 'Action Center', icon: 'action', group: 'Tu espacio' },
    { to: '/prevision', name: 'Previsión', icon: 'forecast', group: 'Tu espacio' },
    ...(active?.role !== 'viewer'
      ? [
          {
            to: '/asistente',
            name: 'Asistente IA',
            icon: 'assistant' as const,
            group: 'Tu espacio',
          },
        ]
      : []),
    { to: '/clientes', name: 'Clientes', icon: 'clients', group: 'Organización' },
    { to: '/cuentas', name: 'Cuentas', icon: 'accounts', group: 'Organización' },
    ...(admin
      ? [
          {
            to: '/conexiones',
            name: 'Conexiones Meta',
            icon: 'connect' as const,
            group: 'Organización',
          },
          {
            to: '/operaciones',
            name: 'Estado técnico',
            icon: 'settings' as const,
            group: 'Organización',
          },
        ]
      : []),
  ];
  const current = items.find((i) => location.pathname.startsWith(i.to))?.name ?? 'Mi cuenta';
  const dialog = useRef<HTMLDialogElement>(null),
    searchInput = useRef<HTMLInputElement>(null),
    menuButton = useRef<HTMLButtonElement>(null),
    sidebar = useRef<HTMLElement>(null),
    resultList = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState(''),
    [selected, setSelected] = useState(0),
    [menu, setMenu] = useState(false);
  const destinations = [
    ...items,
    { to: '/cuenta', name: 'Mi cuenta', icon: 'settings' as const, group: 'Personal' },
  ];
  const matches = destinations.filter((i) =>
    `${i.name} ${i.group}`.toLocaleLowerCase('es').includes(query.toLocaleLowerCase('es')),
  );
  const openSearch = () => {
    setMenu(false);
    setQuery('');
    setSelected(0);
    dialog.current?.showModal();
    searchInput.current?.focus();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setMenu(false);
        setQuery('');
        setSelected(0);
        dialog.current?.showModal();
        searchInput.current?.focus();
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  useEffect(() => {
    if (menu) {
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      const panel = sidebar.current;
      const focusPanel = () => {
        if (!panel?.contains(document.activeElement))
          panel?.querySelector<HTMLButtonElement>('.sidebar-close')?.focus({ preventScroll: true });
      };
      const focusFrame = requestAnimationFrame(focusPanel);
      // Al entrar desde visibility:hidden, el primer frame aún puede impedir el foco.
      // Con movimiento reducido el primer frame basta; si hay transición, se reintenta al finalizar.
      panel?.addEventListener('transitionend', focusPanel);
      const onKeyDown = (event: KeyboardEvent) => {
        if (dialog.current?.open) return;
        if (event.key === 'Escape') {
          setMenu(false);
          requestAnimationFrame(() => menuButton.current?.focus());
        } else if (event.key === 'Tab') {
          const controls = Array.from(
            sidebar.current?.querySelectorAll<HTMLElement>('a, button, select') ?? [],
          ).filter((element) => element.getClientRects().length > 0);
          const first = controls[0],
            last = controls.at(-1);
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      };
      const onResize = () => {
        if (window.innerWidth > 900) setMenu(false);
      };
      window.addEventListener('keydown', onKeyDown);
      window.addEventListener('resize', onResize);
      return () => {
        cancelAnimationFrame(focusFrame);
        panel?.removeEventListener('transitionend', focusPanel);
        document.body.style.overflow = previousOverflow;
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('resize', onResize);
      };
    }
  }, [menu]);
  const go = (to: string) => {
    navigate(to);
    dialog.current?.close();
    setMenu(false);
    requestAnimationFrame(() => document.getElementById('main-content')?.focus());
  };
  const closeNavigation = () => {
    if (!menu) return;
    setMenu(false);
    requestAnimationFrame(() => document.getElementById('main-content')?.focus());
  };
  const initials = me.user.email.slice(0, 2).toUpperCase();
  return (
    <div className="workspace">
      <a href="#main-content" className="skip-link" inert={menu || undefined}>
        Saltar al contenido
      </a>
      {menu && (
        <button
          type="button"
          aria-label="Cerrar navegación"
          className="sidebar-backdrop"
          onClick={() => {
            setMenu(false);
            requestAnimationFrame(() => menuButton.current?.focus());
          }}
        />
      )}
      <aside
        ref={sidebar}
        aria-label="Navegación del espacio"
        id="workspace-sidebar"
        className={`workspace-sidebar ${menu ? 'is-open' : ''}`}
      >
        <div className="sidebar-brand">
          <BrandMark />
          <span>
            ad astra<span className="brand-period">.</span>
          </span>
          <button
            type="button"
            className="sidebar-close"
            aria-label="Cerrar menú"
            onClick={() => {
              setMenu(false);
              requestAnimationFrame(() => menuButton.current?.focus());
            }}
          >
            <Icon name="close" />
          </button>
        </div>
        <div className="workspace-switch">
          <span className="workspace-symbol">{active?.tenantName.slice(0, 1).toUpperCase()}</span>
          <div>
            <span className="sidebar-caption">Organización</span>
            {me.memberships.length > 1 ? (
              <label>
                <span className="sr-only">Organización activa</span>
                <select
                  value={activeTenantId}
                  onChange={(event) => {
                    setActiveTenant(event.target.value);
                    cache.clear();
                    window.location.assign('/');
                  }}
                >
                  {me.memberships.map((m) => (
                    <option key={m.tenantId} value={m.tenantId}>
                      {m.tenantName}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <strong>{active?.tenantName}</strong>
            )}
          </div>
          <Icon name="down" size={15} />
        </div>
        <nav aria-label="Principal" className="sidebar-nav">
          {['Tu espacio', 'Organización'].map((group) => (
            <div className="nav-group" key={group}>
              <p>{group}</p>
              {items
                .filter((i) => i.group === group)
                .map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={closeNavigation}
                    className={({ isActive }) => `nav-item ${isActive ? 'is-active' : ''}`}
                  >
                    <Icon name={item.icon} size={19} />
                    <span>{item.name}</span>
                    {item.to === '/asistente' && (
                      <span className="nav-label" aria-hidden="true">
                        IA
                      </span>
                    )}
                  </NavLink>
                ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="sidebar-note-icon">
            <Icon name="lock" size={15} />
          </span>
          <div>
            <strong>Un espacio de confianza</strong>
            <p>Las acciones siempre pasan por tu aprobación.</p>
          </div>
        </div>
        <div className="sidebar-account">
          <NavLink
            to="/cuenta"
            aria-label="Mi cuenta"
            className="account-link"
            onClick={closeNavigation}
          >
            <span className="avatar">{initials}</span>
            <span>
              <strong>Mi cuenta</strong>
              <small>{me.user.email}</small>
            </span>
          </NavLink>
          <button
            type="button"
            className="signout-button"
            title="Salir"
            aria-label="Salir"
            onClick={async () => {
              await authClient.signOut();
              cache.clear();
              window.location.assign('/');
            }}
          >
            <Icon name="logout" size={18} />
          </button>
        </div>
      </aside>
      <div className="workspace-main" inert={menu || undefined}>
        <header className="workspace-topbar">
          <div className="workspace-location">
            <button
              ref={menuButton}
              type="button"
              className="mobile-menu icon-button"
              aria-label="Abrir menú"
              aria-controls="workspace-sidebar"
              aria-expanded={menu}
              onClick={() => setMenu((v) => !v)}
            >
              <Icon name="menu" />
            </button>
            <span className="workspace-location-root">Espacio de trabajo</span>
            <Icon name="chevron" size={13} />
            <span>{current}</span>
          </div>
          <button
            type="button"
            aria-label="Buscar una vista"
            className="workspace-search"
            onClick={openSearch}
          >
            <Icon name="search" size={17} />
            <span>Buscar una vista…</span>
            <kbd>Ctrl K</kbd>
          </button>
          <NavLink to="/cuenta" className="topbar-avatar" aria-label="Abrir mi cuenta">
            {initials}
          </NavLink>
        </header>
        <main id="main-content" tabIndex={-1} className="view-content">
          {children}
        </main>
        <footer className="workspace-footer">
          <span>Ad Astra · inteligencia de campañas</span>
          <span>Los datos orientan. Tú decides.</span>
        </footer>
      </div>
      <dialog ref={dialog} className="command-dialog" aria-labelledby="command-title">
        <div className="command-search">
          <Icon name="search" />
          <label id="command-title" className="sr-only" htmlFor="command-input">
            Buscar una vista
          </label>
          <input
            id="command-input"
            ref={searchInput}
            type="search"
            autoComplete="off"
            aria-controls="command-results"
            aria-describedby="command-instructions"
            placeholder="¿A dónde quieres ir?"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                resultList.current?.querySelector('button')?.focus();
              } else if (event.key === 'Enter' && matches[selected]) {
                event.preventDefault();
                go(matches[selected].to);
              }
            }}
          />
          <button
            type="button"
            aria-label="Cerrar búsqueda"
            onClick={() => dialog.current?.close()}
          >
            <kbd>Esc</kbd>
          </button>
        </div>
        <p className="command-caption" role="status">
          {matches.length} {matches.length === 1 ? 'vista disponible' : 'vistas disponibles'}
        </p>
        <ul id="command-results" ref={resultList} className="command-results">
          {matches.map((item, index) => (
            <li key={item.to}>
              <button
                type="button"
                className={index === selected ? 'selected' : ''}
                onFocus={() => setSelected(index)}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
                  event.preventDefault();
                  const next = index + (event.key === 'ArrowDown' ? 1 : -1);
                  if (next < 0) searchInput.current?.focus();
                  else resultList.current?.querySelectorAll('button')[next]?.focus();
                }}
                onMouseEnter={() => setSelected(index)}
                onClick={() => go(item.to)}
              >
                <Icon name={item.icon} />
                <span>
                  {item.name}
                  <small>{item.group}</small>
                </span>
                <Icon name="arrow" size={16} />
              </button>
            </li>
          ))}
        </ul>
        {matches.length === 0 && (
          <p className="command-empty">
            No encontramos esa vista. Prueba con “cuentas” o “monitoreo”.
          </p>
        )}
        <div id="command-instructions" className="command-footer">
          ↑ ↓ para elegir <span>↵ para abrir</span>
        </div>
      </dialog>
    </div>
  );
}
