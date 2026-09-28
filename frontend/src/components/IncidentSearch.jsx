import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { api } from '../lib/api.js';

// Reuses the exact .ms-box / .ms-results / .ms-item CSS already proven by
// NetworkMap's own place search (see index.css) — a plain, reliable
// position:absolute dropdown under a position:relative wrapper, rather
// than the third-party kokonutui command-palette component this replaced.
// That component was built as a full-screen modal search overlay (its own
// JS-calculated position:fixed coordinates kept landing in the wrong place
// once dropped into a small 260px header slot), not an inline header
// search box — fighting its internals wasn't worth it when this app
// already has a working pattern for exactly this UI.
const SEV_COLOR = { critical: '#c73a3a', high: '#c8811a', medium: '#2f6fd6', low: '#1f8a5b' };

export default function IncidentSearch({ onOpen }) {
  const [all, setAll] = useState([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => { api.incidents().then(setAll); }, []);

  // close on outside click
  useEffect(() => {
    const onDocClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const query = q.trim().toLowerCase();
  const results = (query
    ? all.filter((i) =>
        i.id.toLowerCase().includes(query) ||
        (i.zone || '').toLowerCase().includes(query) ||
        (i.feeder || '').toLowerCase().includes(query)
      )
    : all
  ).slice(0, 12);

  const select = (inc) => {
    setOpen(false);
    setQ('');
    if (onOpen) onOpen(inc);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <div className="ms-box">
        <Search size={15} />
        <input
          aria-label="Search incidents"
          placeholder="Search incidents…"
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        />
        {q && (
          <button className="ms-clear" aria-label="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={() => setQ('')}>
            <X size={14} />
          </button>
        )}
      </div>

      {open && (
        <div className="ms-results" style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0, zIndex: 900, marginTop: 0 }}>
          {!results.length && <div className="ms-empty">{query ? `No incidents match "${q}".` : 'No incidents to show.'}</div>}
          {results.map((i) => (
            <button
              key={i.id}
              className="ms-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => select(i)}
            >
              <span className="ms-tag" style={{ background: SEV_COLOR[i.severity] || '#94a3b8' }}>{i.severity}</span>
              <span className="ms-label">{i.zone} · {i.id}</span>
              <span className="ms-sub">{i.status.replace('_', ' ')}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}