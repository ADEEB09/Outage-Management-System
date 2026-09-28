import { useEffect } from 'react';
import { Icon } from '../lib/ui.jsx';

// Full-screen "About" page opened from the GridQ mark in the rail. Plain
// fixed-position overlay (no router in this app) styled with the same
// design tokens as the rest of the shell — see index.css :root block.
export default function AboutOverlay({ onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="About GridQ"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        background: 'rgba(9,18,32,.55)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
      }}
    >
      <div style={{
        width: '100%', maxWidth: 620, maxHeight: '86vh', overflowY: 'auto',
        background: 'var(--surface)', borderRadius: 18, boxShadow: 'var(--shadow-lg)',
        border: '1px solid var(--line)',
      }}>
        <div style={{
          background: 'linear-gradient(120deg,#16b7a2 0%,#0b9f8f 28%,#174b68 68%,#102f4a 100%)',
          borderRadius: '18px 18px 0 0', padding: '22px 26px', display: 'flex',
          alignItems: 'center', gap: 14, position: 'relative',
        }}>
          <img src="/gridq-mark.png" alt="" style={{ width: 40, height: 40, borderRadius: 9 }} />
          <div>
            <div style={{ fontFamily: 'var(--disp)', color: '#fff', fontWeight: 700, fontSize: 19 }}>GridQ</div>
            <div style={{ color: 'rgba(255,255,255,.85)', fontSize: 12.5, letterSpacing: '.02em' }}>Predict. Prevent. Power.</div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              position: 'absolute', top: 16, right: 16, width: 30, height: 30, borderRadius: 8,
              border: '1px solid rgba(255,255,255,.35)', background: 'rgba(255,255,255,.12)',
              color: '#fff', display: 'grid', placeItems: 'center', cursor: 'pointer',
            }}
          >
            <Icon name="x" size={16} />
          </button>
        </div>

        <div style={{ padding: '22px 26px 26px', display: 'flex', flexDirection: 'column', gap: 20 }}>
          <Section title="Software">
            <Row k="Name" v="GridQ Action.NET ADMS — Outage Management System" />
            <Row k="Version" v="1.0.0" />
            <Row k="Build" v="2026.07.1.0" />
            <Row k="Date of Deployment" v="" />
            
          </Section>

          
          <Section title="License">
            <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-2)', lineHeight: 1.6 }}>
              Confidential &amp; Proprietary. This software and its documentation are provided
              for the exclusive use of Uttarakhand Power Corporation Limited under the RDSS
              scheme and may not be copied, distributed, or disclosed without written consent from Sharika SpinTech Pvt. Ltd.
            </p>
          </Section>

          <Section title="Company">
            <Row k="Software OEM" v="Sharika SpinTech Pvt. Ltd." />
            <Row k="Technology partner" v="Sharika Enterprises Limited" />
            
          </Section>

          <Section title="Client & scheme">
            <Row k="End client" v="Uttarakhand Power Corporation Ltd. (UPCL)" />
            <Row k="Scheme" v="Ganga Corridor(RDSS)" />
            <Row k="Nodal agency" v="Power Finance Corporation Ltd." />
            <Row k="Town" v="Dehradun, Haridwar, Rishikesh" />

          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div style={{
        fontFamily: 'var(--disp)', textTransform: 'uppercase', letterSpacing: '.12em',
        fontSize: 11, fontWeight: 600, color: 'var(--muted)', marginBottom: 9,
      }}>
        {title}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>{children}</div>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div style={{ display: 'flex', gap: 14, fontSize: 13 }}>
      <div style={{ width: 170, flex: 'none', color: 'var(--muted)' }}>{k}</div>
      <div style={{ color: 'var(--ink)', fontWeight: 500 }}>{v}</div>
    </div>
  );
}